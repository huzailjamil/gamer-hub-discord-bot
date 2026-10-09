'use strict';
const http = require('node:http');
const { createHmac } = require('node:crypto');
const { XMLParser } = require('fast-xml-parser');
const { CHANNEL, VIDEO, secureEqual, validSignature } = require('./core');
const parser = new XMLParser({ processEntities: false, ignoreAttributes: true });
const topic = id => `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${id}`;
const channelSecret = (config, id) => createHmac('sha256', config.secret).update(id).digest('hex');

async function subscribe(store, config, channel) {
  // Backoff is persisted before the HTTP call, including failed renewal attempts.
  store.run('UPDATE channels SET renew_after=? WHERE id=?', Date.now() + 3600000, channel.id);
  const callback = `${config.publicUrl}/youtube/webhook?channel=${channel.youtube}`;
  const body = new URLSearchParams({
    'hub.mode': 'subscribe', 'hub.topic': topic(channel.youtube), 'hub.callback': callback,
    'hub.verify': 'async', 'hub.verify_token': channelSecret(config, channel.youtube),
    'hub.secret': channelSecret(config, channel.youtube), 'hub.lease_seconds': '864000'
  });
  const r = await fetch('https://pubsubhubbub.appspot.com/subscribe', { method: 'POST', body, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`YouTube subscription returned HTTP ${r.status}.`);
}
function webServer(store, config, healthy) {
  const base = new URL(config.publicUrl).pathname.replace(/\/$/, '');
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const reply = (status, message = '') => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(message); };
    try {
      const url = new URL(req.url, 'http://localhost');
      // Some Passenger configurations strip the mount path; support either form.
      const path = base && url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length) : url.pathname;
      if (req.method === 'GET' && (path === '/health' || path === '/' || url.pathname === base)) return reply(healthy() ? 200 : 503, healthy() ? 'ok' : 'starting');
      if (path !== '/youtube/webhook') return reply(404);
      const cid = url.searchParams.get('channel');
      if (!CHANNEL.test(cid || '')) return reply(400);
      const ch = store.get("SELECT * FROM channels WHERE youtube=? AND state='approved'", cid);
      if (!ch) return reply(404);
      const secret = channelSecret(config, cid);
      if (req.method === 'GET') {
        if (url.searchParams.get('hub.mode') !== 'subscribe' || url.searchParams.get('hub.topic') !== topic(cid) || !secureEqual(url.searchParams.get('hub.verify_token'), secret)) return reply(403);
        const challenge = url.searchParams.get('hub.challenge');
        const lease = Number(url.searchParams.get('hub.lease_seconds'));
        if (!challenge || challenge.length > 1000 || !Number.isInteger(lease) || lease < 60 || lease > 2592000) return reply(400);
        store.run('UPDATE channels SET lease_until=?, renew_after=? WHERE id=?', Date.now() + lease * 1000, Date.now() + lease * 700, ch.id);
        store.audit('websub_verified', null, ch.id);
        return reply(200, challenge);
      }
      if (req.method !== 'POST') return reply(405);
      if (Number(req.headers['content-length'] || 0) > 262144) return reply(413);
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 262144) { reply(413); req.destroy(); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (!validSignature(body, req.headers['x-hub-signature'], secret)) return reply(403);
      const xml = body.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return reply(400);
      let data;
      try { data = parser.parse(xml); } catch { return reply(400); }
      const entries = data.feed?.entry;
      for (const entry of (Array.isArray(entries) ? entries : entries ? [entries] : []).slice(0, 100)) {
        const video = entry['yt:videoId'];
        if (entry['yt:channelId'] !== cid || !VIDEO.test(video || '')) continue;
        // Persist hints before acknowledging; worker verifies all details with YouTube.
        store.run('INSERT INTO candidates(video,channel,expires) VALUES(?,?,?) ON CONFLICT(video) DO UPDATE SET expires=excluded.expires', video, ch.id, Date.now() + 30 * 86400000);
      }
      return reply(204);
    } catch {
      store.audit('webhook_error');
      if (!res.headersSent) reply(500); else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(/^\d+$/.test(config.port) ? Number(config.port) : config.port);
  return server;
}
module.exports = { webServer, subscribe, topic, channelSecret };
