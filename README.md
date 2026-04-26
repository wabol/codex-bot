# codex-bot

A small Slack bot that lets you talk to local Codex from Slack.

It is useful when you want to start or continue Codex work from a phone or another computer, while the actual Codex process still runs on your own machine.

The bot only starts Codex after an allowed Slack message. It does not run cron jobs, heartbeat checks, or background model calls.

## What It Does

- Listens to Slack with Socket Mode.
- Sends authorized Slack messages to `codex app-server`.
- Keeps one Codex session for each Slack thread.
- Supports Codex approval requests with `approve` and `deny`.
- Adds Slack reactions while Codex is working.
- Stores local app-server logs under `logs/`.

## Requirements

- Node.js 22 or newer.
- Codex CLI installed on the host machine.
- A dedicated Slack app for this bot.

Do not reuse an existing OpenClaw Slack app. Slack can split Socket Mode events across active listeners, so two bots using the same app can miss messages.

## Slack App Setup

Create a Slack app and enable Socket Mode.

App-level token scope:

- `connections:write`

Bot token scopes:

- `chat:write`
- `reactions:write`

Event subscriptions:

- `message.im` for direct messages
- `app_mention` for channel mentions
- `message.channels` only if you want `codex:` prefix messages in channels without mentioning the bot

Install the Slack app to your workspace, then copy the bot token and app token into `.env`.

## Configure

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

For personal use, set an allowlist:

```bash
CODEX_BOT_ALLOWED_USERS=U1234567890
```

Leave `CODEX_BOT_WORKDIR` empty to run Codex from your home directory.

## Run

```bash
npm install
npm start
```

Dry run mode starts the Slack bot without calling Codex:

```bash
CODEX_BOT_DRY_RUN=true npm start
```

## Install As A User Service

```bash
scripts/install-user-service.sh
systemctl --user start codex-bot.service
```

Check logs:

```bash
journalctl --user -u codex-bot.service -f
```

## Slack Usage

In a DM, send a normal message to the bot.

In a channel, mention the bot:

```text
@Codex Bot check this repository
```

Or use the prefix if channel prefix messages are enabled:

```text
codex: check git status
```

Each Slack thread maps to one Codex session. Replies in the same Slack thread continue the same Codex session. A new DM thread starts a new Codex session.

## Commands

- `help` - show bot help
- `status` - show runner status
- `where` - show Codex working directory
- `id` - show your Slack user and channel ids
- `screen` - show recent Codex replies
- `cancel` or `interrupt` - interrupt the active turn
- `approve` - approve a pending Codex request
- `deny` - deny a pending Codex request
- `restart` or `reset` - start a fresh Codex thread for this Slack session
- `stop` - stop the Codex app-server process

## Safety Notes

This project is designed to keep personal runtime data out of git:

- `.env` contains real Slack tokens and must stay private.
- `logs/` contains app-server logs, session state, and pid files.
- `node_modules/` is not committed.
- `*.log` files are ignored.

Before publishing, check:

```bash
git status --short --ignored
git ls-files
```
