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
    logRetentionDays: 30,
    sessionRetentionDays: 180
  };
}

function liveConfig() {
  return {
    ...config(),
    dryRun: false
  };
}

function target(sessionKey) {
  return {
    channel: `C-${sessionKey}`,
    threadTs: `T-${sessionKey}`,
    sessionKey
  };
}

function writeState(logDir, sessions) {
  const file = path.join(logDir, "appserver", "session.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 2,
    updatedAt: new Date().toISOString(),
    workdir: "/tmp",
    sessions
  }, null, 2));
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

  assert.equal(a.pendingApprovals[0]?.id, 42);
  assert.equal(b.pendingApprovals.length, 0);
});

test("multiple approval requests are stored and approved together", async () => {
  const outputs = [];
  const writes = [];
  const runner = new CodexAppServerRunner(liveConfig(), async (outTarget, text) => {
    outputs.push({ outTarget, text });
  });
  const session = runner.getSession(target("a"));
  session.threadId = "thread-a";
  runner.threadToSession.set("thread-a", "a");
  runner.child = { stdin: { writable: true, write: (text) => writes.push(JSON.parse(text)) } };
  runner.ensureReady = async () => {};

  runner.handleMessage({
    id: 11,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-a", turnId: "turn-a", command: "codex --version" }
  });
  runner.handleMessage({
    id: 12,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-a", turnId: "turn-a", command: "command -v codex" }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.pendingApprovals.length, 2);

  await runner.approve(target("a"));

  assert.equal(session.pendingApprovals.length, 0);
  assert.deepEqual(writes, [
    { id: 11, result: { decision: "accept" } },
    { id: 12, result: { decision: "accept" } }
  ]);
  assert.equal(outputs.at(-1).text, "Approved 2 requests.");
});

test("hasPendingApproval reflects pending approval state", async () => {
  const runner = new CodexAppServerRunner(config(), async () => {});
  const session = runner.getSession(target("a"));
  session.threadId = "thread-a";
  runner.threadToSession.set("thread-a", "a");

  assert.equal(runner.hasPendingApproval(target("a")), false);

  runner.handleMessage({
    id: 21,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-a", turnId: "turn-a", command: "date" }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runner.hasPendingApproval(target("a")), true);
});

test("send failure reports failed lifecycle", async () => {
  const lifecycle = [];
  const runner = new CodexAppServerRunner(liveConfig(), async () => {}, async (outTarget, state) => {
    lifecycle.push({ outTarget, state });
  });
  runner.ensureReady = async () => {
    throw new Error("startup failed");
  };

  await assert.rejects(() => runner.send("hello", target("a")), /startup failed/);

  assert.deepEqual(lifecycle.map((item) => `${item.outTarget.sessionKey}:${item.state}`), [
    "a:working",
    "a:failed"
  ]);
});

test("outputs are queued per session instead of globally", async () => {
  let releaseA;
  const sent = [];
  const runner = new CodexAppServerRunner(config(), async (outTarget, text) => {
    sent.push(`${outTarget.sessionKey}:${text}`);
    if (outTarget.sessionKey === "a") {
      await new Promise((resolve) => {
        releaseA = resolve;
      });
    }
  });
  const a = runner.getSession(target("a"));
  const b = runner.getSession(target("b"));

  const emitA = runner.emit(a, "slow");
  await new Promise((resolve) => setImmediate(resolve));
  await runner.emit(b, "fast");

  assert.deepEqual(sent, ["a:slow", "b:fast"]);
  releaseA();
  await emitA;
});

test("approve deny and interrupt do not start app-server when there is no pending work", async () => {
  const outputs = [];
  const runner = new CodexAppServerRunner(liveConfig(), async (outTarget, text) => {
    outputs.push({ outTarget, text });
  });
  let started = false;
  runner.ensureReady = async () => {
    started = true;
  };

  await runner.approve(target("a"));
  await runner.deny(target("a"));
  const interrupted = await runner.interrupt(target("a"));

  assert.equal(started, false);
  assert.equal(interrupted, false);
  assert.deepEqual(outputs.map((item) => item.text), [
    "No approval request is pending in this Slack session.",
    "No approval request is pending in this Slack session."
  ]);
});

test("restored inactive sessions older than retention are pruned", () => {
  const cfg = config();
  const oldDate = new Date(Date.now() - 181 * 24 * 60 * 60 * 1000).toISOString();
  const freshDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  writeState(cfg.logDir, {
    old: {
      threadId: "thread-old",
      target: target("old"),
      updatedAt: oldDate
    },
    fresh: {
      threadId: "thread-fresh",
      target: target("fresh"),
      updatedAt: freshDate
    }
  });

  const runner = new CodexAppServerRunner(cfg, async () => {});

  assert.equal(runner.sessions.has("old"), false);
  assert.equal(runner.sessions.has("fresh"), true);
  assert.equal(runner.threadToSession.has("thread-old"), false);
  const saved = JSON.parse(fs.readFileSync(path.join(cfg.logDir, "appserver", "session.json"), "utf8"));
  assert.deepEqual(Object.keys(saved.sessions), ["fresh"]);
});

test("retention pruning preserves active and approval-pending sessions", () => {
  const runner = new CodexAppServerRunner(config(), async () => {});
  const active = runner.getSession(target("active"));
  const pending = runner.getSession(target("pending"));
  const oldTime = Date.now() - 181 * 24 * 60 * 60 * 1000;
  active.updatedAt = oldTime;
  active.threadId = "thread-active";
  active.activeTurnId = "turn-active";
  pending.updatedAt = oldTime;
  pending.threadId = "thread-pending";
  pending.pendingApprovals.push({ id: 1, method: "item/commandExecution/requestApproval", params: {} });

  assert.equal(runner.pruneInactiveSessions(), 0);
  assert.equal(runner.sessions.has("active"), true);
  assert.equal(runner.sessions.has("pending"), true);
});

test("session retention can be disabled with zero days", () => {
  const cfg = { ...config(), sessionRetentionDays: 0 };
  const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  writeState(cfg.logDir, {
    old: {
      threadId: "thread-old",
      target: target("old"),
      updatedAt: oldDate
    }
  });

  const runner = new CodexAppServerRunner(cfg, async () => {});

  assert.equal(runner.sessions.has("old"), true);
});

test("saveState preserves existing session updatedAt instead of refreshing every session", () => {
  const runner = new CodexAppServerRunner(config(), async () => {});
  const session = runner.getSession(target("recent"));
  const recentTime = Date.now() - 10 * 24 * 60 * 60 * 1000;
  session.updatedAt = recentTime;
  runner.saveState();

  const saved = JSON.parse(fs.readFileSync(runner.stateFile, "utf8"));

  assert.equal(saved.sessions.recent.updatedAt, new Date(recentTime).toISOString());
});
