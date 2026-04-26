import test from "node:test";
import assert from "node:assert/strict";
import { slackSessionKey } from "../src/session-key.js";

test("uses Slack thread as DM session key", () => {
  assert.equal(slackSessionKey({
    channel_type: "im",
    user: "U123",
    channel: "D123",
    ts: "100.1"
  }), "dm:D123:thread:100.1");
});

test("uses Slack parent thread as DM session key", () => {
  assert.equal(slackSessionKey({
    channel_type: "im",
    user: "U123",
    channel: "D123",
    thread_ts: "100.1",
    ts: "100.2"
  }), "dm:D123:thread:100.1");
});

test("uses Slack thread as channel session key", () => {
  assert.equal(slackSessionKey({
    channel_type: "channel",
    user: "U123",
    channel: "C123",
    thread_ts: "100.1",
    ts: "100.2"
  }), "channel:C123:thread:100.1");
});

test("uses message ts as root channel session key", () => {
  assert.equal(slackSessionKey({
    channel_type: "channel",
    user: "U123",
    channel: "C123",
    ts: "100.2"
  }), "channel:C123:thread:100.2");
});
