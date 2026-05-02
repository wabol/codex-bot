import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function intEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function loadConfig() {
  const home = os.homedir();
  const projectDir = path.resolve(new URL(".", import.meta.url).pathname, "..");
  const envPath = process.env.CODEX_BOT_ENV || path.join(projectDir, ".env");
  loadDotEnv(envPath);
  const openclawConfigPath = process.env.OPENCLAW_CONFIG || "";
  const openclaw = openclawConfigPath && fs.existsSync(openclawConfigPath) ? readJson(openclawConfigPath) : {};
  const slack = openclaw.channels?.slack || {};

  const allowedChannels = splitList(process.env.CODEX_BOT_ALLOWED_CHANNELS);
  const allowedUsers = splitList(process.env.CODEX_BOT_ALLOWED_USERS);

  return {
    envPath,
    openclawConfigPath,
    slackBotToken: process.env.SLACK_BOT_TOKEN || "",
    slackAppToken: process.env.SLACK_APP_TOKEN || "",
    allowedChannels: new Set(allowedChannels),
    allowedUsers: new Set(allowedUsers),
    allowAllUsers: boolEnv("CODEX_BOT_ALLOW_ALL_USERS", false),
    requireMention: boolEnv("CODEX_BOT_REQUIRE_MENTION", true),
    enableChannelPrefix: boolEnv("CODEX_BOT_ENABLE_CHANNEL_PREFIX", true),
    workingReaction: process.env.CODEX_BOT_WORKING_REACTION || "eyes",
    activeReaction: process.env.CODEX_BOT_ACTIVE_REACTION || "hourglass_flowing_sand",
    doneReaction: process.env.CODEX_BOT_DONE_REACTION || "white_check_mark",
    errorReaction: process.env.CODEX_BOT_ERROR_REACTION || "x",
    workdir: process.env.CODEX_BOT_WORKDIR || home,
    codexBin: process.env.CODEX_BIN || "codex",
    codexModel: process.env.CODEX_BOT_MODEL || "",
    codexDisableFeatures: splitList(process.env.CODEX_BOT_DISABLE_FEATURES || "apps,plugins"),
    dryRun: boolEnv("CODEX_BOT_DRY_RUN", false),
    timeoutMs: intEnv("CODEX_BOT_TIMEOUT_MS", 30 * 60 * 1000),
    maxSlackChars: intEnv("CODEX_BOT_MAX_SLACK_CHARS", 3500),
    logRetentionDays: intEnv("CODEX_BOT_LOG_RETENTION_DAYS", 30),
    sessionRetentionDays: nonNegativeIntEnv("CODEX_BOT_SESSION_RETENTION_DAYS", 180),
    logDir: process.env.CODEX_BOT_LOG_DIR || path.join(projectDir, "logs")
  };
}

export function validateConfig(config) {
  const missing = [];
  if (!config.slackBotToken) missing.push("SLACK_BOT_TOKEN");
  if (!config.slackAppToken) missing.push("SLACK_APP_TOKEN");
  if (config.slackBotToken && !config.slackBotToken.startsWith("xoxb-")) missing.push("SLACK_BOT_TOKEN must start with xoxb-");
  if (config.slackAppToken && !config.slackAppToken.startsWith("xapp-")) missing.push("SLACK_APP_TOKEN must start with xapp-");
  if (config.slackBotToken.includes("your-new") || config.slackAppToken.includes("your-new")) {
    missing.push(`replace placeholder tokens in ${config.envPath}`);
  }
  if (missing.length) {
    throw new Error(`Missing required config: ${missing.join(", ")}`);
  }
}
