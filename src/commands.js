'use strict';
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, escapeMarkdown } = require('discord.js');
const { isAdmin, parseChannel, parseVideo, nonce } = require('./core');
const { randomUUID } = require('node:crypto');
const memberOption = o => o.setName('member').setDescription('Member whose channel to manage').setRequired(true);
const command = new SlashCommandBuilder().setName('youtube').setDescription('YouTube creator notifications').setDMPermission(false)
  .addSubcommand(s => s.setName('add').setDescription('Submit your channel for admin approval').addStringOption(o => o.setName('channel').setDescription('YouTube channel URL or @handle').setRequired(true).setMaxLength(300)))
  .addSubcommand(s => s.setName('remove').setDescription('Remove your own channel'))
  .addSubcommand(s => s.setName('list').setDescription('List registered channels').addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1)))
  .addSubcommand(s => s.setName('watch').setDescription('Track a scheduled/live video on your approved channel').addStringOption(o => o.setName('video').setDescription('YouTube video URL').setRequired(true).setMaxLength(300)))
  .addSubcommand(s => s.setName('approve').setDescription('Admin: approve a pending channel').addUserOption(memberOption))
  .addSubcommand(s => s.setName('reject').setDescription('Admin: reject a pending channel').addUserOption(memberOption))
  .addSubcommand(s => s.setName('pause').setDescription('Admin: pause alerts').addUserOption(memberOption))
  .addSubcommand(s => s.setName('resume').setDescription('Admin: resume alerts without backfilling').addUserOption(memberOption))
  .addSubcommand(s => s.setName('delete').setDescription('Admin: remove any registered channel').addUserOption(memberOption))
  .addSubcommand(s => s.setName('status').setDescription('Admin: show worker and quota status'))
  .addSubcommand(s => s.setName('retry').setDescription('Admin: retry failed notifications'))
  .addSubcommand(s => s.setName('audit').setDescription('Admin: show recent operational audit entries'));

