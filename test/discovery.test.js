'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hints, initialJson, discoverLive } = require('../src/discovery');
const { Store } = require('../src/store');
const { Worker } = require('../src/worker');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { EventEmitter } = require('node:events');
const { attachCommands } = require('../src/commands');
const cid = 'UC' + 'b'.repeat(22), id = 'b'.repeat(11);
const page = `https://www.youtube.com/channel/${cid}/live`;
const player = `<script>var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: { videoId: id, title: 'Text with } and " braces' } })};</script>`;
const video = { id, snippet: { title: 'Live', channelTitle: 'Creator', channelId: cid, publishedAt: new Date().toISOString(), liveBroadcastContent: 'live' }, status: { privacyStatus: 'public' }, liveStreamingDetails: { actualStartTime: new Date().toISOString() } };
function fixture(t) {
  const s = new Store(':memory:'); t.after(() => s.close());
  const c = s.add('creator', { id: cid, snippet: { title: 'Creator' }, contentDetails: { relatedPlaylists: { uploads: 'UU' + 'b'.repeat(22) } } });
  s.approve(c.id, 'admin', Date.now() - 10000);
  return { s, c: s.get('SELECT * FROM channels WHERE id=?', c.id) };
}
test('extracts player JSON safely with quoted braces', () => {
  assert.equal(initialJson(player, 'ytInitialPlayerResponse').videoDetails.videoId, id);
  assert.deepEqual(hints(player, page), [id]);
  assert.equal(initialJson('var ytInitialData = maliciousCode()', 'ytInitialData'), null);
});
test('extracts automatic live/upcoming candidates, ignoring ordinary videos', () => {
  const data = { contents: [
    { videoRenderer: { videoId: id, thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: 'LIVE' } }] } },
    { videoRenderer: { videoId: 'c'.repeat(11), upcomingEventData: { startTime: '9999999999' } } },
    { videoRenderer: { videoId: 'd'.repeat(11), thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { style: 'DEFAULT' } }] } }
  ] };
  assert.deepEqual(new Set(hints(`var ytInitialData = ${JSON.stringify(data)};`, page)), new Set([id, 'c'.repeat(11)]));
});
test('unrecognized pages report degradation, not a false no-live result', () => {
  assert.throws(() => hints('<html>blocked</html>', page), /unavailable/);
  assert.deepEqual(hints('var ytInitialData = {"contents":[]};', page), []);
});
test('public-page fetch follows only allowlisted YouTube redirects', async () => {
  let calls = 0;
  const ids = await discoverLive(cid, async url => {
    calls++;
    if (calls === 1) return new Response(null, { status: 302, headers: { location: `/watch?v=${id}` } });
    assert.equal(url.pathname, '/watch');
    return new Response(player, { headers: { 'content-type': 'text/html' } });
  });
  assert.deepEqual(ids, [id]); assert.equal(calls, 2);
  await assert.rejects(discoverLive(cid, async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secrets' } })), /outside allowed/);
});
test('blocks consent, challenges and oversized responses without bypass', async () => {
  await assert.rejects(discoverLive(cid, async () => new Response(null, { status: 302, headers: { location: 'https://consent.youtube.com/' } })), /consent/);
  await assert.rejects(discoverLive(cid, async () => new Response('blocked', { status: 429 })), /HTTP 429/);
  await assert.rejects(discoverLive(cid, async () => new Response('g-recaptcha', { headers: { 'content-type': 'text/html' } })), /challenge/);
  await assert.rejects(discoverLive(cid, async () => new Response('x'.repeat(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/html' } })), /size limit/);
});
test('automatic live discovery queues a verified stream without /youtube watch', async t => {
  const { s, c } = fixture(t);
  let sent = 0;
  const w = new Worker(s, { videos: async () => [video] }, { liveProbe: 120000, liveCheck: 60000 }, { notifications: { send: async p => { sent++; assert.match(p.content, /is live/); return { id: 'alert' }; } } }, () => true);
  w.liveDiscovery = async () => [id];
  await w.probe(c); await w.checkCandidates(); await w.deliver();
  assert.equal(sent, 1); assert.equal(s.get('SELECT probe_failures FROM channels').probe_failures, 0);
  assert.equal(s.get('SELECT state FROM events').state, 'sent');
});
test('public discovery failures back off persistently and recover', async t => {
  const { s, c } = fixture(t);
  const w = new Worker(s, {}, { liveProbe: 120000 }, {}, () => true);
  w.liveDiscovery = async () => { throw new Error('HTTP 429'); };
  await w.probe(c);
  let row = s.get('SELECT * FROM channels'); assert.equal(row.probe_failures, 1); assert(row.next_probe > Date.now() + 200000);
  w.liveDiscovery = async () => [];
  await w.probe(row); row = s.get('SELECT * FROM channels'); assert.equal(row.probe_failures, 0); assert(row.probe_success > 0);
});
test('discovery hints cannot announce unrelated channels', async t => {
  const { s, c } = fixture(t);
  const w = new Worker(s, { videos: async () => [{ ...video, snippet: { ...video.snippet, channelId: 'unrelated' } }] }, { liveProbe: 120000, liveCheck: 60000 }, {}, () => true);
  w.liveDiscovery = async () => [id]; await w.probe(c); await w.checkCandidates();
  assert.equal(s.get('SELECT count(*) n FROM events').n, 0); assert.equal(s.get('SELECT count(*) n FROM candidates').n, 0);
});
test('upgrade migrates old database quota and preserves channel approval', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gamer-migrate-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'bot.sqlite'), old = new DatabaseSync(path);
  old.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY,member TEXT UNIQUE,youtube TEXT UNIQUE,title TEXT,playlist TEXT,state TEXT,since INTEGER,created INTEGER,approval_message TEXT,last_poll INTEGER DEFAULT 0,last_search INTEGER DEFAULT 0,lease_until INTEGER DEFAULT 0,renew_after INTEGER DEFAULT 0);
    CREATE TABLE quota (day TEXT PRIMARY KEY,used INTEGER DEFAULT 0,search_used INTEGER DEFAULT 0);
    INSERT INTO quota VALUES('2026-10-09',350,300);
    INSERT INTO channels(id,member,youtube,title,playlist,state,since,created) VALUES('old','member','${cid}','Creator','UUtest','approved',123,123);`);
  old.close();
  let upgraded = new Store(path);
  assert.equal(upgraded.get('SELECT state FROM channels').state, 'approved');
  assert.equal(upgraded.get('SELECT search_calls FROM quota').search_calls, 3);
  assert.equal(upgraded.get('SELECT used FROM quota').used, 50);
  assert.equal(upgraded.get('SELECT next_probe FROM channels').next_probe, 0);
  upgraded.close(); upgraded = new Store(path);
  assert.equal(upgraded.get('SELECT used FROM quota').used, 50); upgraded.close();
});
test('invalid channel input does not set a submission cooldown or call YouTube', async t => {
  const s = new Store(':memory:'); t.after(() => s.close()); const client = new EventEmitter(); let reply;
  attachCommands(client, s, { resolve: async () => assert.fail('must not request invalid channel') }, { guild: 'guild', maxChannels: 25 }, {}, () => '');
  const i = { user: { id: 'member' }, guildId: 'guild', commandName: 'youtube', isChatInputCommand: () => true, isButton: () => false,
    options: { getSubcommand: () => 'add', getString: () => '<@&123456789>' }, deferred: true,
    deferReply: async () => {}, editReply: async p => { reply = p.content; } };
  await client.listeners('interactionCreate')[0](i);
  assert.match(reply, /Use a YouTube/); assert.equal(s.get('SELECT count(*) n FROM cooldown').n, 0);
});
