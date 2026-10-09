'use strict';
const { eventKind, nonce } = require('./core');
const { subscribe } = require('./web');
const { sendApproval } = require('./commands');

class Worker {
  constructor(store, youtube, config, channels, ready) {
    Object.assign(this, { store, youtube, config, channels, ready });
    this.busy = false; this.lastSuccess = 0; this.lastCandidates = 0;
  }
  ingest(channel, videos) {
    // Reload state after network I/O: admins may have paused/removed the channel.
    channel = this.store.get("SELECT * FROM channels WHERE id=? AND state='approved'", channel.id);
    if (!channel) return;
    for (const video of videos) {
      if (video.snippet?.channelId !== channel.youtube) continue;
      const live = video.liveStreamingDetails;
      if (live && !live.actualEndTime && video.status?.privacyStatus === 'public') {
        this.store.run('INSERT INTO candidates(video,channel,expires) VALUES(?,?,?) ON CONFLICT(video) DO UPDATE SET expires=excluded.expires', video.id, channel.id, Date.now() + 30 * 86400000);
      } else this.store.run('DELETE FROM candidates WHERE video=?', video.id);
      const kind = eventKind(video, channel.since);
      if (kind) this.store.queue(channel, video, kind);
    }
  }
  async discover(channel, search) {
    const field = search ? 'last_search' : 'last_poll';
    this.store.run(`UPDATE channels SET ${field}=? WHERE id=?`, Date.now(), channel.id);
    try {
      const ids = await (search ? this.youtube.live(channel) : this.youtube.recent(channel));
      // Keep discovery durable if the detail request fails or budget is exhausted.
      if (!this.store.get("SELECT id FROM channels WHERE id=? AND state='approved'", channel.id)) return;
      for (const id of ids) this.store.run('INSERT OR IGNORE INTO candidates(video,channel,expires) VALUES(?,?,?)', id, channel.id, Date.now() + 30 * 86400000);
      this.ingest(channel, await this.youtube.videos(ids));
    } catch (e) { this.store.audit(search ? 'live_discovery_failed' : 'upload_check_failed', null, channel.id, e.message); }
  }
  async deliver() {
    const rows = this.store.all("SELECT e.*, c.member, c.youtube, c.since FROM events e JOIN channels c ON c.id=e.channel WHERE c.state='approved' AND e.state IN ('pending','sending') AND e.next_try<=? ORDER BY e.created LIMIT 20", Date.now());
    for (const event of rows) {
      if (!this.ready()) return;
      try {
        const fresh = (await this.youtube.videos([event.video]))[0];
        // Never send a retry for a livestream that has already ended or a private/deleted video.
        const current = this.store.get("SELECT * FROM channels WHERE id=? AND state='approved'", event.channel);
        if (!current || !fresh || fresh.snippet?.channelId !== current.youtube || eventKind(fresh, current.since) !== event.kind) {
          this.store.run("UPDATE events SET state='cancelled' WHERE key=?", event.key); continue;
        }
        const marker = `Alert ${nonce(event.key)}`;
        if (event.attempts > 0 || event.state === 'sending') {
          // Covers the send-success/process-crash window in addition to Discord nonce deduplication.
          const history = await this.channels.notifications.messages.fetch({ limit: 100 });
          const existing = history.find(m => m.author.id === this.channels.notifications.client.user.id && m.embeds.some(e => e.footer?.text === marker));
          if (existing) {
            this.store.run("UPDATE events SET state='sent', message=? WHERE key=?", existing.id, event.key); continue;
          }
        }
        if (!this.ready() || !this.store.get("SELECT id FROM channels WHERE id=? AND state='approved'", event.channel)) continue;
        this.store.run("UPDATE events SET state='sending', attempts=attempts+1 WHERE key=?", event.key);
        const isLive = event.kind === 'live';
        const embed = {
          title: fresh.snippet.title.slice(0, 256), url: `https://www.youtube.com/watch?v=${event.video}`,
          color: isLive ? 0xed4245 : 0x5865f2,
          author: { name: fresh.snippet.channelTitle.slice(0, 256), url: `https://www.youtube.com/channel/${current.youtube}` },
          image: { url: `https://i.ytimg.com/vi/${event.video}/hqdefault.jpg` }, footer: { text: marker }
        };
        const message = await this.channels.notifications.send({
          content: `${isLive ? '🔴' : '🎬'} <@${event.member}> ${isLive ? 'is live—come join!' : 'uploaded a new video!'}\nhttps://www.youtube.com/watch?v=${event.video}`,
          embeds: [embed], allowedMentions: { parse: [], users: [event.member] }, nonce: nonce(event.key), enforceNonce: true
        });
        this.store.transaction(() => {
          this.store.run("UPDATE events SET state='sent', message=? WHERE key=?", message.id, event.key);
          this.store.audit('notification_sent', null, event.channel, `${event.kind}:${event.video}`);
        });
      } catch (e) {
        if (e.code === 'QUOTA_LOCAL') {
          this.store.run('UPDATE events SET next_try=? WHERE key=?', Date.now() + 3600000, event.key);
          continue; // Budget exhaustion must not consume delivery attempts.
        }
        const attempts = event.attempts + 1;
        this.store.run('UPDATE events SET state=?,attempts=?,next_try=? WHERE key=?', attempts >= 12 ? 'failed' : 'pending', attempts, Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7)), event.key);
        this.store.audit('notification_failed', null, event.channel, `${event.video}:${String(e.code || e.name || 'Error')}`);
      }
    }
  }
  async tick() {
    if (this.busy || !this.ready()) return;
    this.busy = true;
    try {
      if (!this.lastCleanup || Date.now() - this.lastCleanup > 86400000) {
        this.lastCleanup = Date.now();
        this.store.run('DELETE FROM audit WHERE at<?', Date.now() - 90 * 86400000);
        this.store.run('DELETE FROM cooldown WHERE until<?', Date.now());
        this.store.run('DELETE FROM locks WHERE until<?', Date.now());
        this.store.run("UPDATE events SET payload='{}' WHERE created<?", Date.now() - 30 * 86400000);
      }
      const active = this.store.all("SELECT * FROM channels WHERE state='approved' ORDER BY last_poll");
      // Search costs 100 units/request. Spread searches across a full day and across all channels.
      const searchInterval = this.config.searchBudget > 0 ? Math.max(600000, active.length * 100 * 86400000 / this.config.searchBudget) : Infinity;
      const pollInterval = Math.max(this.config.poll, active.length * 2 * 86400000 / Math.max(100, this.config.budget - this.config.searchBudget - 2000));
      for (const channel of active) {
        if (!this.ready()) return;
        if (channel.renew_after <= Date.now()) {
          try { await subscribe(this.store, this.config, channel); }
          catch (e) { this.store.audit('subscription_failed', null, channel.id, e.message); }
        }
        if (Date.now() - channel.last_poll >= pollInterval) await this.discover(channel, false);
        if (Date.now() - channel.last_search >= searchInterval) await this.discover(channel, true);
      }
      if (Date.now() - this.lastCandidates >= this.config.liveCheck) {
        this.lastCandidates = Date.now();
        this.store.run('DELETE FROM candidates WHERE expires<?', Date.now());
        const candidates = this.store.all("SELECT v.* FROM candidates v JOIN channels c ON c.id=v.channel WHERE c.state='approved'");
        if (candidates.length) {
          try {
            const videos = await this.youtube.videos(candidates.map(v => v.video));
            for (const channel of active) this.ingest(channel, videos);
            // Deleted/private/unavailable candidates expire after 30 days rather than disappearing on a transient empty response.
          } catch (e) { this.store.audit('tracked_video_check_failed', null, null, e.message); }
        }
      }
      await this.deliver();
      // A failed approval message does not lose the submission. Retry once per minute.
      if (!this.lastApprovals || Date.now() - this.lastApprovals > 60000) {
        this.lastApprovals = Date.now();
        for (const row of this.store.all("SELECT * FROM channels WHERE state='pending' AND approval_message IS NULL LIMIT 5")) {
          try { await sendApproval(this.store, this.channels.approvals, row); }
          catch { this.store.audit('approval_delivery_failed', null, row.id); }
        }
      }
      this.lastSuccess = Date.now();
    } catch (e) { this.store.audit('worker_failed', null, null, String(e.code || e.name || 'Error')); }
    finally { this.busy = false; }
  }
}
module.exports = { Worker };
