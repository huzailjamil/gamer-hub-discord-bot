'use strict';
const { parseChannel } = require('./core');
class YouTube {
  constructor(store, config) { this.store = store; this.config = config; }
  async request(resource, params) {
    const search = resource === 'search';
    if (!this.store.reserveQuota(1, search, this.config.budget, this.config.searchBudget)) {
      const error = new Error('YouTube daily budget reached; waiting for the next Pacific-time day.');
      error.code = 'QUOTA_LOCAL'; throw error;
    }
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    // API key stays in headers, never in logs or persisted request URLs.
    const r = await fetch(url, { headers: { 'X-Goog-Api-Key': this.config.youtubeKey }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`YouTube ${resource} returned HTTP ${r.status}.`);
    return r.json();
  }
  async resolve(input) {
    const data = await this.request('channels', { part: 'snippet,contentDetails', ...parseChannel(input) });
    const channel = data.items?.[0];
    if (!channel?.contentDetails?.relatedPlaylists?.uploads) throw new Error('YouTube channel not found.');
    return channel;
  }
  async recent(channel) {
    const r = await this.request('playlistItems', { part: 'contentDetails', playlistId: channel.playlist, maxResults: 50 });
    return (r.items || []).map(v => v.contentDetails.videoId);
  }
  async live(channel) {
    const r = await this.request('search', { part: 'id', channelId: channel.youtube, eventType: 'live', type: 'video', maxResults: 50 });
    return (r.items || []).map(v => v.id.videoId);
  }
  async videos(ids) {
    const result = [];
    ids = [...new Set(ids)];
    for (let start = 0; start < ids.length; start += 50) {
      const r = await this.request('videos', { part: 'snippet,liveStreamingDetails,status', id: ids.slice(start, start + 50).join(',') });
      result.push(...r.items || []);
    }
    return result;
  }
}
module.exports = { YouTube };
