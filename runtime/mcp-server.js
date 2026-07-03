#!/usr/bin/env node
"use strict";

// MCP transport for 续聊助手.
//
// Why this exists: the shell `instruction.js wait` loop relies on the agent
// keeping a long-running command in the FOREGROUND until it returns. Some models
// / harnesses (notably GPT-5.5) background such a command after ~1s and end their
// turn, so the bridge loop never turns over. An MCP tool call, by contrast, is a
// first-class operation the Cursor client blocks on natively -- it is never
// "backgrounded" -- so delivering "wait for the next instruction" as an MCP tool
// makes the loop robust across models. It is also free within a single request.
//
// This server speaks the MCP protocol (JSON-RPC 2.0 over newline-delimited stdio)
// by hand -- no external dependency -- and reuses instruction.js's on-disk queue /
// session / state machine, so the panel, queues, scheduling, handoff and status
// all behave identically whether the agent uses the shell `wait` or this MCP tool.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const inst = require("./instruction.js");

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "local-continue-续聊助手", version: "1.2.0" };
// Cursor hard-cuts an MCP tool call at ~60 min (-32001). Return a KEEPALIVE_NOOP
// well before that so the agent re-invokes and the request never hard-fails.
// 3000s leaves a 10-minute margin (network jitter, client-side queuing) instead
// of the old 5; overridable via --soft-timeout / env / mcpSoftTimeoutSeconds.
const DEFAULT_SOFT_TIMEOUT_MS = 3000 * 1000;
const BASE_POLL_MS = 200;
const MAX_POLL_MS = 1000;
const PROGRESS_NOTIFY_INTERVAL_MS = 25000;
const GLOBAL_SIG_CACHE_MS = 1000;

function defaultStateDir() {
  return path.join(process.cwd(), ".cursor", "local-continue-state");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) args[token.slice(2)] = argv[++i];
  }
  return args;
}

const CLI = parseArgs(process.argv.slice(2));
const STATE_DIR = CLI["state-dir"] || process.env.LOCAL_CONTINUE_STATE_DIR || defaultStateDir();
// CLI / env override wins; otherwise the per-project settings.json key
// mcpSoftTimeoutSeconds applies (re-read on every wait, so panel-driven changes
// take effect without restarting the MCP server); else the built-in default.
const SOFT_TIMEOUT_OVERRIDE_MS = (() => {
  const n = parseInt(CLI["soft-timeout"] || process.env.LOCAL_CONTINUE_MCP_SOFT_TIMEOUT || "", 10);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
})();

function softTimeoutMs() {
  if (SOFT_TIMEOUT_OVERRIDE_MS !== null) return SOFT_TIMEOUT_OVERRIDE_MS;
  try {
    const seconds = Number(project.settings().mcpSoftTimeoutSeconds || 0);
    if (Number.isFinite(seconds) && seconds > 0) return Math.max(60, seconds) * 1000;
  } catch { /* fall through to default */ }
  return DEFAULT_SOFT_TIMEOUT_MS;
}

function keepaliveText(sessionId) {
  return `KEEPALIVE_NOOP:
当前没有新的用户指令（已等待较久）。请不要修改项目，也不要总结，只需要**立即再次调用 wait_for_instruction 工具**（session_id="${sessionId}"）继续等待下一条指令，保持本对话循环。`;
}

// Appended to the *content* of every real instruction so the agent is re-told,
// in-band on every single turn, to re-enter the loop after finishing. The
// one-off start instruction is easy to "forget" many turns later; this in-band
// reminder is the most reliable guard against a model ending its turn instead of
// calling wait_for_instruction again.
function loopReminder(sessionId) {
  return `

────────
[续聊助手·循环提醒] 以上是本轮要执行的用户指令。**执行完成后，请立即再次调用 wait_for_instruction（session_id="${sessionId}"）** 等待下一条指令；是否结束由用户的 stop 决定，不由你决定——除非收到 stop，否则不要结束本轮，也不要停下来问“是否继续”。`;
}

