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
const SERVER_INFO = { name: "local-continue-续聊助手", version: "1.0.1" };
// Cursor hard-cuts an MCP tool call at ~60 min (-32001). Return a KEEPALIVE_NOOP a
// bit before that so the agent re-invokes and the request never hard-fails.
const DEFAULT_SOFT_TIMEOUT_MS = 3300 * 1000;
const BASE_POLL_MS = 200;
const MAX_POLL_MS = 1000;

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
const SOFT_TIMEOUT_MS = (() => {
  const n = parseInt(CLI["soft-timeout"] || process.env.LOCAL_CONTINUE_MCP_SOFT_TIMEOUT || "", 10);
  return Number.isFinite(n) && n > 0 ? n * 1000 : DEFAULT_SOFT_TIMEOUT_MS;
})();

function keepaliveText(sessionId) {
  return `KEEPALIVE_NOOP:
当前没有新的用户指令（已等待较久）。请不要修改项目，也不要总结，只需要**立即再次调用 wait_for_instruction 工具**（session_id="${sessionId}"）继续等待下一条指令，保持本对话循环。`;
}

function sessionBusyText(sessionId, ownerPid) {
  const pid = ownerPid ? `pid ${ownerPid}` : "另一个进程";
  return `SESSION_BUSY:
会话 ${sessionId} 已有一个活动的等待者（${pid}），通常是另一个对话也在用同一个 session_id（another instruction waiter is already active for this session）。
请不要反复重试抢锁；在续聊助手面板为本对话新建一个会话并用它的 session_id，或改用一个唯一的 session_id，然后再调用 wait_for_instruction。`;
}

// Block on this session's queue (and the global idle-first queue) until an item
// arrives, a soft timeout elapses, or the MCP request is cancelled. Mirrors the
// shell wait loop but returns text for the tool result instead of printing.
async function waitForInstructionMcp(project, sessionId, opts) {
  sessionId = inst.safeSessionId(sessionId);
  project.registerSession(sessionId);
  const session = project.session(sessionId);
  const runId = crypto.randomUUID().replace(/-/g, "");
  if (opts.report) session.recordResult(opts.report, opts.reportStatus || "done", runId);

  const [acquired, owner] = session.acquireWaiter(runId);
  if (!acquired) {
    session.writeStatus(runId, "busy", { transport: "mcp", last_error: "another waiter is already active", active_waiter: owner });
    return sessionBusyText(sessionId, owner && owner.pid);
  }

  const startedAtMs = inst.nowMs();
  const keepaliveDeadline = SOFT_TIMEOUT_MS > 0 ? Date.now() + SOFT_TIMEOUT_MS : null;
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
  let lastSessionSig = "init";
  let lastGlobalSig = "init";
  const notifier = inst.createQueueNotifier([
    { dir: session.dir, file: path.basename(session.queuePath) },
    { dir: project.stateDir, file: path.basename(project.globalQueuePath) },
  ]);

  try {
    for (;;) {
      if (opts.isCancelled && opts.isCancelled()) {
        session.writeStatus(runId, "cancelled", { transport: "mcp", uptime_ms: inst.nowMs() - startedAtMs });
        return { cancelled: true };
      }
      const now = Date.now();
      if (now - lastHeartbeat >= heartbeatInterval) {
        session.refreshWaiter(runId);
        session.writeStatus(runId, "waiting", { transport: "mcp", uptime_ms: inst.nowMs() - startedAtMs, keepalive_deadline_ms: keepaliveDeadline });
        lastHeartbeat = now;
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
        const globalSig = inst.queueSignature(project.globalQueuePath);
        if (globalSig !== lastGlobalSig) {
          const [popped, , conclusive] = project.popGlobal();
          if (conclusive) lastGlobalSig = globalSig;
          if (popped) { item = popped; sourceQueue = "global"; }
        }
      }
      if (item) {
        const payload = inst.normalizePayload(item);
        const rendered = inst.renderPayload(payload);
        session.writeStatus(runId, "received", {
          transport: "mcp",
          last_ack_id: item.id,
          last_ack_at: inst.isoNow(),
          last_message_preview: rendered.slice(0, 160),
          uptime_ms: inst.nowMs() - startedAtMs,
        });
        session.appendHistory({ type: "received", id: item.id, source_queue: sourceQueue, transport: "mcp", session_id: sessionId, run_id: runId, message_preview: rendered.slice(0, 160), at: inst.isoNow() });
        return { text: rendered };
      }

      if (keepaliveDeadline !== null && Date.now() >= keepaliveDeadline) {
        session.writeStatus(runId, "keepalive", { transport: "mcp", last_message_preview: "KEEPALIVE_NOOP", uptime_ms: inst.nowMs() - startedAtMs });
        return { text: keepaliveText(sessionId) };
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
const TOOLS = [
  {
    name: "wait_for_instruction",
    description:
      "续聊助手 bridge 循环的核心：阻塞直到面板下发本会话的下一条指令再返回。用法：每完成一轮任务后就再次调用本工具（可带 report 反馈刚做完的事）。返回可能是：一条用户指令（直接执行）、KEEPALIVE_NOOP（立即再次调用本工具）、SESSION_BUSY（换唯一 session_id）、或 stop（结束循环）。这是 MCP 工具调用，会被原生阻塞等待，不会被放到后台。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "本对话的会话 ID（来自面板启动指令，如 agent-1）。" },
        report: { type: "string", description: "可选：用一句话反馈刚完成或遇到的情况，会显示在面板。" },
        report_status: { type: "string", enum: ["done", "need_input", "error"], description: "report 的状态。" },
      },
    },
  },
  {
    name: "report_result",
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
  },
];

const project = new inst.ProjectState(STATE_DIR);
const inflight = new Map(); // jsonrpc id -> { cancelled: boolean }

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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

async function handleToolCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  if (name === "report_result") {
    const summary = String(args.summary || "").trim();
    if (!summary) return respond(id, textResult("summary 不能为空。", true));
    const session = project.session(args.session_id || "agent-1");
    session.recordResult(summary, args.status || "done", null);
    return respond(id, textResult("已上报。"));
  }
  if (name === "wait_for_instruction") {
    const state = { cancelled: false };
    inflight.set(id, state);
    try {
      const outcome = await waitForInstructionMcp(project, args.session_id || "agent-1", {
        report: args.report || null,
        reportStatus: args.report_status || "done",
        isCancelled: () => state.cancelled,
      });
      if (outcome && outcome.cancelled) return respond(id, textResult("等待已取消。", true));
      return respond(id, textResult(outcome.text));
    } catch (error) {
      return respond(id, textResult(`等待出错：${error && error.message ? error.message : error}`, true));
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
    const requested = params && params.protocolVersion;
    return respond(id, {
      protocolVersion: requested || PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "ping") return respond(id, {});
  if (method === "tools/list") return respond(id, { tools: TOOLS });
  if (method === "tools/call") { handleToolCall(id, params); return; }
  return respondError(id, -32601, `method not found: ${method}`);
}

function main() {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
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
