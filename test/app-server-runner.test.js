import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAppServerRunner } from "../src/app-server-runner.js";

function config() {
  return {
    dryRun: true,
    logDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-test-")),
    workdir: "/tmp",
    codexBin: "codex",
    codexDisableFeatures: [],
    timeoutMs: 100,
    logRetentionDays: 30
  };
}

function target(sessionKey) {
  return {
    channel: `C-${sessionKey}`,
    threadTs: `T-${sessionKey}`,
    sessionKey
  };
}

test("dry-run sends output to the matching Slack session target", async () => {
  const outputs = [];
  const lifecycle = [];
  const runner = new CodexAppServerRunner(config(), async (outTarget, text) => {
    outputs.push({ outTarget, text });
  }, async (outTarget, state) => {
    lifecycle.push({ outTarget, state });
  });

  await runner.send("from a", target("a"));
  await runner.send("from b", target("b"));

  assert.deepEqual(outputs.map((item) => item.outTarget.sessionKey), ["a", "b"]);
  assert.deepEqual(outputs.map((item) => item.text), [
    "DRY RUN app-server input:\nfrom a",
    "DRY RUN app-server input:\nfrom b"
  ]);
  assert.deepEqual(lifecycle.map((item) => `${item.outTarget.sessionKey}:${item.state}`), [
    "a:working",
    "a:completed",
    "b:working",
    "b:completed"
  ]);
});

test("turn output is routed by turn id to its owning session", async () => {
  const outputs = [];
  const lifecycle = [];
  const runner = new CodexAppServerRunner(config(), async (outTarget, text) => {
    outputs.push({ outTarget, text });
  }, async (outTarget, state) => {
    lifecycle.push({ outTarget, state });
  });
  const a = runner.getSession(target("a"));
  const b = runner.getSession(target("b"));
  a.threadId = "thread-a";
  b.threadId = "thread-b";
  a.activeTurnId = "turn-a";
  b.activeTurnId = "turn-b";
  runner.threadToSession.set("thread-a", "a");
  runner.threadToSession.set("thread-b", "b");
  runner.turnToSession.set("turn-a", "a");
  runner.turnToSession.set("turn-b", "b");

  runner.handleMessage({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-a", turnId: "turn-a", delta: "hello a" }
  });
  runner.handleMessage({
    method: "turn/completed",
    params: { threadId: "thread-a", turnId: "turn-a", turn: { id: "turn-a", status: "completed" } }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].outTarget.sessionKey, "a");
  assert.equal(outputs[0].text, "hello a");
  assert.deepEqual(lifecycle.map((item) => `${item.outTarget.sessionKey}:${item.state}`), ["a:completed"]);
  assert.equal(a.activeTurnId, "");
  assert.equal(b.activeTurnId, "turn-b");
});

test("approval request is stored only on the owning session", async () => {
  const runner = new CodexAppServerRunner(config(), async () => {});
  const a = runner.getSession(target("a"));
  const b = runner.getSession(target("b"));
  a.threadId = "thread-a";
  b.threadId = "thread-b";
  runner.threadToSession.set("thread-a", "a");
  runner.threadToSession.set("thread-b", "b");

  runner.handleMessage({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-a", turnId: "turn-a", command: "date" }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(a.pendingApproval?.id, 42);
  assert.equal(b.pendingApproval, null);
});
