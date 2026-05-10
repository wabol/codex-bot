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
  const command = stripInlineCode(trimmed).toLowerCase();
  if (command === "approve all") return "/approve";
  if (command === "deny all") return "/deny";
  if (command.startsWith("/")) return command;
  if (/\s/.test(command)) return "";
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
  ].includes(command)) return `/${command}`;
  return "";
}

function stripInlineCode(value) {
  const text = String(value || "");
  if (text.length >= 2 && text.startsWith("`") && text.endsWith("`")) {
    return text.slice(1, -1);
  }
  return text;
}
