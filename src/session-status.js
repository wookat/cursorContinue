"use strict";

// ---------------------------------------------------------------------------
// session-status — derives the panel-facing session summary from on-disk
// status/presence/queue state, and provides higher-level operations that
// depend on it: getAllSessions, chooseRoundRobinSession, dispatchPayload,
// handoffSession, sessionIsConnected, resolveInstructionSession.
//
// This is the "read model" that bridges the queue/sessions/settings modules
// with the panel and instruction builder.
// ---------------------------------------------------------------------------

const shared = require("../runtime/shared.js");
const fs = require("fs");
const { nowMs, safeSessionId, normalizePayload } = shared;
const { readJsonCached, appendJsonl, compactForUi, withDirectoryLock } = require("./fs-utils.js");
const { sessionPaths } = require("./paths.js");
const { readSettings } = require("./settings.js");
const {
  readSessionsIndex, writeSessionsIndex, ensureDefaultSession, registerSession,
  sessionsLockDir,
} = require("./sessions.js");
const { readQueue, enqueueToSession, enqueueGlobal } = require("./queue.js");
const { buildHandoffBrief } = require("./cursor-history.js");

function sessionDisplaySeq(indexItem, index) {
  const fromId = /^agent-(\d+)/.exec(String((indexItem && indexItem.id) || ""));
  if (fromId) return Number(fromId[1]);
  const fromName = /(?:会话|浼氳瘽)?\s*(\d+)/.exec(String((indexItem && indexItem.name) || ""));
  if (fromName) return Number(fromName[1]);
  return index + 1;
}

function sessionSummary(paths, indexItem, settings = readSettings(paths), index = 0) {
  const sp = sessionPaths(paths, indexItem.id);
  const status = readJsonCached(sp.status, {});
  const heartbeatMs = Number(status.heartbeat_ms || 0);
  const heartbeatAgeMs = heartbeatMs ? nowMs() - heartbeatMs : null;
  const connected = status.state === "waiting" && heartbeatAgeMs !== null && heartbeatAgeMs <= settings.offlineAfterSeconds * 1000;
  const queue = readQueue(sp.queue);
  // Live activity inference. The waiter only heartbeats while parked in `wait`;
  // once it hands an instruction to the agent it exits, so during the agent's
  // actual work there is no heartbeat. Rather than show such a session as
  // "offline", we read its last state: "received"/"keepalive" means the agent
  // consumed something and the waiter exited, i.e. the agent is working (or, if
  // that state has been stale longer than workingTimeoutSeconds with no re-entry
  // into wait, the run was likely interrupted mid-way). This needs no runtime
  // change -- it's derived from the existing status fields + elapsed time, and
  // the panel re-evaluates it on its periodic refresh so it updates over time.
  const offlineMs = settings.offlineAfterSeconds * 1000;
  const workingMs = Math.max(offlineMs, settings.workingTimeoutSeconds * 1000);
  // Presence beacon: a detached process the waiter launches that heartbeats for
  // the whole session lifetime and dies with the agent terminal. It gives a real
  // "is the terminal still alive?" signal during the work gap between waits, so we
  // can distinguish working from interrupted in seconds. Absent (older runtime or
  // spawn failed) -> fall back to the time-threshold heuristic.
  // A live parked waiter (connected) is already conclusive, so skip the presence
  // read entirely for that (common) case -- the branches that consult presence
  // below are only reached when there is no live waiter.
  const presence = connected ? null : readJsonCached(sp.presence, null);
  const presenceMs = presence ? Number(presence.heartbeat_ms || 0) : 0;
  const beaconIntervalMs = presence ? Number(presence.interval_ms || 4000) : 4000;
  const beaconStaleMs = Math.max(10000, beaconIntervalMs * 3);
  const presenceAgeMs = presenceMs ? nowMs() - presenceMs : null;
  const beaconPresent = presenceMs > 0;
  const beaconAlive = presenceAgeMs !== null && presenceAgeMs <= beaconStaleMs;
  let activity;
  let interruptReason = "";
  if (status.state === "waiting" && heartbeatAgeMs !== null && heartbeatAgeMs <= offlineMs) {
    activity = queue.length > 0 ? "queued" : "idle";
  } else if (beaconAlive && (status.state === "received" || status.state === "keepalive" || status.state === "waiting")) {
    // Terminal alive but no parked waiter -> the agent is actively working.
    activity = "working";
  } else if (beaconPresent && (status.state === "received" || status.state === "keepalive")) {
    // Had a beacon, now stale -> the terminal/conversation died mid-run.
    activity = "stalled";
    interruptReason = "terminal";
  } else if (status.state === "received" || status.state === "keepalive") {
    // No beacon -> time-threshold fallback.
    activity = (heartbeatAgeMs !== null && heartbeatAgeMs <= workingMs) ? "working" : "stalled";
    if (activity === "stalled") interruptReason = "timeout";
  } else {
    activity = "offline";
  }
  const workingAgeMs = (activity === "working" || activity === "stalled") ? (heartbeatAgeMs || 0) : 0;
  const capturedConversationId = status.conversation_id || "";
  // Keep the status refresh path cheap and deterministic: panel cards use only
  // local state. Cursor history/metadata reads are reserved for explicit detail
  // or handoff actions so opening the panel never blocks on Cursor's SQLite DB.
  const conversationId = capturedConversationId;
  // Display name precedence is local-only: manual rename, then local auto-title,
  // then the fixed session name/id.
  const displayName = (indexItem.nameManual && indexItem.name)
    ? indexItem.name
    : (indexItem.autoTitle || indexItem.name || sp.id);
  return {
    id: sp.id,
    name: displayName,
    displaySeq: sessionDisplaySeq(indexItem, index),
    baseName: indexItem.name || sp.id,
    autoTitled: Boolean(!indexItem.nameManual && indexItem.autoTitle),
    created_at: indexItem.created_at || "",
    state: status.state || "new",
    transport: status.transport || (presence && presence.mode) || "",
    connected,
    activity,
    interruptReason,
    workingAgeMs,
    beaconAlive,
    heartbeatAgeMs,
    queueLength: queue.length,
    queuedResponses: queue.map((item) => {
      const raw = item.payload || item.message || "";
      const payload = typeof raw === "string" ? normalizePayload(raw) : raw;
      return {
        id: item.id,
        payload,
        source: item.source || "",
        created_at: item.created_at || "",
        target: item.target || sp.id,
      };
    }),
    lastAckId: status.last_ack_id || "",
    lastAckAt: status.last_ack_at || "",
    // Auto-captured by the waiter from the agent terminal's CURSOR_* env vars.
    // conversationId is Cursor's own chat id (the "request id" the user means),
    // surfaced so the panel can show/copy it with no manual entry.
    conversationId,
    conversationShort: conversationId ? String(conversationId).slice(0, 8) : "",
    workspaceLabel: status.workspace_label || "",
    lastMessagePreview: compactForUi(status.last_message_preview || "", 160),
    lastResult: compactForUi(status.last_result || "", 240),
    lastResultStatus: status.last_result_status || "",
    lastResultAt: status.last_result_at || "",
    lastResultAtMs: Number(status.last_result_at_ms || 0),
    keepaliveDeadlineMs: Number(status.keepalive_deadline_ms || 0),
    waiter: status.waiter || null,
    overrides: indexItem.overrides || null,
    projectDir: indexItem.projectDir || "",
    projectName: indexItem.projectDir ? (String(indexItem.projectDir).split(/[\\/]/).filter(Boolean).pop() || indexItem.projectDir) : "",
  };
}

