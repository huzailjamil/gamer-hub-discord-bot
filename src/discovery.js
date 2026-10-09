'use strict';
const { CHANNEL, VIDEO } = require('./core');

// Read public page data only. Never evaluate scripts, use cookies, or bypass access challenges.
function initialJson(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:var\\s+${escaped}|window\\["${escaped}"\\]|${escaped})\\s*=\\s*`).exec(html);
  if (!match) return null;
  const start = match.index + match[0].length;
  if (html[start] !== '{') return null;
  let depth = 0, quoted = false, escape = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (quoted) { if (escape) escape = false; else if (ch === '\\') escape = true; else if (ch === '"') quoted = false; }
    else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}
function hints(html, pageUrl) {
  const ids = new Set();
  const add = id => { if (VIDEO.test(id || '') && ids.size < 20) ids.add(id); };
  const url = new URL(pageUrl);
  if (url.pathname === '/watch') add(url.searchParams.get('v'));
  const player = initialJson(html, 'ytInitialPlayerResponse');
  // Player details are hints only: API verification later rejects unrelated/private/ended videos.
  add(player?.videoDetails?.videoId);
  const data = initialJson(html, 'ytInitialData');
  if (!player && !data) throw new Error('Public YouTube page data unavailable; using API fallback.');
  const stack = data ? [data] : [];
  let visited = 0;
  while (stack.length && visited++ < 50000) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (item.videoRenderer) {
      const v = item.videoRenderer;
      const styles = (v.thumbnailOverlays || []).map(o => o.thumbnailOverlayTimeStatusRenderer?.style);
      const live = (v.badges || []).some(b => b.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW');
      if (live || styles.includes('LIVE') || styles.includes('UPCOMING') || v.upcomingEventData) add(v.videoId);
    }
    // Newer layouts use lockupViewModel and badge style strings.
    if (item.lockupViewModel) {
      const v = item.lockupViewModel, text = JSON.stringify(v);
      if (/"(?:BADGE_STYLE_TYPE_LIVE_NOW|LIVE|UPCOMING)"/.test(text)) add(v.contentId);
    }
    for (const value of Object.values(item)) if (value && typeof value === 'object') stack.push(value);
  }
  return [...ids];
}
function allowedPage(url) {
  return url.protocol === 'https:' && ['youtube.com', 'www.youtube.com'].includes(url.hostname)
    && !url.username && !url.password && !url.port
    && (url.pathname === '/watch' || /^\/channel\/UC[\w-]{22}\/(?:live|streams)\/?$/.test(url.pathname));
}
async function discoverLive(channelId, fetcher = fetch) {
  if (!CHANNEL.test(channelId)) throw new Error('Invalid channel ID.');
  let url = new URL(`https://www.youtube.com/channel/${channelId}/live`);
  const signal = AbortSignal.timeout(12000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const r = await fetcher(url, { redirect: 'manual', signal, headers: { Accept: 'text/html', 'Accept-Language': 'en', 'User-Agent': 'GamerHubNotifications/1.1 (+https://github.com/huzailjamil/gamer-hub-discord-bot)' } });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const location = r.headers.get('location');
      await r.body?.cancel();
      if (!location) throw new Error('YouTube redirect missing location.');
      const next = new URL(location, url);
      if (!allowedPage(next)) throw new Error('Public YouTube page requires consent or redirected outside allowed paths.');
      url = next; continue;
    }
    if (!r.ok) { await r.body?.cancel(); throw new Error(`Public YouTube page returned HTTP ${r.status}; backing off.`); }
    if (!r.headers.get('content-type')?.includes('text/html')) { await r.body?.cancel(); throw new Error('Unexpected public YouTube response.'); }
    const chunks = []; let length = 0;
    for await (const chunk of r.body) {
      length += chunk.length;
      if (length > 4 * 1024 * 1024) throw new Error('Public YouTube page exceeded size limit.');
      chunks.push(chunk);
    }
    const html = Buffer.concat(chunks).toString('utf8');
    if (/Our systems have detected unusual traffic|g-recaptcha|consent\.youtube\.com\/save/i.test(html)) throw new Error('Public YouTube access challenge; backing off.');
    return hints(html, url.href);
  }
  throw new Error('Too many YouTube redirects.');
}
module.exports = { initialJson, hints, allowedPage, discoverLive };
