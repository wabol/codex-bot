#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadConfig, validateConfig } from "./config.js";
import { CodexAppServerRunner } from "./app-server-runner.js";
import { commandName, isAuthorized, shouldHandle } from "./message-policy.js";
import { slackSessionKey } from "./session-key.js";
import { SlackClient, stripBotMention } from "./slack.js";

const config = loadConfig();
validateConfig(config);
const lockFile = acquireSingleInstance(config);

const slack = new SlackClient({
  botToken: config.slackBotToken,
  appToken: config.slackAppToken,
  timeoutMs: config.slackApiTimeoutMs
});
const runner = new CodexAppServerRunner(config, async (target, text) => {
  await slack.postChunks({
    channel: target.channel,
    threadTs: target.threadTs,
    text,
    maxChars: config.maxSlackChars
  });
}, async (target, state) => {
  await updateWorkReaction(target, state);
});

let botUserId = "";
let socket = null;
let reconnectTimer = null;
let reconnectDelayMs = 5000;
let shuttingDown = false;

function log(message, extra = "") {
  const suffix = extra ? ` ${extra}` : "";
  console.log(`${new Date().toISOString()} ${message}${suffix}`);
}

async function handleCommand(event, text) {
  const cmd = commandName(text);
  if (cmd === "/help") {
    await reply(event, [
      "Codex Bot Help",
      "",
      "Send any normal message in DM to run Codex.",
      "In a channel, mention this bot or start with `codex:`.",
      "",
      "Commands:",
      "`help` - show this help",
      "`status` - show app-server status",
      "`where` - show Codex working directory",
      "`id` - show your Slack user/channel ids",
      "`screen` - show recent Codex replies",
      "`cancel` or `interrupt` - interrupt the active Codex turn",
      "`approve` - approve a pending Codex request",
      "`deny` - deny a pending Codex request",
      "`restart` or `reset` - start a fresh Codex thread for this Slack session",
      "`stop` - stop app-server",
      "",
      "Session behavior:",
      "Each Slack thread, including DM threads, gets its own persistent Codex thread.",
      "Later replies in that Slack thread reuse the same Codex thread.",
      "",
      "Examples:",
      "`status`",
      "`screen`",
      "`approve`",
      "`Summarize ~/workspace/codex-bot`",
      "`codex: check git status`"
    ].join("\n"));
    return true;
  }
  if (cmd === "/status") {
    await reply(event, `codex-bot ok\nrunner: ${runner.status(eventTarget(event))}\nworkdir: ${config.workdir}\ndryRun: ${config.dryRun}`);
    return true;
  }
  if (cmd === "/where") {
    await reply(event, config.workdir);
    return true;
  }
  if (cmd === "/id") {
    await reply(event, `user=${event.user}\nchannel=${event.channel}\nchannel_type=${event.channel_type || ""}`);
    return true;
  }
  if (cmd === "/screen") {
    await reply(event, runner.screen(eventTarget(event)));
    return true;
  }
  if (cmd === "/cancel" || cmd === "/interrupt") {
    await reply(event, await runner.interrupt(eventTarget(event)) ? "Interrupt requested." : "No active Codex turn is running in this Slack session.");
    return true;
  }
  if (cmd === "/approve") {
    const target = eventTarget(event);
    if (!runner.hasPendingApproval(target) && !isExplicitSlashCommand(text)) return false;
    await runner.approve(target);
    return true;
  }
  if (cmd === "/deny") {
    const target = eventTarget(event);
    if (!runner.hasPendingApproval(target) && !isExplicitSlashCommand(text)) return false;
    await runner.deny(target);
    return true;
  }
  if (cmd === "/restart" || cmd === "/reset") {
    await runner.restart(eventTarget(event));
    return true;
  }
  if (cmd === "/stop") {
    await reply(event, await runner.stop() ? "App-server stop requested." : "No Codex app-server is running.");
    return true;
  }
  return false;
}

function isExplicitSlashCommand(text) {
  const trimmed = String(text || "").trim();
  return trimmed.startsWith("/") || (trimmed.startsWith("`/") && trimmed.endsWith("`"));
}

function eventTarget(event) {
  return {
    channel: event.channel,
    threadTs: event.thread_ts || event.ts,
    messageTs: event.ts,
    sessionKey: slackSessionKey(event)
  };
}

async function reply(event, text) {
  await slack.postChunks({
    channel: event.channel,
    threadTs: event.thread_ts || event.ts,
    text,
    maxChars: config.maxSlackChars
  });
}

