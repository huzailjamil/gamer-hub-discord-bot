# Gamer Hub Discord Bot

YouTube upload and livestream notifications for a Discord server. Members submit their channels; a server administrator must approve each one. Built for **Node.js 24** and a single continuously running cPanel Node.js application.

## Features

- One YouTube channel per member, with unique channel registration across the server.
- Private approval cards with Approve/Reject buttons; administrator permission is checked again when clicked.
- Upload alerts and live-start alerts with video title, thumbnail, watch link and creator mention.
- Automatic public live-page discovery every two minutes, signed YouTube push notifications, upload polling, and API search fallback.
- Persistent SQLite registration, queue, deduplication history, audit records and quota accounting.
- Retries with backoff, live status revalidation before delivery, and crash recovery.
- Pause, resume, remove, reject, operational status, audit history, and manual retry controls.
- Starts monitoring from approval time. Existing uploads, ended streams and streams already live before approval are not announced. Resume also starts a new baseline.

This is an implemented first version, not a deployed service. Live Discord/YouTube verification needs the environment variables on your server. The repository intentionally contains no credentials.

## cPanel installation

### 1. Put the source in the application root

Keep an existing cPanel application's root unchanged. **Changing its root relocates files and can break its environment if the destination is already populated.** For an existing `discord-bot` app containing only the cPanel starter code, stop it, back up any custom files, and install like this:

```bash
cd ~
git clone https://github.com/huzailjamil/gamer-hub-discord-bot.git
cp -a gamer-hub-discord-bot/{app.js,package.json,package-lock.json,src,test,.git,.gitignore,.env.example,README.md} discord-bot/
```

This copies the project into the existing root; it does not replace `node_modules`, private `.env` files or runtime data. Do this only for the initial installation, not for updates. If the app root is not `discord-bot`, substitute its actual path. If no Node app exists yet, create one with root `discord-bot` first, then install the code above. For later updates use `git pull --ff-only` from the active root as described below. Do not rename or manually remove cPanel virtual environments.

### 2. Configure Setup Node.js App

| cPanel field | Value |
| --- | --- |
| Node.js version | 24.x |
| Application mode | Production |
| Application root | Keep the existing `discord-bot` root unchanged |
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
6. Upload a **new public video after approval**, or start a new public stream after approval. No `/youtube watch` command is required. Check automatic discovery status if an alert is delayed.
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

Supported channel inputs: `@handle`, `/@handle`, `/channel/UC…`, raw `UC…` channel IDs, and legacy `/user/name`. Legacy `/c/custom-name` links must be replaced with the channel's @handle. Successful submissions have a five-minute cooldown. Invalid URL syntax does not start that cooldown; channel-resolution attempts have a short ten-second API-abuse limit. `/youtube watch` has a 30-second limit.

## Detection timing and quotas

Approved channels are monitored automatically. **Members do not need to use `/youtube watch` for each stream.** That command remains an optional fallback.

1. **Automatic live-page discovery:** every 120 seconds, read the channel's public `/live` page, extracting active/upcoming video IDs from public page data. Persist these hints, then verify the channel owner, public visibility and actual live status using `videos.list`. No messages are sent based on HTML alone. Checks run separately from the slower upload/search worker, with at most three public requests in flight.
2. **Known streams:** check discovered or pushed candidates about every minute, batching up to 50 IDs per API call. In normal conditions this targets roughly 2–3 minutes from a discoverable live start to an alert, not a guaranteed deadline.
3. **Push and uploads:** signed push notifications and periodic upload-playlist checks continue to discover uploads and streams when YouTube exposes them there.
4. **API search fallback:** distribute a limited number of `search.list` calls across channels throughout the day, covering unknown active streams when other paths fail.

Public YouTube HTML is not a stable API. Consent pages, hosting-IP blocks, changed layouts, rate limits, and unavailable metadata can prevent fast discovery. The bot does not bypass these: it backs off exponentially up to one hour, records an audit entry and exposes the affected channel count in `/youtube status`. API polling/push remain enabled. A successful page check reports whether the page could be parsed, not proof that YouTube exposed every stream. Public premieres may be classified as live broadcasts by YouTube.

