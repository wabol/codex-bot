export class SlackClient {
  constructor({ botToken, appToken }) {
    this.botToken = botToken;
    this.appToken = appToken;
  }

  async api(method, payload = {}) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (value != null) body.set(key, String(value));
    }
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Slack API ${method} returned non-JSON response: ${text.slice(0, 200)}`);
    }
    if (!parsed.ok) {
      throw new Error(`Slack API ${method} failed: ${parsed.error || text}`);
    }
    return parsed;
  }

  async appApi(method, payload = {}) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (value != null) body.set(key, String(value));
    }
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    const parsed = await response.json();
    if (!parsed.ok) throw new Error(`Slack app API ${method} failed: ${parsed.error}`);
    return parsed;
  }

  async openSocketUrl() {
    const result = await this.appApi("apps.connections.open");
    return result.url;
  }

  async authTest() {
    return this.api("auth.test");
  }

  async postMessage({ channel, text, threadTs }) {
    return this.api("chat.postMessage", {
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {})
    });
  }

  async postChunks({ channel, text, threadTs, maxChars }) {
    const chunks = chunkText(text, maxChars);
    for (const chunk of chunks) {
      await this.postMessage({ channel, text: chunk, threadTs });
    }
  }

  async addReaction({ channel, timestamp, name }) {
    try {
      return await this.api("reactions.add", {
        channel,
        timestamp,
        name
      });
    } catch (error) {
      if (String(error.message || error).includes("already_reacted")) return null;
      throw error;
    }
  }

  async removeReaction({ channel, timestamp, name }) {
    try {
      return await this.api("reactions.remove", {
        channel,
        timestamp,
        name
      });
    } catch (error) {
      if (String(error.message || error).includes("no_reaction")) return null;
      throw error;
    }
  }
}

export function chunkText(text, maxChars) {
  const normalized = String(text || "").trim() || "(no output)";
  if (normalized.length <= maxChars) return [normalized];
  const chunks = [];
  let rest = normalized;
  while (rest.length > maxChars) {
    let idx = rest.lastIndexOf("\n", maxChars);
    if (idx < maxChars * 0.5) idx = maxChars;
    chunks.push(rest.slice(0, idx));
    rest = rest.slice(idx).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function stripBotMention(text, botUserId) {
  return String(text || "")
    .replace(new RegExp(`<@${botUserId}>`, "g"), "")
    .trim();
}
