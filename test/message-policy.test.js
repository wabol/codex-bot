import test from "node:test";
import assert from "node:assert/strict";
import { commandName, isAuthorized, shouldHandle } from "../src/message-policy.js";

function config(overrides = {}) {
  return {
    allowedUsers: new Set(["U_ALLOWED"]),
    allowedChannels: new Set(),
    allowAllUsers: false,
    requireMention: true,
    enableChannelPrefix: true,
    ...overrides
  };
}

test("authorization rejects all human users when allowlist is empty by default", () => {
  assert.equal(isAuthorized({
    type: "message",
    user: "U_ANY",
    channel: "D123",
    channel_type: "im"
  }, config({ allowedUsers: new Set() })), false);
});

test("authorization can explicitly allow all users", () => {
  assert.equal(isAuthorized({
    type: "message",
    user: "U_ANY",
    channel: "D123",
    channel_type: "im"
  }, config({ allowedUsers: new Set(), allowAllUsers: true })), true);
});

test("authorization rejects bot messages and users outside allowlist", () => {
  assert.equal(isAuthorized({
    type: "message",
    bot_id: "B123",
    user: "U_ALLOWED",
    channel: "D123",
    channel_type: "im"
  }, config()), false);

  assert.equal(isAuthorized({
    type: "message",
    user: "U_OTHER",
    channel: "D123",
    channel_type: "im"
  }, config()), false);
});

test("authorization limits channel messages when channel allowlist is configured", () => {
  const cfg = config({ allowedChannels: new Set(["C_ALLOWED"]) });
  assert.equal(isAuthorized({
    type: "message",
    user: "U_ALLOWED",
    channel: "C_ALLOWED",
    channel_type: "channel"
  }, cfg), true);
  assert.equal(isAuthorized({
    type: "message",
    user: "U_ALLOWED",
    channel: "C_OTHER",
    channel_type: "channel"
  }, cfg), false);
});

test("shouldHandle accepts DMs, mentions, allowed-channel ambient messages, and configured prefix", () => {
  assert.equal(shouldHandle({
    channel_type: "im",
    text: "hello"
  }, "B123", config()), true);

  assert.equal(shouldHandle({
    channel_type: "channel",
    channel: "C123",
    text: "<@B123> hello"
  }, "B123", config()), true);

  assert.equal(shouldHandle({
    channel_type: "channel",
    channel: "C_ALLOWED",
    text: "hello"
  }, "B123", config({
    allowedChannels: new Set(["C_ALLOWED"]),
    requireMention: false
  })), true);

  assert.equal(shouldHandle({
    channel_type: "channel",
    channel: "C123",
    text: "codex: hello"
  }, "B123", config()), true);
});

test("channel prefix can be disabled independently from mention handling", () => {
  assert.equal(shouldHandle({
    channel_type: "channel",
    channel: "C123",
    text: "codex: hello"
  }, "B123", config({ enableChannelPrefix: false })), false);

  assert.equal(shouldHandle({
    channel_type: "channel",
    channel: "C123",
    text: "<@B123> hello"
  }, "B123", config({ enableChannelPrefix: false })), true);
});

test("commandName maps supported bare commands", () => {
  assert.equal(commandName("approve"), "/approve");
  assert.equal(commandName("approve all"), "/approve");
  assert.equal(commandName("/deny"), "/deny");
  assert.equal(commandName("deny all"), "/deny");
  assert.equal(commandName("`approve`"), "/approve");
  assert.equal(commandName("`/deny`"), "/deny");
  assert.equal(commandName("approve this wording"), "");
  assert.equal(commandName("hello"), "");
});
