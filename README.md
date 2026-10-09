# Gamer Hub Discord Bot

YouTube upload and livestream notifications for a Discord server. Members submit their channels; a server administrator must approve each one. Built for **Node.js 24** and a single continuously running cPanel Node.js application.

## Features

- One YouTube channel per member, with unique channel registration across the server.
- Private approval cards with Approve/Reject buttons; administrator permission is checked again when clicked.
- Upload alerts and live-start alerts with video title, thumbnail, watch link and creator mention.
- YouTube signed push notifications, automatic subscription renewal, upload polling, and quota-limited live discovery.
- Persistent SQLite registration, queue, deduplication history, audit records and quota accounting.
- Retries with backoff, live status revalidation before delivery, and crash recovery.
- Pause, resume, remove, reject, operational status, audit history, and manual retry controls.
- Starts monitoring from approval time. Existing uploads, ended streams and streams already live before approval are not announced. Resume also starts a new baseline.

This is an implemented first version, not a deployed service. Live Discord/YouTube verification needs the environment variables on your server. The repository intentionally contains no credentials.

## cPanel installation

### 1. Put the source in the application root

Use cPanel Terminal. If the application root exists and contains a placeholder `app.js`, back up that placeholder before replacing it. Clone into an empty directory:

```bash
cd ~
git clone https://github.com/huzailjamil/gamer-hub-discord-bot.git discord-bot
cd ~/discord-bot
```

If `~/discord-bot` already exists, clone to a different empty directory and set that as the application root, or download this repository's ZIP and upload/extract its contents directly into the existing root. `app.js`, `package.json`, `src/`, and the other project files must be directly inside the root, not an extra nested folder. Do not delete an existing database or environment file when updating.

### 2. Configure Setup Node.js App

| cPanel field | Value |
| --- | --- |
| Node.js version | 24.x |
| Application mode | Production |
| Application root | `discord-bot` (or the actual directory chosen above) |
| Application URL | `taskoraagent.com` with path `discord-bot` |
| Application startup file | `app.js` |

Copy and run the **virtual environment activation command shown by your own cPanel app** before terminal npm commands. Do not copy another account's activation path. Then, inside the application root:

```bash
node -v
npm ci --omit=dev
npm test
```

Node must report v24. If cPanel creates a `node_modules` symlink for its virtual environment, keep that symlink; do not replace it with uploaded dependencies. Alternatively use cPanel's **Run NPM Install** button with the included lockfile. No TypeScript build, external SQL server or compiler is required: the code is JavaScript and uses Node's built-in SQLite.

### 3. Set environment variables

Put secrets in **Setup Node.js App → Environment variables**, not into a committed file. Values already entered in cPanel can stay there.

| Name | Value |
| --- | --- |
| `DISCORD_TOKEN` | Your bot token |
| `DISCORD_CLIENT_ID` | Your Discord application ID |
| `DISCORD_GUILD_ID` | `1550032729696116797` |
| `NOTIFICATION_CHANNEL_ID` | `1558187400742707210` |
| `APPROVAL_CHANNEL_ID` | `1558187188573835306` |
| `YOUTUBE_API_KEY` | Your key restricted to YouTube Data API v3 |
| `PUBLIC_URL` | `https://taskoraagent.com/discord-bot` |
| `WEBHOOK_SECRET` | Random secret generated below |
| `DATABASE_PATH` | Prefer an absolute private path, e.g. `/home/YOUR_CPANEL_USERNAME/discord-bot-data/bot.sqlite` |

Generate `WEBHOOK_SECRET` in your private cPanel terminal, and copy the result into cPanel:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use your real cPanel account name in `DATABASE_PATH`. The database directory must be writable by the app, outside publicly served directories, and backed up. The default is `data/bot.sqlite` beneath the app's working directory. The database and secrets are excluded from Git.

Do not override a `PORT` supplied by the host. For standalone local operation the default is 3000. A private `.env` is supported for local testing; cPanel environment variables take precedence. `.env.example` is only a template.

### 4. Start and verify

