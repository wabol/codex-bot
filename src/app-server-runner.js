import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export class CodexAppServerRunner {
  constructor(config, outputSink, lifecycleSink = null) {
    this.config = config;
    this.outputSink = outputSink;
    this.lifecycleSink = lifecycleSink;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
    this.threadToSession = new Map();
    this.turnToSession = new Map();
    this.legacyThreadId = "";
    this.startedAt = 0;
    this.stdoutBuffer = "";
    this.outputQueue = Promise.resolve();
    this.stateFile = path.join(config.logDir, "appserver", "session.json");
    this.logPath = "";
    this.ready = null;
    this.restoreState();
  }

  status(target) {
    const session = target ? this.getSession(target) : null;
    const processState = this.child
      ? `app-server running since ${new Date(this.startedAt).toISOString()}`
      : "app-server stopped";
    if (!session) return `${processState}, sessions ${this.sessions.size}`;
    const active = session.activeTurnId ? `, active turn ${session.activeTurnId}` : "";
    const approval = session.pendingApproval ? ", approval pending" : "";
    return `${processState}, session ${session.key}, thread ${session.threadId || "none"}${active}${approval}`;
  }

  screen(target) {
    const session = this.getSession(target);
    return session.recentTranscript.slice(-12).join("\n\n") || "(no app-server transcript yet)";
  }

  async send(text, target) {
    const session = this.getSession(target);
    return this.withSessionQueue(session, async () => {
      await this.notifyLifecycle(session, "working");
      if (this.config.dryRun) {
        await this.emit(session, `DRY RUN app-server input:\n${text}`);
        await this.notifyLifecycle(session, "completed");
        return;
      }
      await this.ensureReady();
      await this.ensureThread(session);

      const input = [{ type: "text", text: String(text || ""), text_elements: [] }];
      if (session.activeTurnId) {
        await this.request("turn/steer", {
          threadId: session.threadId,
          expectedTurnId: session.activeTurnId,
          input
        });
        await this.emit(session, "Steered the active Codex turn.");
        return;
      }

      const response = await this.request("turn/start", {
        threadId: session.threadId,
        input,
        approvalPolicy: "on-request",
        approvalsReviewer: "user"
      }, session);
      const turnId = response?.turn?.id || "";
      if (turnId) {
        session.activeTurnId = turnId;
        this.turnToSession.set(turnId, session.key);
      }
      this.saveState();
    });
  }

  async approve(target) {
    const session = this.getSession(target);
    if (this.config.dryRun) {
      await this.emit(session, "DRY RUN approval.");
      return;
    }
    await this.ensureReady();
    if (!session.pendingApproval) {
      await this.emit(session, "No approval request is pending in this Slack session.");
      return;
    }
    const approval = session.pendingApproval;
    session.pendingApproval = null;
    this.sendResponse(approval.id, approvalResponse(approval));
    this.saveState();
    await this.emit(session, "Approval sent.");
  }

  async deny(target) {
    const session = this.getSession(target);
    if (this.config.dryRun) {
      await this.emit(session, "DRY RUN denial.");
      return;
    }
    await this.ensureReady();
    if (!session.pendingApproval) {
      await this.emit(session, "No approval request is pending in this Slack session.");
      return;
    }
    const approval = session.pendingApproval;
    session.pendingApproval = null;
    this.sendResponse(approval.id, denialResponse(approval));
    this.saveState();
    await this.emit(session, "Denial sent.");
  }

  async interrupt(target) {
    const session = this.getSession(target);
    await this.ensureReady();
    if (!session.threadId || !session.activeTurnId) return false;
    await this.request("turn/interrupt", {
      threadId: session.threadId,
      turnId: session.activeTurnId
    });
    return true;
  }

  async restart(target) {
    const session = this.getSession(target);
    session.threadId = "";
    session.threadReady = false;
    session.activeTurnId = "";
    session.pendingApproval = null;
    session.agentTextByTurn.clear();
    session.commandOutputByTurn.clear();
    session.recentTranscript = [];
    await this.ensureReady();
    await this.ensureThread(session);
    await this.emit(session, "Started a fresh Codex thread for this Slack session.");
  }

  async stop(message = "") {
    if (!this.child) return false;
    const child = this.child;
    if (message) await this.emitAll(message);
    return await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve(true);
      };
      const termTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best-effort shutdown.
        }
      }, 3000);
      const killTimer = setTimeout(done, 6000);
      child.once("close", done);
      child.kill("SIGTERM");
    });
  }

  async ensureReady() {
    if (this.config.dryRun) return;
    if (this.ready) return this.ready;
    this.ready = this.start();
    return this.ready;
  }

  async start() {
    cleanupOldLogs(this.config);
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    this.startedAt = Date.now();
    this.logPath = path.join(this.config.logDir, "appserver", `appserver-${this.startedAt}.jsonl`);

    const args = ["app-server", "--listen", "stdio://"];
    for (const feature of this.config.codexDisableFeatures || []) {
      args.push("--disable", feature);
    }
    if (this.config.codexModel) {
      args.push("-c", `model="${escapeTomlString(this.config.codexModel)}"`);
    }

    this.child = spawn(this.config.codexBin, args, {
      cwd: this.config.workdir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => this.logRaw({ direction: "stderr", text: truncateString(chunk) }));
    this.child.on("close", (code, signal) => {
      this.child = null;
      this.ready = null;
      this.rejectAll(new Error(`Codex app-server exited with code ${code}${signal ? ` signal ${signal}` : ""}`));
      for (const session of this.sessions.values()) {
        session.threadReady = false;
        session.activeTurnId = "";
        session.pendingApproval = null;
      }
      this.turnToSession.clear();
      this.emitAll(`Codex app-server exited with code ${code}${signal ? ` signal ${signal}` : ""}.`);
    });
    this.child.on("error", (error) => {
      this.child = null;
      this.ready = null;
      this.rejectAll(error);
    });

    await this.request("initialize", {
      clientInfo: { name: "codex-bot", title: null, version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    this.sendNotification("initialized");
  }

  async ensureThread(session) {
    if (session.threadId && session.threadReady) return;
    if (session.threadId) {
      try {
        await this.resumeThread(session);
        return;
      } catch (error) {
        this.logRaw({ direction: "internal", event: "resume-failed", sessionKey: session.key, error: error.message || String(error) });
        session.threadId = "";
        session.threadReady = false;
      }
    }
    await this.startThread(session);
  }

  async startThread(session) {
    const response = await this.request("thread/start", {
      cwd: this.config.workdir,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      experimentalRawEvents: false,
      persistExtendedHistory: true
    }, session);
    session.threadId = response?.thread?.id || "";
    session.threadReady = Boolean(session.threadId);
    if (session.threadId) this.threadToSession.set(session.threadId, session.key);
    this.saveState();
  }

  async resumeThread(session) {
    const response = await this.request("thread/resume", {
      threadId: session.threadId,
      cwd: this.config.workdir,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      excludeTurns: true,
      persistExtendedHistory: true
    }, session);
    session.threadId = response?.thread?.id || session.threadId;
    session.threadReady = true;
    if (session.threadId) this.threadToSession.set(session.threadId, session.key);
    this.saveState();
  }

  request(method, params, session = null) {
    const id = this.nextId++;
    const message = { id, method, params };
    return new Promise((resolve, reject) => {
      const timeoutMs = Number(this.config.timeoutMs) || 30 * 60 * 1000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, method, timer, session });
      try {
        this.write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  sendNotification(method, params) {
    this.write(params === undefined ? { method } : { method, params });
  }

  sendResponse(id, result) {
    this.write({ id, result });
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server is not writable");
    this.logRaw({ direction: "client", message });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newline;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.logRaw({ direction: "server-parse-error", line: truncateString(line), error: error.message });
        continue;
      }
      this.logRaw({ direction: "server", message: shrinkLogMessage(message) });
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        this.applyResponseState(pending, message.result);
        pending.resolve(message.result);
      }
      return;
    }

    const params = message.params || {};
    const session = this.findSession(params);
    switch (message.method) {
      case "thread/started":
        if (session && params.thread?.id) {
          session.threadId = params.thread.id;
          session.threadReady = true;
          this.threadToSession.set(session.threadId, session.key);
          this.saveState();
        }
        break;
      case "turn/started":
        if (session && params.turn?.id) {
          session.activeTurnId = params.turn.id;
          this.turnToSession.set(params.turn.id, session.key);
        }
        break;
      case "item/agentMessage/delta":
        if (session) session.agentTextByTurn.set(params.turnId, `${session.agentTextByTurn.get(params.turnId) || ""}${params.delta || ""}`);
        break;
      case "item/commandExecution/outputDelta":
        if (session) session.commandOutputByTurn.set(params.turnId, `${session.commandOutputByTurn.get(params.turnId) || ""}${params.delta || ""}`);
        break;
      case "item/completed":
        if (session) this.handleItemCompleted(session, params);
        break;
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
        if (session) this.handleApprovalRequest(session, message);
        break;
      case "turn/completed":
        if (session) this.handleTurnCompleted(session, params);
        break;
      case "error":
        this.emit(session, `Codex error:\n${params.error?.message || JSON.stringify(params.error || params)}`);
        this.notifyLifecycle(session, "failed");
        break;
      case "warning":
      case "guardianWarning":
      case "configWarning":
        this.emit(session, `Codex warning:\n${params.message || JSON.stringify(params)}`);
        break;
      default:
        break;
    }
  }

  applyResponseState(pending, result) {
    const session = pending.session;
    if (!session) return;
    if ((pending.method === "thread/start" || pending.method === "thread/resume") && result?.thread?.id) {
      session.threadId = result.thread.id;
      session.threadReady = true;
      this.threadToSession.set(session.threadId, session.key);
      this.saveState();
    }
    if (pending.method === "turn/start" && result?.turn?.id) {
      session.activeTurnId = result.turn.id;
      this.turnToSession.set(result.turn.id, session.key);
      this.saveState();
    }
  }

  handleItemCompleted(session, params) {
    const item = params.item || {};
    if (item.type === "agentMessage" && item.text) {
      session.agentTextByTurn.set(params.turnId, item.text);
    }
    if (item.type === "commandExecution" && item.aggregatedOutput) {
      session.commandOutputByTurn.set(params.turnId, item.aggregatedOutput);
    }
  }

  async handleApprovalRequest(session, message) {
    session.pendingApproval = {
      id: message.id,
      method: message.method,
      params: message.params || {}
    };
    this.saveState();
    await this.emit(session, formatApproval(session.pendingApproval));
  }

  async handleTurnCompleted(session, params) {
    const turnId = params.turn?.id || params.turnId || session.activeTurnId;
    const text = (session.agentTextByTurn.get(turnId) || "").trim();
    const turn = params.turn || {};
    if (!turnId || session.activeTurnId === turnId) session.activeTurnId = "";

    if (text) {
      this.pushTranscript(session, text);
      await this.emit(session, text);
    } else if (turn.status === "failed") {
      await this.emit(session, `Codex turn failed:\n${turn.error?.message || JSON.stringify(turn.error || turn)}`);
    } else {
      await this.emit(session, "Codex turn completed with no final message.");
    }

    session.agentTextByTurn.delete(turnId);
    session.commandOutputByTurn.delete(turnId);
    this.turnToSession.delete(turnId);
    this.saveState();
    await this.notifyLifecycle(session, turn.status === "failed" ? "failed" : "completed");
  }

  async emit(session, text) {
    if (!session?.target || !this.outputSink) return;
    const payload = normalizeSlackText(text);
    if (!payload) return;
    this.outputQueue = this.outputQueue
      .then(() => this.outputSink(session.target, payload))
      .catch((error) => {
        console.error(`${new Date().toISOString()} output sink failed`, error.stack || String(error));
      });
    await this.outputQueue;
  }

  async emitAll(text) {
    const sessions = [...this.sessions.values()].filter((session) => session.target);
    await Promise.all(sessions.map((session) => this.emit(session, text)));
  }

  async notifyLifecycle(session, state) {
    if (!session?.target || !this.lifecycleSink) return;
    try {
      await this.lifecycleSink(session.target, state);
    } catch (error) {
      console.error(`${new Date().toISOString()} lifecycle sink failed`, error.stack || String(error));
    }
  }

  pushTranscript(session, text) {
    session.recentTranscript.push(text.trim());
    if (session.recentTranscript.length > 50) session.recentTranscript.splice(0, session.recentTranscript.length - 50);
  }

  getSession(target) {
    const key = target?.sessionKey || "default";
    let session = this.sessions.get(key);
    if (!session) {
      session = createSession(key, target);
      if (this.legacyThreadId && this.sessions.size === 0) {
        session.threadId = this.legacyThreadId;
        this.legacyThreadId = "";
      }
      this.sessions.set(key, session);
    }
    if (target) session.target = target;
    if (session.threadId) this.threadToSession.set(session.threadId, session.key);
    this.saveState();
    return session;
  }

  findSession(params) {
    const turnId = params?.turnId || params?.turn?.id || "";
    const threadId = params?.threadId || params?.thread?.id || "";
    const key = this.turnToSession.get(turnId) || this.threadToSession.get(threadId);
    return key ? this.sessions.get(key) : null;
  }

  withSessionQueue(session, fn) {
    const next = session.queue.then(fn, fn);
    session.queue = next.catch(() => {});
    return next;
  }

  restoreState() {
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch {
      return;
    }
    if (state.threadId && !state.sessions) {
      this.legacyThreadId = state.threadId;
      return;
    }
    for (const [key, value] of Object.entries(state.sessions || {})) {
      const session = createSession(key, value.target || null);
      session.threadId = value.threadId || "";
      this.sessions.set(key, session);
      if (session.threadId) this.threadToSession.set(session.threadId, key);
    }
  }

  saveState() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const sessions = {};
    for (const [key, session] of this.sessions) {
      sessions[key] = {
        threadId: session.threadId,
        target: session.target ? {
          channel: session.target.channel,
          threadTs: session.target.threadTs,
          messageTs: session.target.messageTs,
          sessionKey: session.target.sessionKey
        } : null,
        updatedAt: new Date().toISOString()
      };
    }
    fs.writeFileSync(this.stateFile, JSON.stringify({
      version: 2,
      updatedAt: new Date().toISOString(),
      workdir: this.config.workdir,
      sessions
    }, null, 2) + "\n", { mode: 0o600 });
  }

  logRaw(entry) {
    if (!this.logPath) return;
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.logPath, JSON.stringify({
      ts: new Date().toISOString(),
      ...entry
    }) + "\n", { mode: 0o600 });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function createSession(key, target) {
  return {
    key,
    target,
    threadId: "",
    threadReady: false,
    activeTurnId: "",
    pendingApproval: null,
    agentTextByTurn: new Map(),
    commandOutputByTurn: new Map(),
    recentTranscript: [],
    queue: Promise.resolve()
  };
}

function formatApproval(approval) {
  const params = approval.params;
  if (approval.method === "item/commandExecution/requestApproval") {
    return [
      "Approval requested: command execution",
      params.reason ? `Reason: ${params.reason}` : "",
      params.cwd ? `cwd: ${params.cwd}` : "",
      params.command ? `command: ${params.command}` : "",
      "",
      "Reply `approve` or `deny` in this Slack session."
    ].filter(Boolean).join("\n");
  }
  if (approval.method === "item/fileChange/requestApproval") {
    return [
      "Approval requested: file change",
      params.reason ? `Reason: ${params.reason}` : "",
      params.grantRoot ? `root: ${params.grantRoot}` : "",
      "",
      "Reply `approve` or `deny` in this Slack session."
    ].filter(Boolean).join("\n");
  }
  if (approval.method === "item/permissions/requestApproval") {
    return [
      "Approval requested: additional permissions",
      params.reason ? `Reason: ${params.reason}` : "",
      params.cwd ? `cwd: ${params.cwd}` : "",
      "",
      "Reply `approve` or `deny` in this Slack session."
    ].filter(Boolean).join("\n");
  }
  return "Approval requested. Reply `approve` or `deny` in this Slack session.";
}

function approvalResponse(approval) {
  if (approval.method === "item/permissions/requestApproval") {
    const requested = approval.params.permissions || {};
    return {
      permissions: {
        ...(requested.network ? { network: requested.network } : {}),
        ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {})
      },
      scope: "turn"
    };
  }
  return { decision: "accept" };
}

function denialResponse(approval) {
  if (approval.method === "item/permissions/requestApproval") {
    return {
      permissions: {},
      scope: "turn"
    };
  }
  return { decision: "decline" };
}

function normalizeSlackText(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function cleanupOldLogs(config) {
  const days = Number(config.logRetentionDays) || 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const dirs = [
    config.logDir,
    path.join(config.logDir, "appserver")
  ];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/^(appserver-|terminal-).*\.(jsonl|log)$/.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

function shrinkLogMessage(message) {
  return truncateDeep(message, 0);
}

function truncateDeep(value, depth) {
  if (typeof value === "string") return truncateString(value);
  if (!value || typeof value !== "object") return value;
  if (depth > 8) return "[truncated-depth]";
  if (Array.isArray(value)) return value.map((item) => truncateDeep(item, depth + 1));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = truncateDeep(item, depth + 1);
  }
  return result;
}

function truncateString(value) {
  const text = String(value || "");
  const max = 12000;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function escapeTomlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