function sessionBusyText(sessionId, ownerPid) {
  const pid = ownerPid ? `pid ${ownerPid}` : "另一个进程";
  return `SESSION_BUSY:
会话 ${sessionId} 已有一个活动的等待者（${pid}），通常是另一个对话也在用同一个 session_id（another instruction waiter is already active for this session）。
请不要反复重试抢锁；在续聊助手面板为本对话新建一个会话并用它的 session_id，或改用一个唯一的 session_id，然后再调用 wait_for_instruction。`;
}

// A cancelled wait is ambiguous: client-side timeouts / UI switches cancel the
// request (agent should re-enter the loop), but so does the user pressing stop
// in some clients (agent should NOT fight the user to keep looping). We can't
// distinguish the two from the notification alone, so track consecutive
// cancels per session: the first ones instruct an unconditional re-invoke;
// from the third in a short window the text tells the agent to treat a
// deliberate user stop as final. (When the user stops the whole conversation
// the agent never reads this text at all -- this only matters for repeated
// automatic cancels, hence the generous threshold.)
const CANCEL_STREAK_WINDOW_MS = 10 * 60 * 1000;
const cancelStreaks = new Map(); // sessionId -> { count, lastMs }

function noteCancelled(sessionId) {
  const now = Date.now();
  const entry = cancelStreaks.get(sessionId);
  const count = entry && now - entry.lastMs <= CANCEL_STREAK_WINDOW_MS ? entry.count + 1 : 1;
  cancelStreaks.set(sessionId, { count, lastMs: now });
  return count;
}

function resetCancelled(sessionId) {
  cancelStreaks.delete(sessionId);
}

function cancelledText(sessionId) {
  const streak = noteCancelled(sessionId);
  if (streak >= 3) {
    return `本次等待再次被取消（10 分钟内第 ${streak} 次）。如果是你（用户）主动停止了本轮，请就此结束，不必重试；否则说明客户端在反复超时/切换，请再次调用 wait_for_instruction（session_id="${sessionId}"）继续等待，或在面板检查该会话。`;
  }
  return `本次等待被取消（通常是客户端超时或界面切换，不是错误）。请立即再次调用 wait_for_instruction（session_id="${sessionId}"）继续等待下一条指令，不要结束本轮。`;
}

// --- Working-presence heartbeat (MCP mode) -----------------------------------
// The shell runtime spawns a detached beacon that watches the agent terminal's
// PID so the panel can tell "working" from "interrupted" during the work gap
// between two waits. The MCP server has no per-conversation terminal to watch --
// it is one window-level process shared by every session -- so that beacon never
// runs, and the panel used to fall back to a time threshold that flips a healthy
// long task to "stalled/interrupted" after ~5 min. Instead, while this process is
// alive we heartbeat presence.json for a session from the moment we hand it an
// instruction (agent starts working) until it re-enters wait or the process dies.
// So a long turn stays "working", and only the window/process actually going away
// makes presence go stale -> "interrupted". (A single conversation interrupted
// while its window stays open can't be detected over MCP; that's inherent.)
const MCP_PRESENCE_INTERVAL_MS = 4000;
// Hard cap on how long a working-presence heartbeat may outlive its hand-off.
// Unlike the shell beacon (which watches the agent terminal's PID and dies with
// it), this window-level process has no per-conversation liveness signal: if the
// agent never re-enters wait (turn ended without looping / crashed / user
// interrupted), an uncapped interval would heartbeat forever and the panel
// would show "working" until the whole window closed. After
// max(workingTimeoutSeconds, this floor) we stop AND remove presence.json --
// an absent file makes the panel fall back to its time-threshold heuristic
// ("可能中断"), whereas a merely-stale file would read as a dead terminal
// ("已中断"). A healthy marathon turn that outlives the cap degrades to that
// soft warning and recovers the moment the agent re-enters wait.
const MCP_PRESENCE_MIN_LIFETIME_MS = 60 * 60 * 1000;
const workingPresence = new Map(); // sessionId -> { timer, session }

function presenceLifetimeMs() {
  let seconds = 0;
  try {
    seconds = Number(project.settings().workingTimeoutSeconds || 0);
  } catch { /* fall through to the floor */ }
  return Math.max(seconds > 0 ? seconds * 1000 : 0, MCP_PRESENCE_MIN_LIFETIME_MS);
}

