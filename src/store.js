'use strict';
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { randomUUID } = require('node:crypto');
const { pacificDay } = require('./core');

class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, member TEXT NOT NULL UNIQUE, youtube TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL, playlist TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        since INTEGER, created INTEGER NOT NULL, approval_message TEXT,
        last_poll INTEGER NOT NULL DEFAULT 0, last_search INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0, renew_after INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS candidates (video TEXT PRIMARY KEY, channel TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, channel TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        video TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0, message TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT, subject TEXT, detail TEXT);
      CREATE TABLE IF NOT EXISTS quota (day TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, search_used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cooldown (member TEXT PRIMARY KEY, until INTEGER NOT NULL);`);
  }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  audit(action, actor = null, subject = null, detail = null) {
    this.run('INSERT INTO audit(at, action, actor, subject, detail) VALUES (?, ?, ?, ?, ?)', Date.now(), action, actor, subject, detail);
    console.log(JSON.stringify({ at: new Date().toISOString(), action, actor, subject, detail }));
  }
  add(member, info) {
    return this.transaction(() => {
      const id = randomUUID();
      this.run('INSERT INTO channels(id,member,youtube,title,playlist,created) VALUES (?,?,?,?,?,?)', id, member, info.id, info.snippet.title, info.contentDetails.relatedPlaylists.uploads, Date.now());
      this.audit('channel_submitted', member, id);
      return this.get('SELECT * FROM channels WHERE id=?', id);
    });
  }
  approve(id, actor, now = Date.now()) {
    return this.transaction(() => {
      const changed = this.run("UPDATE channels SET state='approved', since=? WHERE id=? AND state='pending'", now, id).changes;
      if (changed) this.audit('channel_approved', actor, id);
      return !!changed;
    });
  }
  remove(id, actor, action = 'channel_removed') {
    this.transaction(() => {
      if (this.run('DELETE FROM channels WHERE id=?', id).changes) this.audit(action, actor, id);
    });
  }
  queue(channel, video, kind) {
    const key = `${channel.youtube}:${video.id}:${kind}`;
    // Details are fetched again for delivery; retain identifiers, not a stale API response.
    this.run('INSERT OR IGNORE INTO events(key,channel,video,kind,payload,created) VALUES(?,?,?,?,?,?)', key, channel.id, video.id, kind, '{}', Date.now());
  }
  reserveQuota(cost, search, totalBudget, searchBudget) {
    return this.transaction(() => {
      const day = pacificDay();
      this.run('INSERT OR IGNORE INTO quota(day) VALUES(?)', day);
      const q = this.get('SELECT * FROM quota WHERE day=?', day);
      if (q.used + cost > totalBudget || (search && q.search_used + cost > searchBudget)) return false;
      this.run('UPDATE quota SET used=used+?, search_used=search_used+? WHERE day=?', cost, search ? cost : 0, day);
      return true;
    });
  }
  acquire(name, owner, duration = 120000) {
    return this.transaction(() => {
      const now = Date.now();
      const l = this.get('SELECT * FROM locks WHERE name=?', name);
      if (l && l.until > now && l.owner !== owner) return false;
      this.run('INSERT INTO locks(name,owner,until) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, until=excluded.until', name, owner, now + duration);
      return true;
    });
  }
  close() { this.db.close(); }
}
module.exports = { Store };
