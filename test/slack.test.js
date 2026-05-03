import test from "node:test";
import assert from "node:assert/strict";
import { SlackClient, chunkText } from "../src/slack.js";

test("Slack API calls time out", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    await new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  try {
    const slack = new SlackClient({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      timeoutMs: 1
    });

    await assert.rejects(() => slack.authTest(), /timed out after 1ms/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chunkText preserves short output", () => {
  assert.deepEqual(chunkText("hello", 10), ["hello"]);
});