// Very short-lived cache for getAllSessions. A single postStatus cycle can
// call it multiple times (broadcast filter, totalQueueLength, etc.); the cache
// collapses those into one round of I/O while staying fresh enough that the
// panel never shows stale state. 200ms is well below the shortest watch debounce.
const _allSessionsCache = new Map(); // key: stateDir -> { sig, at, data }
const ALL_SESSIONS_TTL_MS = 200;

function getAllSessions(paths, settings = readSettings(paths)) {
  ensureDefaultSession(paths);
  // Cache key on the sessions index signature so any index change (add/rename/
  // delete session, roundRobinIndex bump) invalidates instantly. The TTL is a
  // safety net for status/presence changes that don't touch the index.
  let sig = "";
  try { sig = `${fs.statSync(paths.sessionsIndex).mtimeMs}:${fs.statSync(paths.sessionsIndex).size}`; } catch { /* fresh */ }
  const now = nowMs();
  const cached = _allSessionsCache.get(paths.stateDir);
  if (cached && cached.sig === sig && now - cached.at < ALL_SESSIONS_TTL_MS) {
    return cached.data;
  }
  const data = readSessionsIndex(paths).sessions.map((item, index) => sessionSummary(paths, item, settings, index));
  _allSessionsCache.set(paths.stateDir, { sig, at: now, data });
  return data;
}

function chooseRoundRobinSession(paths) {
  // The read-modify-write of roundRobinIndex must be atomic; without the lock
  // two concurrent dispatches could read the same index and both advance to
  // the same next slot, breaking round-robin fairness.
  return withDirectoryLock(sessionsLockDir(paths), () => {
    const settings = readSettings(paths);
    const index = readSessionsIndex(paths);
    const sessions = index.sessions;
    if (!sessions.length) throw new Error("没有可用会话。");
    for (let offset = 0; offset < sessions.length; offset += 1) {
      const pos = (index.roundRobinIndex + offset) % sessions.length;
      const candidate = sessionSummary(paths, sessions[pos]);
      if (candidate.queueLength < settings.perSessionQueueLimit) {
        index.roundRobinIndex = (pos + 1) % sessions.length;
        writeSessionsIndex(paths, index);
        return candidate.id;
      }
    }
    throw new Error("所有会话队列都已达到上限。");
  });
}