function buttons(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`yt:approve:${id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`yt:reject:${id}`).setLabel('Reject').setStyle(ButtonStyle.Danger));
}
async function sendApproval(store, channel, row) {
  const owner = randomUUID(), lock = `approval:${row.id}`;
  if (!store.acquire(lock, owner, 120000)) return;
  try {
  const current = store.get("SELECT * FROM channels WHERE id=? AND state='pending' AND approval_message IS NULL", row.id);
  if (!current) return;
  const history = await channel.messages.fetch({ limit: 100 });
  const existing = history.find(m => m.author.id === channel.client.user.id && m.embeds.some(e => e.footer?.text === `Request ${row.id}`));
  if (existing) { store.run('UPDATE channels SET approval_message=? WHERE id=?', existing.id, row.id); return; }
  const message = await channel.send({
    content: `Channel submitted by <@${row.member}>. Check that this member owns the channel before approving.`,
    embeds: [{ title: row.title.slice(0, 256), url: `https://www.youtube.com/channel/${row.youtube}`, description: 'Approve to monitor new uploads and livestreams. Existing content will not be announced.', footer: { text: `Request ${row.id}` } }],
    components: [buttons(row.id)], allowedMentions: { parse: [] }, nonce: nonce(`approval:${row.id}`), enforceNonce: true
  });
  store.run('UPDATE channels SET approval_message=? WHERE id=?', message.id, row.id);
  } finally { store.run('DELETE FROM locks WHERE name=? AND owner=?', lock, owner); }
}
async function refreshApproval(store, channel, row, result) {
  if (!row.approval_message) return;
  try {
    const message = await channel.messages.fetch(row.approval_message);
    await message.edit({ content: `${result} — request ${row.id}`, components: [], allowedMentions: { parse: [] } });
  } catch { store.audit('approval_message_update_failed', null, row.id); }
}
function attachCommands(client, store, youtube, config, channels, status) {
  const inFlight = new Set();
  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
    if (interaction.isChatInputCommand() && interaction.commandName !== 'youtube') return;
    if (interaction.isButton() && !interaction.customId.startsWith('yt:')) return;
    let held = false;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const reply = content => interaction.editReply({ content, allowedMentions: { parse: [] } });
      if (interaction.guildId !== config.guild) return reply('This bot is configured for a different server.');
      if (inFlight.has(interaction.user.id)) return reply('Your previous command is still processing.');
      inFlight.add(interaction.user.id); held = true;
      const button = interaction.isButton();
      const action = button ? interaction.customId.split(':')[1] : interaction.options.getSubcommand();
      const adminAction = ['approve', 'reject', 'pause', 'resume', 'delete', 'status', 'audit', 'retry'].includes(action);
      if (adminAction) {
        // Refresh permissions from Discord, not from a cached role or button visibility.
        const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
        if (!isAdmin(member.permissions.bitfield)) {
          store.audit('admin_action_denied', interaction.user.id, null, action);
          return reply('Only server administrators can perform this action.');
        }
      }
      if (action === 'status') return reply(status());
      if (action === 'retry') {
        const changed = store.run("UPDATE events SET state='sending',attempts=0,next_try=0 WHERE state='failed'").changes;
        store.audit('notifications_requeued', interaction.user.id, null, String(changed));
        return reply(`${changed} failed alerts queued for retry. Ended streams and unavailable videos will be skipped.`);
      }
      if (action === 'audit') {
        const rows = store.all('SELECT * FROM audit ORDER BY id DESC LIMIT 12');
        return reply(rows.map(r => `${new Date(r.at).toISOString()} | ${r.action} | ${r.actor || 'system'}${r.detail ? ` | ${r.detail}` : ''}`).join('\n').slice(0, 1950) || 'No audit entries.');
      }
      if (action === 'list') {
        const page = interaction.options.getInteger('page') || 1;
        const rows = store.all('SELECT * FROM channels ORDER BY created LIMIT 10 OFFSET ?', (page - 1) * 10);
        return reply(rows.map(r => `${escapeMarkdown(r.title).slice(0, 100)} — <@${r.member}> — **${r.state}**\nhttps://www.youtube.com/channel/${r.youtube}`).join('\n\n').slice(0, 1950) || 'No channels on this page.');
      }
      if (action === 'add') {
        if (store.get('SELECT id FROM channels WHERE member=?', interaction.user.id)) return reply('You already have a channel registered. Use /youtube remove first.');
        if (store.get('SELECT count(*) n FROM channels').n >= config.maxChannels) return reply('The server has reached its channel limit. Ask an administrator.');
        const input = interaction.options.getString('channel', true);
        parseChannel(input); // Invalid input must not create a five-minute cooldown.
        const cooldown = store.get('SELECT until FROM cooldown WHERE member=?', interaction.user.id);
        if (cooldown?.until > Date.now()) return reply(`Please wait ${Math.ceil((cooldown.until - Date.now()) / 1000)} seconds before trying again.`);
        store.run('INSERT INTO cooldown(member,until) VALUES(?,?) ON CONFLICT(member) DO UPDATE SET until=excluded.until', interaction.user.id, Date.now() + 10000); // Short API-abuse limit while resolving; successful submissions use five minutes.
        const info = await youtube.resolve(input);
        if (store.get('SELECT id FROM channels WHERE youtube=?', info.id)) return reply('That YouTube channel is already registered.');
        // Recheck capacity after the network request; another member may have submitted meanwhile.
        if (store.get('SELECT count(*) n FROM channels').n >= config.maxChannels) return reply('The server has reached its channel limit.');
        const row = store.add(interaction.user.id, info);
        store.run('UPDATE cooldown SET until=? WHERE member=?', Date.now() + 300000, interaction.user.id);
        try { await sendApproval(store, channels.approvals, row); }
        catch { store.audit('approval_delivery_failed', null, row.id); }
        return reply('Your channel is pending admin approval. Use /youtube list to check its status.');
      }
      const target = button ? null : (adminAction ? interaction.options.getUser('member', true).id : interaction.user.id);
      const row = button ? store.get('SELECT * FROM channels WHERE id=?', interaction.customId.split(':')[2]) : store.get('SELECT * FROM channels WHERE member=?', target);
      if (!row) return reply('This channel request no longer exists.');
      if (button && (interaction.channelId !== config.approvals || interaction.message.id !== row.approval_message)) return reply('This approval button is no longer valid. Use /youtube approve or /youtube reject.');
      if (action === 'watch') {
        if (row.state !== 'approved') return reply('Your channel must be approved and active.');
        const key = `watch:${interaction.user.id}`;
        if (store.get('SELECT until FROM cooldown WHERE member=?', key)?.until > Date.now()) return reply('Please wait 30 seconds between tracking requests.');
        store.run('INSERT INTO cooldown(member,until) VALUES(?,?) ON CONFLICT(member) DO UPDATE SET until=excluded.until', key, Date.now() + 30000);
        const videoId = parseVideo(interaction.options.getString('video', true));
        const [video] = await youtube.videos([videoId]);
        if (!video || video.snippet.channelId !== row.youtube || video.status?.privacyStatus !== 'public') return reply('That must be a public video on your approved channel.');
        if (!video.liveStreamingDetails) return reply('That video is not a scheduled or live broadcast.');
        if (!store.get("SELECT id FROM channels WHERE id=? AND state='approved'", row.id)) return reply('Your channel registration changed. Try again.');
        if (store.get('SELECT count(*) n FROM candidates WHERE channel=?', row.id).n >= 100) return reply('Tracking limit reached for this channel.');
        store.run('INSERT OR IGNORE INTO candidates(video,channel,expires) VALUES(?,?,?)', videoId, row.id, Date.now() + 30 * 86400000);
        store.audit('video_tracking_added', interaction.user.id, row.id, videoId);
        return reply('Tracking this broadcast. New live starts are checked about once a minute while the bot is running.');
      }
      if (action === 'approve') {
        if (!store.approve(row.id, interaction.user.id)) return reply('This request is no longer pending.');
        await refreshApproval(store, channels.approvals, row, 'Approved');
        return reply('Approved. Monitoring begins now; old videos and already-running streams are skipped.');
      }
      if (action === 'reject' && row.state !== 'pending') return reply('Only pending requests can be rejected. Use /youtube delete for an approved channel.');
      if (['remove', 'delete', 'reject'].includes(action)) {
        store.remove(row.id, interaction.user.id, action === 'reject' ? 'channel_rejected' : 'channel_removed');
        await refreshApproval(store, channels.approvals, row, action === 'reject' ? 'Rejected' : 'Removed');
        return reply(action === 'reject' ? 'Request rejected.' : 'Channel removed.');
      }
      if (action === 'pause' || action === 'resume') {
        const expected = action === 'pause' ? 'approved' : 'paused';
        if (row.state !== expected) return reply(`Channel must be ${expected} first.`);
        store.transaction(() => {
          store.run('UPDATE channels SET state=?,since=?,last_poll=0,last_search=0,renew_after=0,next_probe=0,probe_failures=0 WHERE id=?', action === 'pause' ? 'paused' : 'approved', Date.now(), row.id);
          store.run("UPDATE events SET state='cancelled' WHERE channel=? AND state IN ('pending','sending','failed')", row.id);
          store.audit(action === 'pause' ? 'channel_paused' : 'channel_resumed', interaction.user.id, row.id);
        });
        return reply(action === 'pause' ? 'Alerts paused.' : 'Alerts resumed. Content from the pause period will not be posted.');
      }
      return reply('Unknown command.');
    } catch (e) {
      // Avoid logging Discord request bodies or tokens from SDK errors.
      store.audit('command_failed', interaction.user.id, null, String(e.code || e.name || 'Error'));
      const safe = /^(Use |Invalid YouTube|YouTube |Missing |That |legacy)/.test(e.message || '') ? e.message : 'The command could not finish. An administrator can check /youtube audit and server logs.';
      try { if (interaction.deferred || interaction.replied) await interaction.editReply({ content: safe, allowedMentions: { parse: [] } }); } catch { /* expired interaction */ }
    } finally { if (held) inFlight.delete(interaction.user.id); }
  });
}
module.exports = { command, attachCommands, sendApproval };