async function acknowledgeWork(event) {
  if (!config.workingReaction) return;
  try {
    await slack.addReaction({
      channel: event.channel,
      timestamp: event.ts,
      name: config.workingReaction
    });
  } catch (error) {
    log("reaction failed", error.message || String(error));
  }
}

async function updateWorkReaction(target, state) {
  if (!target?.channel || !target?.messageTs) return;
  try {
    if (state === "working") {
      if (config.activeReaction) {
        await slack.addReaction({
          channel: target.channel,
          timestamp: target.messageTs,
          name: config.activeReaction
        });
      }
      return;
    }

    if (config.activeReaction) {
      await slack.removeReaction({
        channel: target.channel,
        timestamp: target.messageTs,
        name: config.activeReaction
      });
    }
    const finalReaction = state === "failed" ? config.errorReaction : config.doneReaction;
    if (finalReaction) {
      await slack.addReaction({
        channel: target.channel,
        timestamp: target.messageTs,
        name: finalReaction
      });
    }
  } catch (error) {
    log("work reaction update failed", error.message || String(error));
  }
}

async function handleMessage(event) {
  log("message event", `type=${event.type} channel=${event.channel} user=${event.user} channel_type=${event.channel_type || ""}`);
  if (!isAuthorized(event, config) || !shouldHandle(event, botUserId, config)) return;
  const rawText = stripBotMention(event.text, botUserId).replace(/^codex[:,]\s+/i, "").trim();
  if (!rawText) return;
  if (await handleCommand(event, rawText)) return;

  try {
    acknowledgeWork(event);
    await runner.send(rawText, eventTarget(event));
  } catch (error) {
    await reply(event, `Codex failed:\n${error.message || error}`);
  }
}

async function handleEnvelope(envelope) {
  if (envelope.type !== "events_api") return;
  const event = envelope.payload?.event;
  if (!event) return;
  if (event.type === "message" || event.type === "app_mention") {
    await handleMessage(event);
  }
}

function connectSocket(url) {
  socket = new WebSocket(url);
  socket.addEventListener("open", () => {
    reconnectDelayMs = 5000;
    log("slack socket connected");
  });
  socket.addEventListener("message", async (message) => {
    let envelope;
    try {
      envelope = JSON.parse(message.data);
    } catch (error) {
      log("invalid socket message", String(error));
      return;
    }
    if (envelope.envelope_id) {
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }
    try {
      await handleEnvelope(envelope);
    } catch (error) {
      log("handler error", error.stack || String(error));
    }
  });
  socket.addEventListener("close", async (event) => {
    log("slack socket closed", `code=${event.code}`);
    scheduleReconnect();
  });
  socket.addEventListener("error", (event) => {
    log("slack socket error", event.message || "");
  });
}

async function start() {
  const auth = await slack.authTest();
  botUserId = auth.user_id;
  log("slack auth ok", `bot=${botUserId}`);
  const url = await slack.openSocketUrl();
  connectSocket(url);
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  const delay = reconnectDelayMs;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (shuttingDown) return;
    try {
      await start();
    } catch (error) {
      log("slack reconnect failed", error.stack || String(error));
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000);
      scheduleReconnect();
    }
  }, delay);
  reconnectTimer.unref?.();
}

async function shutdown(signal) {
  shuttingDown = true;
  log("shutdown requested", signal);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  releaseSingleInstance(lockFile);
  await runner.stop();
  socket?.close();
  process.exit(0);
}
process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    log("shutdown error", error.stack || String(error));
    process.exit(1);
  });
});
process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    log("shutdown error", error.stack || String(error));
    process.exit(1);
  });
});
process.on("exit", () => {
  releaseSingleInstance(lockFile);
});

try {
  await start();
} catch (error) {
  releaseSingleInstance(lockFile);
  throw error;
}

function acquireSingleInstance(config) {
  fs.mkdirSync(config.logDir, { recursive: true });
  const file = path.join(config.logDir, "codex-bot.pid");
  if (fs.existsSync(file)) {
    let lock = null;
    try {
      lock = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      lock = null;
    }
    if (lock?.pid && isProcessAlive(lock.pid)) {
      console.error(`codex-bot lock exists at ${file} (${JSON.stringify(lock)})`);
      process.exit(1);
    }
    console.error(`removing stale codex-bot lock: ${file}`);
    fs.rmSync(file, { force: true });
  }
  fs.writeFileSync(file, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString()
  }) + "\n", { flag: "wx" });
  return file;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseSingleInstance(file) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, "utf8"));
    if (lock.pid === process.pid) fs.rmSync(file, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}
