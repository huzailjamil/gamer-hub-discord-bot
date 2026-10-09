'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { once } = require('node:events');
const { Store } = require('../src/store');
const { parseChannel, parseVideo, eventKind, isAdmin, nonce, validSignature } = require('../src/core');
const { Worker } = require('../src/worker');
const { webServer, channelSecret, topic } = require('../src/web');
const { attachCommands } = require('../src/commands');
const { EventEmitter } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const cid = 'UC' + 'a'.repeat(22), vid = 'a'.repeat(11);
const since = Date.parse('2026-10-09T00:00:00Z');
function channel(s) { const c = s.add('member1', { id: cid, snippet: { title: 'Test Channel' }, contentDetails: { relatedPlaylists: { uploads: 'UU' + 'a'.repeat(22) } } }); s.approve(c.id, 'admin', since); return s.get('SELECT * FROM channels WHERE id=?', c.id); }
function upload() { return { id: vid, snippet: { title: '@everyone video', channelTitle: 'Creator', channelId: cid, publishedAt: '2026-10-09T01:00:00Z', liveBroadcastContent: 'none' }, status: { privacyStatus: 'public' } }; }
function live() { return { ...upload(), snippet: { ...upload().snippet, liveBroadcastContent: 'live' }, liveStreamingDetails: { actualStartTime: '2026-10-09T01:00:00Z' } }; }
function fixture(t) { const s = new Store(':memory:'); t.after(() => s.close()); return s; }
test('resolves handles and canonical channel IDs without arbitrary network targets', () => {
  assert.deepEqual(parseChannel('@GamerHub'), { forHandle: '@GamerHub' });
  assert.deepEqual(parseChannel(`https://www.youtube.com/channel/${cid}`), { id: cid });
  assert.deepEqual(parseChannel('https://youtube.com/@GamerHub/streams?x=1'), { forHandle: '@GamerHub' });
  for (const input of ['http://youtube.com/@foo', 'https://youtube.com.evil.test/@foo', 'https://localhost/@foo', 'https://evil@youtube.com/@foo', 'https://youtube.com/c/old']) assert.throws(() => parseChannel(input));
});
test('video URL input is constrained to YouTube', () => {
  assert.equal(parseVideo(`https://youtu.be/${vid}`), vid);
  assert.equal(parseVideo(`https://www.youtube.com/live/${vid}`), vid);
  assert.throws(() => parseVideo(`https://evil.test/watch?v=${vid}`));
});
test('old uploads and already-running streams do not backfill', () => {
  assert.equal(eventKind(upload(), since), 'upload');
  assert.equal(eventKind(upload(), since + 86400000), null);
  assert.equal(eventKind(live(), since), 'live');
  assert.equal(eventKind(live(), since + 86400000), null);
});
test('scheduled, ended, private and unavailable videos never create inappropriate alerts', () => {
  assert.equal(eventKind({ ...live(), liveStreamingDetails: { scheduledStartTime: '2026-10-10T00:00:00Z' }, snippet: { ...upload().snippet, liveBroadcastContent: 'upcoming' } }, since), null);
  assert.equal(eventKind({ ...live(), liveStreamingDetails: { ...live().liveStreamingDetails, actualEndTime: '2026-10-09T02:00:00Z' } }, since), null);
  assert.equal(eventKind({ ...upload(), status: { privacyStatus: 'private' } }, since), null);
});
test('admin flag required; manage-server alone is insufficient', () => {
  assert.equal(isAdmin(8n), true); assert.equal(isAdmin(32n), false); assert.equal(isAdmin(0n), false);
});
test('signed push rejects altered and unsigned bodies', () => {
  const body = Buffer.from('<feed/>'), secret = 'secret';
  const sig = 'sha1=' + createHmac('sha1', secret).update(body).digest('hex');
  assert(validSignature(body, sig, secret));
  assert(!validSignature(Buffer.from('changed'), sig, secret));
  assert(!validSignature(body, undefined, secret));
});
test('one member/one channel and duplicate channel constraints are enforced in storage', t => {
  const s = fixture(t); channel(s);
  assert.throws(() => channel(s));
  assert.throws(() => s.add('other', { id: cid, snippet: { title: 'T' }, contentDetails: { relatedPlaylists: { uploads: 'U' } } }));
  assert.equal(s.get('SELECT count(*) n FROM channels').n, 1);
});
test('stale approval cannot reapprove or reset monitoring baseline', t => {
  const s = fixture(t), c = channel(s);
  assert.equal(s.approve(c.id, 'admin', since + 5000), false);
  assert.equal(s.get('SELECT since FROM channels').since, since);
});
test('queue deduplicates repeated pushes and title updates', t => {
  const s = fixture(t), c = channel(s);
  s.queue(c, upload(), 'upload'); s.queue(c, { ...upload(), snippet: { ...upload().snippet, title: 'Edited' } }, 'upload');
  assert.equal(s.get('SELECT count(*) n FROM events').n, 1);
});
test('budget reservations are atomic and separate expensive search budget', t => {
  const s = fixture(t);
  assert(s.reserveQuota(100, true, 110, 100));
  assert(!s.reserveQuota(100, true, 110, 100));
  assert(s.reserveQuota(10, false, 110, 100));
  assert(!s.reserveQuota(1, false, 110, 100));
});
test('leader lease prevents a second worker', t => {
  const s = fixture(t);
  assert(s.acquire('bot', 'one')); assert(!s.acquire('bot', 'two')); assert(s.acquire('bot', 'one'));
});
test('registrations, deduplication and audit survive database reopen', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gamer-bot-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'bot.sqlite'); let s = new Store(path);
  const c = channel(s); s.queue(c, upload(), 'upload'); s.close();
  s = new Store(path);
  try {
    assert.equal(s.get('SELECT state FROM channels').state, 'approved');
    s.queue(c, upload(), 'upload'); assert.equal(s.get('SELECT count(*) n FROM events').n, 1);
    assert.equal(s.get('SELECT count(*) n FROM audit').n, 2);
  } finally { s.close(); }
});
test('removing a channel cancels all queued work', t => {
  const s = fixture(t), c = channel(s); s.queue(c, upload(), 'upload');
  s.remove(c.id, 'member1'); assert.equal(s.get('SELECT count(*) n FROM events').n, 0);
});
test('worker ignores channel ownership mismatch and removed registrations', t => {
  const s = fixture(t), c = channel(s), w = new Worker(s, {}, {}, {}, () => true);
  w.ingest(c, [{ ...upload(), snippet: { ...upload().snippet, channelId: 'other' } }]);
  assert.equal(s.get('SELECT count(*) n FROM events').n, 0);
  s.remove(c.id, 'member1'); w.ingest(c, [upload()]);
  assert.equal(s.get('SELECT count(*) n FROM events').n, 0);
});
test('successful notification is stored once with restricted mentions', async t => {
  const s = fixture(t), c = channel(s); s.queue(c, upload(), 'upload'); let sent = 0;
  const w = new Worker(s, { videos: async () => [upload()] }, {}, { notifications: { send: async payload => {
    sent++; assert.deepEqual(payload.allowedMentions, { parse: [], users: ['member1'] }); assert.equal(payload.enforceNonce, true); return { id: 'msg' };
  } } }, () => true);
  await w.deliver(); await w.deliver(); assert.equal(sent, 1); assert.equal(s.get('SELECT state FROM events').state, 'sent');
});
test('send failure remains queued with backoff', async t => {
  const s = fixture(t), c = channel(s); s.queue(c, upload(), 'upload');
  const w = new Worker(s, { videos: async () => [upload()] }, {}, { notifications: { send: async () => { throw new Error('network'); } } }, () => true);
  await w.deliver(); const row = s.get('SELECT * FROM events'); assert.equal(row.state, 'pending'); assert.equal(row.attempts, 1); assert(row.next_try > Date.now());
});
test('local daily quota exhaustion does not exhaust notification retries', async t => {
  const s = fixture(t), c = channel(s); s.queue(c, upload(), 'upload');
  const w = new Worker(s, { videos: async () => { const e = new Error('budget'); e.code = 'QUOTA_LOCAL'; throw e; } }, {}, {}, () => true);
  await w.deliver(); const row = s.get('SELECT * FROM events');
  assert.equal(row.state, 'pending'); assert.equal(row.attempts, 0); assert(row.next_try > Date.now());
});
test('retry skips ended livestreams', async t => {
  const s = fixture(t), c = channel(s); s.queue(c, live(), 'live');
  const ended = { ...live(), liveStreamingDetails: { ...live().liveStreamingDetails, actualEndTime: '2026-10-09T02:00:00Z' } };
  const w = new Worker(s, { videos: async () => [ended] }, {}, {}, () => true);
  await w.deliver(); assert.equal(s.get('SELECT state FROM events').state, 'cancelled');
});
test('crash recovery reconciles an already-posted Discord message', async t => {
  const s = fixture(t), c = channel(s); s.queue(c, upload(), 'upload');
  s.run("UPDATE events SET state='sending', attempts=1"); const e = s.get('SELECT * FROM events');
  const w = new Worker(s, { videos: async () => [upload()] }, {}, { notifications: { client: { user: { id: 'bot' } }, messages: { fetch: async () => [{ id: 'existing', author: { id: 'bot' }, embeds: [{ footer: { text: `Alert ${nonce(e.key)}` } }] }] }, send: async () => { assert.fail('must not repost'); } } }, () => true);
  await w.deliver(); assert.equal(s.get('SELECT message FROM events').message, 'existing');
});
test('permission denial is checked before executing admin button', async t => {
  const s = fixture(t), c = channel(s), client = new EventEmitter(); let result = '';
  attachCommands(client, s, {}, { guild: 'guild' }, {}, () => '');
  const interaction = { user: { id: 'nonadmin' }, guildId: 'guild', guild: { members: { fetch: async () => ({ permissions: { bitfield: 32n } }) } }, isChatInputCommand: () => false, isButton: () => true, customId: `yt:reject:${c.id}`, deferReply: async () => {}, editReply: async p => { result = p.content; } };
  await client.listeners('interactionCreate')[0](interaction);
  assert.match(result, /Only server administrators/); assert(s.get('SELECT id FROM channels WHERE id=?', c.id));
});
test('HTTP callback authenticates verification and persists only signed matching hints', async t => {
  const s = fixture(t), c = channel(s);
  const config = { publicUrl: 'https://example.test/discord-bot', secret: 's'.repeat(64), port: '0' };
  const server = webServer(s, config, () => true); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/discord-bot/youtube/webhook?channel=${cid}`;
  const verify = new URL(url);
  for (const [key, value] of Object.entries({ 'hub.mode': 'subscribe', 'hub.topic': topic(cid), 'hub.verify_token': channelSecret(config, cid), 'hub.challenge': 'proof', 'hub.lease_seconds': '86400' })) verify.searchParams.set(key, value);
  let r = await fetch(verify); assert.equal(r.status, 200); assert.equal(await r.text(), 'proof');
  verify.searchParams.set('hub.verify_token', 'wrong'); assert.equal((await fetch(verify)).status, 403);
  const body = `<feed><entry><yt:videoId>${vid}</yt:videoId><yt:channelId>${cid}</yt:channelId></entry></feed>`;
  assert.equal((await fetch(url, { method: 'POST', body })).status, 403);
  const signature = 'sha1=' + createHmac('sha1', channelSecret(config, cid)).update(body).digest('hex');
  r = await fetch(url, { method: 'POST', body, headers: { 'X-Hub-Signature': signature } });
  assert.equal(r.status, 204); assert.equal(s.get('SELECT channel FROM candidates').channel, c.id);
});