function startWorkingPresence(session) {
  stopWorkingPresence(session.sessionId);
  const startedMs = inst.nowMs();
  const lifetimeMs = presenceLifetimeMs();
  const write = () => session.writeJsonBestEffort(session.presencePath, {
    beacon: true,
    mode: "mcp",
    pid: process.pid,
    heartbeat_ms: inst.nowMs(),
    heartbeat_at: inst.isoNow(),
    interval_ms: MCP_PRESENCE_INTERVAL_MS,
  });
  write();
  const timer = setInterval(() => {
    if (inst.nowMs() - startedMs >= lifetimeMs) {
      stopWorkingPresence(session.sessionId, true);
      return;
    }
    write();
  }, MCP_PRESENCE_INTERVAL_MS);
  if (timer.unref) timer.unref();
  workingPresence.set(session.sessionId, { timer, session });
}

function stopWorkingPresence(sessionId, removePresenceFile = false) {
  const entry = workingPresence.get(sessionId);
  if (!entry) return;
  clearInterval(entry.timer);
  workingPresence.delete(sessionId);
  if (removePresenceFile) {
    try { fs.rmSync(entry.session.presencePath, { force: true }); } catch { /* best effort */ }
  }
}

// One MCP server process can host many simultaneous session waiters. Each waiter
// used to create its own watcher/stat loop for the single global idle-first queue,
// which is harmless but noisy at 6+ sessions. This shared signal only reports that
// global_queue.json may have changed; actual consumption still goes through
// project.popGlobal(), which holds the cross-process global queue lock.
function createGlobalQueueSignal(projectState) {
  let dirty = true;
  let signature = "init";
  let signatureAt = 0;
  let watcher = null;
  let watcherAttemptAt = 0;
  const subscribers = new Set();

  const fire = () => {
    dirty = true;
    for (const listener of [...subscribers]) {
      try { listener(); } catch { /* best effort */ }
    }
  };

  const ensureWatcher = () => {
    if (watcher) return;
    const now = Date.now();
    if (watcherAttemptAt && now - watcherAttemptAt < GLOBAL_SIG_CACHE_MS) return;
    watcherAttemptAt = now;
    try {
      const targetFile = path.basename(projectState.globalQueuePath);
      watcher = fs.watch(projectState.stateDir, { persistent: false }, (eventType, filename) => {
        if (!filename || filename === targetFile) fire();
      });
      watcher.on("error", () => {
        try { watcher.close(); } catch { /* already closed */ }
        watcher = null;
        dirty = true;
        fire();
      });
    } catch {
      watcher = null;
    }
  };

  ensureWatcher();

  return {
    get active() { ensureWatcher(); return Boolean(watcher); },
    signature() {
      ensureWatcher();
      const now = Date.now();
      if (dirty || now - signatureAt >= GLOBAL_SIG_CACHE_MS) {
        signature = inst.queueSignature(projectState.globalQueuePath);
        signatureAt = now;
        dirty = false;
      }
      return signature;
    },
    subscribe(listener) {
      ensureWatcher();
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    close() {
      subscribers.clear();
      if (watcher) {
        try { watcher.close(); } catch { /* already closed */ }
        watcher = null;
      }
    },
  };
}

function createMcpWaitNotifier(session, globalSignal) {
  let pending = false;
  let resolver = null;
  let timer = null;

  const fire = () => {
    pending = true;
    if (resolver) {
      const resolve = resolver;
      resolver = null;
      if (timer) { clearTimeout(timer); timer = null; }
      resolve();
    }
  };

  const watchers = [];
  try {
    const targetFile = path.basename(session.queuePath);
    const watcher = fs.watch(session.dir, { persistent: false }, (eventType, filename) => {
      if (!filename || filename === targetFile) fire();
    });
    watcher.on("error", () => { /* polling safety-net covers gaps */ });
    watchers.push(watcher);
  } catch {
    /* polling safety-net covers gaps */
  }

  const unsubscribeGlobal = globalSignal.subscribe(fire);

  return {
    active: watchers.length > 0 || globalSignal.active,
    wait(maxMs) {
      if (pending) { pending = false; return Promise.resolve(); }
      return new Promise((resolve) => {
        resolver = resolve;
        timer = setTimeout(() => { resolver = null; timer = null; resolve(); }, Math.max(0, maxMs));
      });
    },
    close() {
      unsubscribeGlobal();
      for (const watcher of watchers) { try { watcher.close(); } catch { /* ignore */ } }
      watchers.length = 0;
      if (timer) { clearTimeout(timer); timer = null; }
      resolver = null;
    },
  };
}
// Block on this session's queue (and the global idle-first queue) until an item
// arrives, a soft timeout elapses, or the MCP request is cancelled. Mirrors the
// shell wait loop but returns text for the tool result instead of printing.
async function waitForInstructionMcp(project, sessionId, opts) {
  sessionId = inst.safeSessionId(sessionId);
  project.registerSession(sessionId);
  const session = project.session(sessionId);
  const runId = crypto.randomUUID().replace(/-/g, "");
  if (opts.report) {
    session.recordResult(opts.report, opts.reportStatus || "done", runId);
    // Task finished + re-entering the loop -> fire the opt-in result webhook.
    inst.notifyWebhookResult(project, sessionId, opts.report, opts.reportStatus || "done", { transport: "mcp" });
  }

  const [acquired, owner] = session.acquireWaiter(runId);
  if (!acquired) {
    session.writeStatus(runId, "busy", { transport: "mcp", last_error: "another waiter is already active", active_waiter: owner });
    return { kind: "session_busy", text: sessionBusyText(sessionId, owner && owner.pid) };
  }
  // The agent is back to waiting, so its heartbeat again drives online state --
  // stop the working-presence heartbeat started when we handed out the last item.
  stopWorkingPresence(sessionId);

  const startedAtMs = inst.nowMs();
  const softTimeout = softTimeoutMs();
  const keepaliveDeadline = softTimeout > 0 ? Date.now() + softTimeout : null;
  const offlineAfter = Number(project.settings().offlineAfterSeconds || 15);
  const heartbeatInterval = Math.max(1000, Math.min(5000, (offlineAfter / 3) * 1000));
  const agentEnv = inst.captureAgentEnv();
  session.writeStatus(runId, "waiting", {
    started_at: inst.isoNow(),
    transport: "mcp",
    // The MCP server is a single window-level process, not a per-conversation
    // agent terminal, so CURSOR_CONVERSATION_ID would be empty or shared across
    // every session here -- writing it would show the same (misleading) id on all
    // MCP sessions, so we intentionally omit it. workspace_label is window-correct.
    workspace_label: agentEnv.workspace_label,
    keepalive_deadline_ms: keepaliveDeadline,
  });

  let lastHeartbeat = Date.now();
  let lastProgress = 0;
  let lastSessionSig = "init";
  let lastGlobalSig = "init";
  const notifier = createMcpWaitNotifier(session, globalQueueSignal);

  try {
    if (opts.onProgress) {
      opts.onProgress(0, "wait_for_instruction started");
      lastProgress = Date.now();
    }
    for (;;) {
      if (opts.isCancelled && opts.isCancelled()) {
        session.writeStatus(runId, "cancelled", { transport: "mcp", uptime_ms: inst.nowMs() - startedAtMs });
        return { kind: "cancelled", text: cancelledText(sessionId) };
      }
      const now = Date.now();
      if (now - lastHeartbeat >= heartbeatInterval) {
        if (!session.refreshWaiter(runId)) {
          // A rival waiter took the lock over while we were stalled. Stand down
          // without touching status.json (the successor owns it now); the agent
          // gets the same session_busy treatment as a busy-at-start.
          const rival = session.currentWaiter();
          return { kind: "session_busy", text: sessionBusyText(sessionId, rival && rival.pid) };
        }
        session.writeStatus(runId, "waiting", { transport: "mcp", uptime_ms: inst.nowMs() - startedAtMs, keepalive_deadline_ms: keepaliveDeadline });
        lastHeartbeat = now;
      }
      if (opts.onProgress && now - lastProgress >= PROGRESS_NOTIFY_INTERVAL_MS) {
        const elapsedSeconds = Math.max(1, Math.round((now - startedAtMs) / 1000));
        opts.onProgress(elapsedSeconds, `waiting ${elapsedSeconds}s for session ${sessionId}`);
        lastProgress = now;
      }

      let item = null;
      let sourceQueue = "session";
      const sessionSig = inst.queueSignature(session.queuePath);
      if (sessionSig !== lastSessionSig) {
        const [popped, , conclusive] = session.popNext();
        if (conclusive) lastSessionSig = sessionSig;
        if (popped) item = popped;
      }
      if (!item) {
        const globalSig = globalQueueSignal.signature();
        if (globalSig !== lastGlobalSig) {
          const [popped, , conclusive] = project.popGlobal();
          if (conclusive) lastGlobalSig = globalSig;
          if (popped) { item = popped; sourceQueue = "global"; }
        }
      }
      if (item) {
        const payload = inst.normalizePayload(item);
        // stateDir is <workspace>/.cursor/local-continue-state -> workspace root is two levels up.
        const wsRoot = path.dirname(path.dirname(project.stateDir));
        const rendered = inst.renderPayload(payload, wsRoot);
        // Pin the agent to this session's project directory (if configured).
        const scoped = inst.applySessionScope(project, sessionId, rendered);
        // A "stop" ends the loop for good: record a distinct terminal state
        // (panel shows "已停止" instead of inferring interrupted from a stale
        // "received") and clean up any presence.json left from earlier rounds.
        session.writeStatus(runId, rendered === "stop" ? "stopped" : "received", {
          transport: "mcp",
          last_ack_id: item.id,
          last_ack_at: inst.isoNow(),
          last_message_preview: rendered.slice(0, 160),
          uptime_ms: inst.nowMs() - startedAtMs,
        });
        session.appendHistory({ type: "received", id: item.id, source_queue: sourceQueue, transport: "mcp", session_id: sessionId, run_id: runId, message_preview: rendered.slice(0, 160), at: inst.isoNow() });
        // Hand-off: the agent is about to work, so drive the panel's "working"
        // state from a presence heartbeat until it re-enters wait (see above).
        if (rendered !== "stop") {
          startWorkingPresence(session);
        } else {
          try { fs.rmSync(session.presencePath, { force: true }); } catch { /* best effort */ }
        }
        resetCancelled(sessionId);
        return { kind: rendered === "stop" ? "stop" : "instruction", text: scoped };
      }

      if (keepaliveDeadline !== null && Date.now() >= keepaliveDeadline) {
        session.writeStatus(runId, "keepalive", { transport: "mcp", last_message_preview: "KEEPALIVE_NOOP", uptime_ms: inst.nowMs() - startedAtMs });
        resetCancelled(sessionId);
        return { kind: "keepalive", text: keepaliveText(sessionId) };
      }

      let waitMs = MAX_POLL_MS;
      const untilHeartbeat = heartbeatInterval - (now - lastHeartbeat);
      if (untilHeartbeat < waitMs) waitMs = untilHeartbeat;
      if (keepaliveDeadline !== null) waitMs = Math.min(waitMs, keepaliveDeadline - now);
      await notifier.wait(Math.max(BASE_POLL_MS / 4, waitMs));
    }
  } finally {
    notifier.close();
    session.releaseWaiter(runId);
  }
}

// --- MCP JSON-RPC over stdio -------------------------------------------------
// The structured shape wait_for_instruction returns alongside its text, so the
// agent can branch on `kind` instead of fragile string-prefix matching of the
// text (KEEPALIVE_NOOP: / SESSION_BUSY: ...). Text is kept for back-compat.
const WAIT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["instruction", "keepalive", "session_busy", "stop", "cancelled", "error"],
      description: "指令类型：instruction=执行它；keepalive=立即再次调用本工具；session_busy=换唯一 session_id；stop=结束循环；cancelled=等待被取消（应重新调用）；error=临时出错（应重新调用）。",
    },
    session_id: { type: "string", description: "本次等待所属的会话 ID。" },
    text: { type: "string", description: "渲染后的指令/提示全文（instruction 时为纯用户指令）。" },
    next_action: {
      type: "string",
      enum: ["call_wait_for_instruction", "stop", "use_unique_session_id"],
      description: "下一步动作：call_wait_for_instruction=处理完后立即再次调用本工具（instruction/keepalive/cancelled/error 都是它）；stop=结束循环；use_unique_session_id=换唯一 session_id 再调用。",
    },
  },
  required: ["kind", "text", "next_action"],
};