1. Save environment changes and click **Restart** in cPanel.
2. Open `https://taskoraagent.com/discord-bot/health`. It should return `ok` once Discord is connected. The webhook endpoint is `/youtube/webhook`; it is not a browser dashboard.
3. The bot should come online in GAMER HUB. Run `/youtube status` as an administrator.
4. As a member, run `/youtube add channel:@YourHandle`.
5. An administrator approves the card in the private approval channel.
6. Upload a **new public video after approval**, or schedule a new public stream and register its link with `/youtube watch` before starting it.
7. Verify exactly one alert appears and that `/youtube status` and `/youtube audit` show no errors.

The app registers `/youtube` automatically at startup in the configured server. No separate command registration script is needed. Discord permissions and the two configured channel types are checked on startup.

## Discord permissions

Invite using scopes `bot` and `applications.commands`. In both configured text channels, allow the bot **View Channel**, **Send Messages**, **Embed Links**, and **Read Message History**. Keep the approvals channel private to administrators and the bot.

The bot does not require Administrator permission. Server Members, Presence, and Message Content privileged intents should stay off. It uses only the Guilds gateway intent. Reviewers need the server's **Administrator** permission; Manage Server alone is not sufficient. Administrators should verify ownership themselves: a submitted public channel link is not proof of ownership.

The only allowed ping in an alert is the submitting creator's Discord user. Titles cannot trigger @everyone or role pings. Other messages suppress all mentions.

## Commands

| Command | Who | Purpose |
| --- | --- | --- |
| `/youtube add channel:<URL or @handle>` | Member | Submit one channel |
| `/youtube remove` | Member | Remove own registration and pending work |
| `/youtube list page:1` | Member | View registration status, ten per page |
| `/youtube watch video:<URL>` | Approved creator | Track a public scheduled/live video from own channel |
| `/youtube approve member:<user>` | Admin | Approve without the button |
| `/youtube reject member:<user>` | Admin | Reject a pending request |
| `/youtube pause member:<user>` | Admin | Pause alerts and cancel queued alerts |
| `/youtube resume member:<user>` | Admin | Resume from now without backfill |
| `/youtube delete member:<user>` | Admin | Remove any registration |
| `/youtube status` | Admin | Worker, queue and daily quota status |
| `/youtube audit` | Admin | Last 12 operational audit entries |
| `/youtube retry` | Admin | Retry failed alerts; stale live alerts are skipped |

Supported channel inputs: `@handle`, `/@handle`, `/channel/UC…`, raw `UC…` channel IDs, and legacy `/user/name`. Legacy `/c/custom-name` links must be replaced with the channel's @handle. Members can submit once every five minutes, and use `/youtube watch` once every 30 seconds.

## Detection timing and quotas

YouTube push notifications report uploads and metadata edits. They **do not guarantee a live-start event**. This bot combines three paths:

1. **Push:** signed Atom hints persist in SQLite, then the worker verifies the video with YouTube before posting.
2. **Upload fallback:** check the latest 50 uploads about every five minutes for a small server, slowing automatically with more channels to preserve quota.
3. **Streams:** known scheduled/live candidates are checked about every minute. `/youtube watch` ensures a specific public broadcast is known. Discovery of unknown active streams uses expensive `search.list` calls distributed over a daily budget.

Defaults reserve at most 9,000 units/day locally, including at most 4,000 for live search. Search calls cost 100 units. With three approved channels, fallback live discovery runs roughly every **108 minutes per channel**; with one channel, roughly every 36 minutes. A stream missed by push and upload discovery can therefore be announced late, or missed if it ends before the next search. Registering a scheduled stream with `/youtube watch` avoids waiting for this search. No near-instant guarantee is made. Public premieres may be classified as live broadcasts by YouTube and receive live-style alerts.

| Optional variable | Default | Purpose |
| --- | --- | --- |
| `POLL_SECONDS` | `300` | Minimum upload poll interval |
| `LIVE_CHECK_SECONDS` | `60` | Known-stream check interval |
| `YOUTUBE_DAILY_BUDGET` | `9000` | Local daily cap across all YouTube calls |
| `LIVE_SEARCH_DAILY_BUDGET` | `4000` | Portion allowed for active-stream discovery; `0` disables search |
| `MAX_CHANNELS` | `25` | Total registrations, including pending and paused |

