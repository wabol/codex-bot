export function slackSessionKey(event) {
  if (event.channel_type === "im") return `dm:${event.channel}:thread:${event.thread_ts || event.ts}`;
  return `channel:${event.channel}:thread:${event.thread_ts || event.ts}`;
}
