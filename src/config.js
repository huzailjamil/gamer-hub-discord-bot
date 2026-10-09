'use strict';
const { resolve } = require('node:path');
function config() {
  const required = name => { const v = process.env[name]?.trim(); if (!v) throw new Error(`Missing environment variable: ${name}`); return v; };
  const integer = (name, value, min, max) => {
    const n = Number(process.env[name] || value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}: expected ${min}–${max}`);
    return n;
  };
  const id = name => { const v = required(name); if (!/^\d{17,20}$/.test(v)) throw new Error(`Invalid ${name}`); return v; };
  const secret = required('WEBHOOK_SECRET');
  if (secret.length < 32) throw new Error('WEBHOOK_SECRET must have at least 32 characters.');
  const publicUrl = required('PUBLIC_URL').replace(/\/$/, '');
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) throw new Error('PUBLIC_URL must be a plain HTTPS URL.');
  const c = {
    token: required('DISCORD_TOKEN'), clientId: id('DISCORD_CLIENT_ID'), guild: id('DISCORD_GUILD_ID'),
    notifications: id('NOTIFICATION_CHANNEL_ID'), approvals: id('APPROVAL_CHANNEL_ID'),
    youtubeKey: required('YOUTUBE_API_KEY'), secret, publicUrl,
    database: resolve(process.env.DATABASE_PATH || './data/bot.sqlite'),
    port: process.env.PORT || '3000', poll: integer('POLL_SECONDS', 300, 60, 86400) * 1000,
    liveCheck: integer('LIVE_CHECK_SECONDS', 60, 30, 3600) * 1000,
    budget: integer('YOUTUBE_DAILY_BUDGET', 9000, 100, 1000000),
    searchBudget: integer('LIVE_SEARCH_DAILY_BUDGET', 4000, 0, 1000000),
    maxChannels: integer('MAX_CHANNELS', 25, 1, 1000)
  };
  if (c.approvals === c.notifications) throw new Error('Approval and notification channels must be different.');
  if (c.searchBudget > c.budget) throw new Error('Live search budget must not exceed total budget.');
  return c;
}
module.exports = { config };
