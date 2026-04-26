# Codex Bot Maintenance Skill

Use this skill when changing or debugging this repository. The project is a Slack-to-local-Codex bridge.

## Purpose

The bot lets trusted Slack users operate local Codex from phone or desktop without OpenClaw. It has no heartbeat, cron, or proactive model calls. Codex runs only after an authorized Slack message.

## Architecture

- Entry point: `src/main.js`
- Slack client: `src/slack.js`
- Codex runner: `src/app-server-runner.js`
- Slack session key: `src/session-key.js`
- Service: `systemd/codex-bot.service`
- Runtime env: `.env`

The runner uses:

```bash
codex app-server --listen stdio:// --disable apps --disable plugins
```

Communication with Codex is newline-delimited JSON-RPC over stdio. Do not go back to parsing Codex TUI output unless app-server breaks badly; TUI output includes redraw noise and is brittle.

## Session Model

Slack thread identity maps to Codex thread identity:

```text
Slack channel + Slack thread_ts -> one Codex app-server thread
```

In DMs, each new top-level DM message gets its own Codex session. Replies inside that Slack thread reuse the same Codex session. Commands such as `reset`, `approve`, `deny`, `screen`, and `cancel` are scoped to the current Slack thread, except `stop`, which stops the shared app-server process.

Session state is saved at:

```text
logs/appserver/session.json
```

The format is versioned. A legacy single-thread `threadId` state is migrated lazily into the first new Slack session.

## Slack Behavior

Authorized messages are acknowledged with reactions:

- `eyes`: received and accepted for work
- `hourglass_flowing_sand`: Codex turn is active
- `white_check_mark`: turn completed
- `x`: turn failed

These are configured by:

```env
CODEX_BOT_WORKING_REACTION=eyes
CODEX_BOT_ACTIVE_REACTION=hourglass_flowing_sand
CODEX_BOT_DONE_REACTION=white_check_mark
CODEX_BOT_ERROR_REACTION=x
```

Slack does not expose a modern Socket Mode typing indicator API equivalent to legacy RTM typing. Prefer reaction lifecycle over fake "working" messages because it does not pollute threads.

Required Slack app setup:

- Socket Mode enabled
- App-level token with `connections:write`
- Bot token scopes include `chat:write` and `reactions:write`
- Event subscriptions include `message.im` and `app_mention`
- Add `message.channels` only if prefix-only channel messages are needed

Channel use is safest with `@Codex Bot ...`. Prefix-only `codex:` requires message events and broader channel access.

## Authorization

Trusted Slack users are configured in `.env`:

```env
CODEX_BOT_ALLOWED_USERS=U12345678,U23456789
```

If `CODEX_BOT_ALLOWED_USERS` is set and `CODEX_BOT_ALLOWED_CHANNELS` is empty, allowed users can use the bot in any channel where the bot is present, but channel messages still require a mention by default.

Adding users grants them the ability to drive local Codex on this machine. Only add trusted Slack user IDs.

## Safety Boundaries

The Codex thread uses:

- Approval policy: `on-request`
- Sandbox: `workspace-write`
- Disabled features by default: `apps,plugins`

Keep `apps,plugins` disabled unless there is a specific need and a successful test. It avoids Codex app/plugin startup delays and is unnecessary because Slack transport is handled by this bot.

Never use:

```bash
--dangerously-bypass-approvals-and-sandbox
```

for the Slack bot.

## Single Instance Lock

The bot writes:

```text
logs/codex-bot.pid
```

This prevents accidental second bot instances from also connecting to Slack Socket Mode. Socket Mode can distribute events across active connections, so duplicate bot processes cause confusing behavior.

If startup fails with a lock error, first check whether the service is running:

```bash
systemctl --user status codex-bot.service --no-pager
```

Only remove the lock after confirming no bot is running:

```bash
pgrep -af 'node src/main.js|codex app-server|npm start'
```

## Logs

Raw app-server event logs:

```text
logs/appserver/appserver-*.jsonl
```

Old terminal fallback logs:

```text
logs/terminal-*.log
```

Logs are cleaned on runner startup according to:

```env
CODEX_BOT_LOG_RETENTION_DAYS=30
```

The JSONL logs may contain prompts, file paths, command output, and approval details. Do not paste them externally without review.

## Common Commands

Check syntax:

```bash
npm run check
```

Run tests:

```bash
npm test
```

Validate Slack credentials:

```bash
npm run validate:slack
```

Restart service:

```bash
systemctl --user restart codex-bot.service
```

Inspect service:

```bash
systemctl --user status codex-bot.service --no-pager
journalctl --user -u codex-bot.service -n 50 --no-pager
```

Confirm service is not dry-run:

```bash
tr '\0' '\n' < /proc/$(systemctl --user show codex-bot.service -p MainPID --value)/environ | grep CODEX_BOT_DRY_RUN
```

## Verification After Changes

For small code changes:

```bash
npm run check
npm test
systemctl --user restart codex-bot.service
systemctl --user status codex-bot.service --no-pager
```

For Slack behavior changes, also run:

```bash
npm run validate:slack
journalctl --user -u codex-bot.service -n 50 --no-pager
```

For app-server routing changes, verify:

- Two different Slack thread keys create different Codex thread IDs.
- A reply inside the same Slack thread reuses the same Codex thread.
- Approval requests are routed only to the originating Slack thread.
- `reset` only resets the current Slack thread session.

Existing tests in `test/app-server-runner.test.js` and `test/session-key.test.js` should be extended for session routing or lifecycle changes.

## Known Pitfalls

- If Slack replies say `DRY RUN`, a duplicate dry-run bot may be connected. Stop the user service, kill leftovers, clear stale appserver session state, then restart.
- If reactions do not appear, check for missing `reactions:write` scope and reinstall the Slack app.
- If Slack events seem split or missing, check for duplicate Socket Mode connections.
- If app-server hangs after a tool approval or command, inspect `logs/appserver/*.jsonl` for pending server requests.
- If users report "wrong context", check the Slack thread they replied in and inspect `logs/appserver/session.json`.

## Design Preference

Prefer structured app-server events over terminal/TUI bridging. Prefer reactions over extra progress messages. Keep features narrowly scoped and avoid broad filesystem or approval bypasses.