const TOOLS = [
  {
    name: "wait_for_instruction",
    title: "等待下一条指令",
    description:
      "续聊助手 bridge 循环的核心：阻塞直到面板下发本会话的下一条指令再返回。用法：每完成一轮任务后就再次调用本工具（可带 report 反馈刚做完的事）。返回结构化 kind 字段（优先判断它）：instruction=直接执行、keepalive=立即再次调用本工具、session_busy=换唯一 session_id、stop=结束循环。这是 MCP 工具调用，会被原生阻塞等待，不会被放到后台。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "本对话的会话 ID（来自面板启动指令，如 agent-1）。" },
        report: { type: "string", description: "可选：用一句话反馈刚完成或遇到的情况，会显示在面板。" },
        report_status: { type: "string", enum: ["done", "need_input", "error"], description: "report 的状态。" },
      },
    },
    outputSchema: WAIT_OUTPUT_SCHEMA,
    annotations: {
      title: "等待下一条指令",
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "report_result",
    title: "上报结果",
    description: "把本会话的一句话结果/状态上报给面板（不进入等待）。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "本对话的会话 ID。" },
        summary: { type: "string", description: "一句话结果。" },
        status: { type: "string", enum: ["done", "need_input", "error"], description: "状态。" },
      },
      required: ["summary"],
    },
    annotations: {
      title: "上报结果",
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_status",
    title: "查看会话状态",
    description: "只读查看续聊助手所有会话的状态摘要（在线/队列长度/最近消费），供 Agent 自诊断或转接决策，不进入等待。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "可选：只关心某个会话时传它；不传则返回全部。" },
      },
    },
    annotations: {
      title: "查看会话状态",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

// Read-only resource: the same status summary get_status returns, exposed as an
// MCP resource so a client/agent can read it without spending a tool call.
const RESOURCES = [
  {
    uri: "local-continue://sessions",
    name: "续聊助手会话状态",
    description: "所有会话的在线状态、队列长度与最近消费摘要（只读 JSON）。",
    mimeType: "application/json",
  },
];

const project = new inst.ProjectState(STATE_DIR);
const globalQueueSignal = createGlobalQueueSignal(project);
const inflight = new Map(); // jsonrpc id -> { cancelled: boolean }

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function progressNotify(progressToken, progress, message, total) {
  if (progressToken === undefined || progressToken === null) return;
  const params = { progressToken, progress };
  if (total !== undefined && total !== null) params.total = total;
  if (message) params.message = message;
  send({ jsonrpc: "2.0", method: "notifications/progress", params });
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(text, isError) {
  const result = { content: [{ type: "text", text: String(text) }] };
  if (isError) result.isError = true;
  return result;
}

function toolResult(text, opts = {}) {
  const result = { content: [{ type: "text", text: String(text) }] };
  if (opts.isError) result.isError = true;
  if (opts.structured) result.structuredContent = opts.structured;
  return result;
}

// The status summary get_status / the sessions resource return. Optionally
// narrowed to a single session.
function buildStatus(sessionId) {
  const summary = project.statusSummary();
  if (!sessionId) return summary;
  const id = inst.safeSessionId(sessionId);
  return { ...summary, sessions: (summary.sessions || []).filter((s) => s.id === id) };
}

async function handleToolCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const progressToken = params && params._meta ? params._meta.progressToken : undefined;
  if (name === "report_result") {
    const summary = String(args.summary || "").trim();
    if (!summary) return respond(id, textResult("summary 不能为空。", true));
    const sessionId = inst.safeSessionId(args.session_id || "agent-1");
    const session = project.session(sessionId);
    session.recordResult(summary, args.status || "done", null);
    inst.notifyWebhookResult(project, sessionId, summary, args.status || "done", { transport: "mcp" });
    // A result report marks the end of the current work item. Stop the
    // working-presence heartbeat and remove presence.json: an agent that
    // reports here without ever re-entering wait would otherwise stay
    // "working" forever, and a merely-stale file would read as a dead
    // terminal instead of falling back to the time-threshold heuristic.
    stopWorkingPresence(sessionId, true);
    return respond(id, textResult("已上报。"));
  }
  if (name === "get_status") {
    const status = buildStatus(args.session_id);
    return respond(id, toolResult(JSON.stringify(status, null, 2), { structured: status }));
  }
  if (name === "wait_for_instruction") {
    const sessionId = inst.safeSessionId(args.session_id || "agent-1");
    const state = { cancelled: false };
    inflight.set(id, state);
    try {
      const outcome = await waitForInstructionMcp(project, sessionId, {
        report: args.report || null,
        reportStatus: args.report_status || "done",
        isCancelled: () => state.cancelled,
        onProgress: (progress, message) => progressNotify(
          progressToken,
          progress,
          message,
          softTimeoutMs() > 0 ? Math.round(softTimeoutMs() / 1000) : undefined,
        ),
      });
      const kind = outcome.kind || "instruction";
      const nextAction = kind === "stop" ? "stop"
        : kind === "session_busy" ? "use_unique_session_id"
        : "call_wait_for_instruction";
      // Re-append the loop reminder to an actual instruction's content so the
      // agent is told, in-band every turn, to call wait_for_instruction again
      // after finishing. structuredContent.text stays the clean instruction.
      // Nothing here is isError: keepalive/cancelled/session_busy/stop are all
      // normal control signals -- marking any as an error tempts the model to end
      // the turn instead of looping, which is the very bug we're fixing.
      const contentText = kind === "instruction" ? outcome.text + loopReminder(sessionId) : outcome.text;
      return respond(id, toolResult(contentText, {
        structured: { kind, session_id: sessionId, text: outcome.text, next_action: nextAction },
      }));
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      // Even a genuine error must steer the agent back into the loop rather than
      // let it stop; surface it (isError) but tell it to retry.
      return respond(id, toolResult(
        `等待出错：${detail}。这通常是临时问题，请再次调用 wait_for_instruction（session_id="${sessionId}"）重试，不要结束本轮。`,
        { isError: true, structured: { kind: "error", session_id: sessionId, text: detail, next_action: "call_wait_for_instruction" } },
      ));
    } finally {
      inflight.delete(id);
    }
  }
  return respondError(id, -32601, `unknown tool: ${name}`);
}

function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  const { id, method, params } = message;
  // Notifications (no id) -------------------------------------------------
  if (method === "notifications/initialized") return;
  if (method === "notifications/cancelled") {
    const cancelId = params && params.requestId;
    const state = cancelId != null ? inflight.get(cancelId) : null;
    if (state) state.cancelled = true;
    return;
  }
  if (id === undefined || id === null) return; // unknown notification

  // Requests --------------------------------------------------------------
  if (method === "initialize") {
    // Per MCP spec: respond with the requested version only if we support it,
    // otherwise with our own supported version -- never blindly echo an
    // arbitrary client version we know nothing about.
    return respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
      },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "ping") return respond(id, {});
  if (method === "tools/list") return respond(id, { tools: TOOLS });
  if (method === "tools/call") { handleToolCall(id, params); return; }
  if (method === "resources/list") return respond(id, { resources: RESOURCES });
  if (method === "resources/read") {
    const uri = params && params.uri;
    if (uri === "local-continue://sessions") {
      const status = buildStatus(null);
      return respond(id, { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(status, null, 2) }] });
    }
    return respondError(id, -32602, `unknown resource: ${uri}`);
  }
  return respondError(id, -32601, `method not found: ${method}`);
}

function main() {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  // Cap the stdin buffer so a malformed/malicious peer can't exhaust memory by
  // sending an extremely long line without a newline. 10MB is far above any
  // legitimate JSON-RPC message for this server.
  const MAX_BUFFER = 10 * 1024 * 1024;
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER) {
      // Drop the oversized buffer and log; the peer will see a broken stream
      // and reconnect, which is safer than OOM-ing the MCP process.
      process.stderr.write("mcp-server: stdin buffer exceeded 10MB, resetting\n");
      buffer = "";
      return;
    }
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // ignore malformed lines
      }
      try {
        handleMessage(message);
      } catch (error) {
        if (message && message.id != null) respondError(message.id, -32603, String(error && error.message ? error.message : error));
      }
    }
  });
  process.stdin.on("end", () => {
    // Drain any in-flight tool call before exiting so a response isn't cut off
    // (a real MCP client keeps stdin open; this mainly matters for piped tests).
    const tryExit = () => { if (inflight.size === 0) process.exit(0); else setTimeout(tryExit, 150); };
    tryExit();
  });
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}

main();