Accounting resets on the next Pacific-time calendar day. This is a local cap, not a Google quota increase, and does not account for other apps using the same Cloud project. Verify the actual quota in Google Cloud. More channels, concurrent streams, unavailable candidates, or a shared API project may exhaust quota. On exhaustion, work remains queued and checks resume the next day. Raise budgets only if your project's quota permits it. Polling does not backfill more than the latest 50 uploads, so unusually high upload volume or long downtime can miss content. Candidate tracking expires after 30 days without a confirming public broadcast response.

## Hosting and operation

- **One continuously running process on one machine.** A SQLite lease prevents simultaneous bot instances sharing the database. A replacement can wait up to a minute for an old lease to expire after a crash.
- cPanel/Passenger must keep the process alive with no idle shutdown. Ask the host to configure a persistent application process (for example, the equivalent of Passenger minimum instances and no idle timeout) if it suspends it. Opening a health URL is not a substitute for this. Do not start a second `npm start` alongside Passenger.
- Allow outbound HTTPS to Discord, YouTube/Google APIs and `pubsubhubbub.appspot.com`, plus outbound Discord gateway WebSockets. The public HTTPS webhook must reach the Node app without a CAPTCHA or login page.
- SQLite must be on a reliable local filesystem, not shared network storage. Logs go to cPanel's application log and the SQLite `audit` table. These are operational logs, not tamper-proof compliance certification evidence.
- Back up the database. For a simple consistent copy, **stop the app first**, copy the entire database directory (including any WAL/SHM files), then restart. Restore with the app stopped. Losing the database loses registrations, accounting and deduplication history.
- Alerts retry with increasing delays, up to twelve attempts; an administrator can requeue failures. Live alerts are revalidated before posting and skipped if the stream has ended. Generic API outages may delay delivery.
- Event uniqueness, Discord's `enforceNonce`, and reconciliation against the last 100 destination messages reduce duplicates. They cannot guarantee exactly-once delivery if a process crashes after Discord accepts a message and that message is later outside the reconciliation window or deleted. Keep the notification channel dedicated to alerts.
- Removing a channel cancels future queued work but does not delete past Discord messages or audit history. An already in-flight Discord request may finish at the same moment as removal/pause.
- API metadata is refreshed during checks; unused event payloads are pruned after 30 days. Operational audit records expire after 90 days. Review your own privacy notice, Discord retention and backups before opening registration broadly.

### Updating from GitHub

Activate the same cPanel Node virtual environment, then:

```bash
cd ~/discord-bot
git pull --ff-only origin main
npm ci --omit=dev
npm test
```

Click **Restart** in cPanel. The database and environment variables stay in place. If you initially used a ZIP, use a new ZIP to replace code files while preserving private data; initialize a proper clone for future `git pull` updates. This repository does not automatically deploy to cPanel.

### Troubleshooting

- **Offline:** inspect the app log; check Node 24, token, Application ID, environment variables and whether the host keeps processes running.
- **Startup permission failure:** verify both configured IDs point to ordinary text channels in the specified server, and check the bot's four channel permissions.
- **Missing slash command:** restart, verify the `applications.commands` installation scope, and reopen Discord.
- **No approval card:** fix approval-channel permissions. Pending cards retry every minute; admins can also use `/youtube approve`.
- **YouTube HTTP 403:** check API enablement, key restrictions, project quota, and any server-IP restriction.
- **Subscription failure:** verify `PUBLIC_URL`, public HTTPS routing, and `WEBHOOK_SECRET`; check `/youtube audit`. Upload polling continues as fallback.
- **No live alert:** register the public stream with `/youtube watch` before it starts. Streams already live at approval/resume are intentionally not backfilled.
- **HTTP `starting`/503:** Discord is not ready, startup checks failed, or the worker has not completed a pass recently. Check the application log.

## Development and validation

```bash
npm ci
npm test
npm run check
npm audit --omit=dev
```

Automated tests use temporary databases and mocked Discord/YouTube responses, plus a real local HTTP callback server. They do not use private credentials or send real Discord messages. Complete the live smoke test in the installation section after deployment.

Implementation references: [YouTube push notifications](https://developers.google.com/youtube/v3/guides/push_notifications), [channels.list](https://developers.google.com/youtube/v3/docs/channels/list), [playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list), [videos.list](https://developers.google.com/youtube/v3/docs/videos/list), [search.list](https://developers.google.com/youtube/v3/docs/search/list), [Discord messages](https://docs.discord.com/developers/resources/message).