function dispatchPayload(paths, payload, mode, sessionId) {
  const normalizedMode = mode || readSettings(paths).schedulingMode;
  if (normalizedMode === "broadcast") {
    const online = getAllSessions(paths).filter((session) => session.connected);
    if (!online.length) throw new Error("没有在线会话可广播。");
    return online.map((session) => enqueueToSession(paths, session.id, payload, "panel-broadcast"));
  }
  if (normalizedMode === "idle-first") {
    return [enqueueGlobal(paths, payload, "panel-idle-first")];
  }
  if (normalizedMode === "round-robin") {
    return [enqueueToSession(paths, chooseRoundRobinSession(paths), payload, "panel-round-robin")];
  }
  return [enqueueToSession(paths, sessionId || "agent-1", payload, "panel")];
}

// Session handoff ("会话转接"): when a conversation streams out or fills its
// context, hand its unfinished work to another idle, connected session. The
// plugin can't fork a Cursor chat, but it can enqueue a takeover instruction to
// the target waiter that carries the source's auto-captured conversation id plus
// the continuation context, so the receiving agent picks up where the dead one
// left off. The conversation id is auto-captured (no manual paste needed).
function handoffSession(paths, sourceId, targetId, context, reason) {
  const settings = readSettings(paths);
  const sId = safeSessionId(sourceId);
  const tId = safeSessionId(targetId);
  if (sId === tId) throw new Error("来源会话和目标会话不能相同。");
  const index = readSessionsIndex(paths);
  const target = index.sessions.find((entry) => entry.id === tId);
  if (!target) throw new Error("目标会话不存在。");
  const source = index.sessions.find((entry) => entry.id === sId);
  const sourceSummary = source ? sessionSummary(paths, source, settings) : null;
  const sourceName = sourceSummary ? sourceSummary.name : sId;
  const sourceCid = sourceSummary ? sourceSummary.conversationId : "";
  const ctx = String(context || "").trim();
  const why = String(reason || "").trim() || "原会话中断/上下文已满";

  // Inject the full conversation history from Cursor's SQLite DB so the target
  // agent gets real context — not just the 160-char preview the runtime captures.
  // Falls back to the manual context when the conversation can't be read (older
  // Node without node:sqlite, DB missing, conversation ID not captured, etc.).
  const historyBrief = sourceCid ? buildHandoffBrief(sourceCid) : null;

  const userInput = [
    `会话转接：请接管原会话「${sourceName}」未完成的任务。`,
    sourceCid ? `原 Cursor 会话 ID：${sourceCid}` : "",
    `转接原因：${why}`,
    "",
    historyBrief ? historyBrief : "",
    historyBrief ? "" : "需要你继续完成的内容/上下文：",
    ctx || (historyBrief ? "" : "（未提供额外上下文，请根据上述会话标识与任务名继续。）"),
    "",
    "请基于以上内容继续完成该任务；完成后照常进入 wait 等待循环。",
  ].filter((line) => line !== "").join("\n");
  const item = enqueueToSession(paths, tId, { status: "continue", user_input: userInput }, "panel-handoff");
  appendJsonl(paths.history, { type: "handoff", source: sId, target: tId, conversation_id: sourceCid, at: new Date().toISOString() }, settings.historyLimit);
  return { item, sourceId: sId, targetId: tId, sourceName };
}

function sessionIsConnected(paths, sessionId, settings = readSettings(paths)) {
  const id = safeSessionId(sessionId);
  const item = readSessionsIndex(paths).sessions.find((entry) => entry.id === id);
  if (!item) return false;
  return Boolean(sessionSummary(paths, item, settings).connected);
}

// Pick the session a freshly copied/started instruction should target. If the
// requested session already has a live agent (a connected waiter), this copy is
// almost certainly for a NEW conversation, so hand it a brand-new unique session.
// Two conversations sharing one session-id would deadlock on the single waiter
// lock (only one wait may own a session) and steal each other's queued messages.
function resolveInstructionSession(paths, settings, sessionId) {
  const requested = safeSessionId(sessionId || "agent-1");
  if (!sessionIsConnected(paths, requested, settings)) return { id: requested, created: false };
  try {
    const fresh = registerSession(paths);
    return { id: fresh.id, created: true };
  } catch {
    // At the concurrent-session cap: keep the requested id. The agent loop will
    // surface SESSION_BUSY so the user can free a slot or assign a unique id.
    return { id: requested, created: false };
  }
}

module.exports = {
  sessionSummary,
  getAllSessions,
  chooseRoundRobinSession,
  dispatchPayload,
  handoffSession,
  sessionIsConnected,
  resolveInstructionSession,
};
