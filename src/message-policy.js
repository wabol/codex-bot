export function isAuthorized(event, config) {
  if (event.bot_id || event.subtype === "bot_message") return false;

  const allowAllUsers = Boolean(config.allowAllUsers);
  if (!allowAllUsers) {
    if (config.allowedUsers.size === 0) return false;
    if (!config.allowedUsers.has(event.user)) return false;
  }

  if (event.channel_type === "im") return true;
  if (config.allowedChannels.size === 0) return true;
  return config.allowedChannels.has(event.channel);
}

export function shouldHandle(event, botUserId, config) {
  const text = String(event.text || "");
  if (event.channel_type === "im") return true;
  if (botUserId && text.includes(`<@${botUserId}>`)) return true;
  if (!config.requireMention && config.allowedChannels.has(event.channel)) return true;
  return Boolean(config.enableChannelPrefix && /^codex[:,]\s+/i.test(text));
}

export function commandName(text) {
  const trimmed = text.trim();
  const first = trimmed.split(/\s+/, 1)[0].toLowerCase();
  if (first.startsWith("/")) return first;
  if ([
    "help",
    "status",
    "where",
    "id",
    "cancel",
    "interrupt",
    "stop",
    "restart",
    "reset",
    "screen",
    "approve",
    "deny"
  ].includes(first)) return `/${first}`;
  return "";
}