Google's quota documentation, checked October 9, 2026, lists a separate default **100 search calls/day**, plus **10,000 daily units for other endpoints**. This update corrects the previous shared 100-units-per-search accounting. Local defaults use 80 search calls and 9,000 other units, leaving headroom. Always check the actual limits for your project in Google Cloud.

| Optional variable | Default | Purpose |
| --- | --- | --- |
| `AUTO_LIVE_DISCOVERY` | `true` | Set `false` to disable public-page discovery |
| `LIVE_DISCOVERY_SECONDS` | `120` | Public live-page check interval, minimum 60 seconds |
| `POLL_SECONDS` | `300` | Minimum upload API poll interval; scales with channel count |
| `LIVE_CHECK_SECONDS` | `60` | Known-stream API check interval |
| `YOUTUBE_DAILY_BUDGET` | `9000` | Local daily cap for non-search YouTube API units |
| `LIVE_SEARCH_DAILY_CALLS` | `80` | Local search-call cap; `0` disables API search |
| `MAX_CHANNELS` | `25` | All registrations, including pending and paused |

At 80 search calls/day, API search alone runs about every 18 minutes with one approved channel, or every 54 minutes with three. Automatic public live-page checks run independently every two minutes when accessible. Larger servers and slow requests may increase actual latency. If the old `LIVE_SEARCH_DAILY_BUDGET` is set, its value is conservatively translated to calls by dividing by 100, unless the new variable is explicitly set; e.g. `4000` becomes 40 calls. Existing approvals and deduplication records are preserved by an automatic SQLite migration, including conversion of historical search accounting.

Accounting resets at midnight Pacific Time. Local limits do not count other apps using the same Cloud project. Exceeding API quota delays verification and delivery even if page discovery works. Upload polling only examines the latest 50 uploads; long downtime or high volume can miss content. Candidate hints expire after 30 days without a confirming response. Streams already live before approval/resume and ended streams are intentionally skipped.

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
- **No live alert:** inspect `/youtube status` for automatic discovery backoff and API quota. `/youtube audit` reports failed public checks. `/youtube watch` remains an optional fallback if your host cannot access the public page. Streams already live at approval/resume are not backfilled.
- **HTTP `starting`/503:** Discord is not ready, startup checks failed, or the worker has not completed a pass recently. Check the application log.

## Development and validation

```bash
npm ci
npm test
npm run check
npm audit --omit=dev
```

Automated tests use temporary databases and mocked Discord/YouTube responses, plus a real local HTTP callback server. They do not use private credentials or send real Discord messages. Complete the live smoke test in the installation section after deployment.

Implementation references: [YouTube current quotas](https://developers.google.com/youtube/v3/determine_quota_cost), [YouTube push notifications](https://developers.google.com/youtube/v3/guides/push_notifications), [channels.list](https://developers.google.com/youtube/v3/docs/channels/list), [playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list), [videos.list](https://developers.google.com/youtube/v3/docs/videos/list), [search.list](https://developers.google.com/youtube/v3/docs/search/list), [Discord messages](https://docs.discord.com/developers/resources/message).

## Upgrade from 1.0.0 on the existing server

Keep the cPanel root as `discord-bot`. Save any environment changes, and **Stop** the app before updating, so the old process cannot run against the new database schema. From the activated cPanel Node environment:

```bash
cd /home2/taskoraagent/discord-bot
git pull --ff-only origin main
npm ci --omit=dev
npm test
```

Then click **Start** (or **Restart**) in cPanel. Defaults enable the improvement; no additional secrets or environment variables are required. Existing approved channels remain approved. Run `/youtube status` and confirm `Automatic live discovery: every 120 seconds` appears. Do not run the old version against a migrated database: restore a pre-upgrade database backup first if rolling back.
