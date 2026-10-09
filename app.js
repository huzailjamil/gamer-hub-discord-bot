'use strict';
// CommonJS entry point works with cPanel/Passenger app.js startup configuration.
try { require('node:process').loadEnvFile(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
process.umask(0o077);
const { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } = require('discord.js');
const { randomUUID } = require('node:crypto');
const { config } = require('./src/config');
const { Store } = require('./src/store');
const { YouTube } = require('./src/youtube');
const { webServer } = require('./src/web');
const { command, attachCommands } = require('./src/commands');
const { Worker } = require('./src/worker');
const { pacificDay } = require('./src/core');

async function main() {
  const c = config();
  const store = new Store(c.database);
  const owner = randomUUID();
  let acquired = store.acquire('bot', owner, 45000);
  for (let attempt = 0; !acquired && attempt < 12; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    acquired = store.acquire('bot', owner, 45000);
  }
  if (!acquired) throw new Error('Another bot instance owns this database. Run only one instance.');
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
  let leader = true, initialized = false, stopping = false, worker;
  const healthy = () => leader && initialized && client.isReady() && (!worker?.lastSuccess || Date.now() - worker.lastSuccess < 600000);
  const server = webServer(store, c, healthy);
  server.on('error', () => shutdown('http_server_failed', 1));
  const heartbeat = setInterval(() => {
    try {
      if (!store.acquire('bot', owner, 45000)) { leader = false; shutdown('lease_lost', 1); }
    } catch { leader = false; shutdown('lease_failed', 1); }
  }, 10000);
  const timers = [heartbeat];
  function shutdown(reason, code = 0) {
    if (stopping) return;
    stopping = true; leader = false;
    store.audit(reason);
    timers.forEach(clearInterval);
    client.destroy(); server.close();
    // Release immediately before exit, so cPanel Restart can start its replacement.
    setTimeout(() => {
      try { store.run('DELETE FROM locks WHERE name=? AND owner=?', 'bot', owner); } finally { process.exit(code); }
    }, 1000);
  }
  process.once('SIGTERM', () => shutdown('shutdown'));
  process.once('SIGINT', () => shutdown('shutdown'));
  client.on('error', e => store.audit('discord_error', null, null, String(e.code || e.name)));
  client.once('clientReady', async () => {
    try {
      if (client.user.id !== c.clientId) throw new Error('DISCORD_CLIENT_ID does not match this bot token.');
      const guild = await client.guilds.fetch(c.guild);
      const me = await guild.members.fetchMe();
      const channels = { approvals: await guild.channels.fetch(c.approvals), notifications: await guild.channels.fetch(c.notifications) };
      for (const channel of Object.values(channels)) {
        if (channel?.type !== ChannelType.GuildText) throw new Error('Both configured channels must be ordinary server text channels.');
        const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory];
        if (!channel.permissionsFor(me).has(needed)) throw new Error(`Missing permissions in configured channel ${channel.id}.`);
      }
      const youtube = new YouTube(store, c);
      worker = new Worker(store, youtube, c, channels, () => leader && initialized && client.isReady());
      const status = () => {
        const quota = store.get('SELECT * FROM quota WHERE day=?', pacificDay());
        const active = store.get("SELECT count(*) n FROM channels WHERE state='approved'").n;
        const pending = store.get("SELECT count(*) n FROM events WHERE state IN ('pending','sending')").n;
        const failed = store.get("SELECT count(*) n FROM events WHERE state='failed'").n;
        return `Bot: ${healthy() ? 'ready' : 'starting/degraded'}\nApproved channels: ${active}\nAlert queue: ${pending}; failed: ${failed}\nYouTube budget today: ${quota?.used || 0}/${c.budget}; search: ${quota?.search_used || 0}/${c.searchBudget}\nLast worker pass: ${worker.lastSuccess ? new Date(worker.lastSuccess).toISOString() : 'not yet'}\nLive search interval: ${c.searchBudget ? Math.ceil(Math.max(10, active * 100 * 1440 / c.searchBudget)) + ' minutes/channel' : 'disabled'}\nUse /youtube watch for frequent checks of a known scheduled stream.`;
      };
      attachCommands(client, store, youtube, c, channels, status);
      // Upsert only our command; do not overwrite other commands registered to this application.
      await guild.commands.create(command.toJSON());
      initialized = true;
      store.audit('bot_ready');
      timers.push(setInterval(() => { void worker.tick(); }, 15000));
      void worker.tick();
    } catch (e) {
      store.audit('startup_failed', null, null, e.message?.includes('token') ? 'Application/token mismatch or authorization failure.' : e.message);
      shutdown('startup_aborted', 1);
    }
  });
  try { await client.login(c.token); }
  catch { shutdown('discord_login_failed', 1); }
}
main().catch(e => { console.error(`Startup failed: ${e.message}`); process.exitCode = 1; });
