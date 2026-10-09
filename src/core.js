'use strict';
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO = /^[A-Za-z0-9_-]{11}$/;

function parseChannel(input) {
  input = input.trim();
  if (CHANNEL.test(input)) return { id: input };
  if (/^@[^\s/?#]{1,100}$/u.test(input)) return { forHandle: input };
  let url;
  try { url = new URL(input); } catch { throw new Error('Use a YouTube @handle or full channel URL.'); }
  if (url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) || url.username || url.password || url.port)
    throw new Error('Use an https://www.youtube.com channel URL.');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0]?.startsWith('@') && /^@[^\s/?#]{1,100}$/u.test(parts[0])) return { forHandle: parts[0] };
  if (parts[0] === 'channel' && CHANNEL.test(parts[1])) return { id: parts[1] };
  if (parts[0] === 'user' && /^[\w.-]{1,100}$/.test(parts[1])) return { forUsername: parts[1] };
  throw new Error('Use the channel’s @handle or /channel/UC… URL; legacy /c/ links are not supported.');
}
function parseVideo(input) {
  if (VIDEO.test(input)) return input;
  let u;
  try { u = new URL(input); } catch { throw new Error('Use a YouTube video URL.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) throw new Error('Invalid YouTube URL.');
  const p = u.pathname.split('/').filter(Boolean);
  const id = u.hostname === 'youtu.be' ? p[0] : ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(u.hostname)
    ? (p[0] === 'watch' ? u.searchParams.get('v') : ['live', 'shorts'].includes(p[0]) ? p[1] : '') : '';
  if (!VIDEO.test(id || '')) throw new Error('Use a valid YouTube video URL.');
  return id;
}
function eventKind(video, since) {
  if (video.status?.privacyStatus !== 'public') return null;
  const live = video.liveStreamingDetails;
  if (live?.actualEndTime) return null; // Do not announce ended streams as fresh uploads.
  if (live?.actualStartTime && video.snippet?.liveBroadcastContent === 'live')
    return Date.parse(live.actualStartTime) >= since ? 'live' : null;
  if (live || video.snippet?.liveBroadcastContent !== 'none') return null;
  return Date.parse(video.snippet?.publishedAt) >= since ? 'upload' : null;
}
function isAdmin(bits) { return (BigInt(bits ?? 0) & 8n) === 8n; }
function nonce(key) { return createHash('sha256').update(key).digest('hex').slice(0, 24); }
function secureEqual(a, b) {
  const aa = Buffer.from(a || ''), bb = Buffer.from(b || '');
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function validSignature(body, header, secret) {
  if (!secret || !/^sha1=[a-f0-9]{40}$/.test(header || '')) return false;
  return secureEqual(header, `sha1=${createHmac('sha1', secret).update(body).digest('hex')}`);
}
function pacificDay(now = new Date()) { return now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); }
module.exports = { CHANNEL, VIDEO, parseChannel, parseVideo, eventKind, isAdmin, nonce, secureEqual, validSignature, pacificDay };
