"use strict";

// ---------------------------------------------------------------------------
// sessions — session index CRUD: create, delete, rename, override settings,
// pin project dir, auto-title. All mutations are serialised by a directory
// lock on .sessions.lock so concurrent panel requests can't lose entries.
//
// Depends on paths (sessionPaths), fs-utils (atomic IO + lock), shared
// (safeSessionId, nowMs), and settings (readSettings for maxConcurrentSessions).
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const { nowMs, safeSessionId } = require("../runtime/shared.js");
const { readJsonCached, writeJsonAtomic, withDirectoryLock, compactForUi } = require("./fs-utils.js");
const { sessionPaths } = require("./paths.js");
const { readSettings } = require("./settings.js");

function readSessionsIndex(paths) {
  const data = readJsonCached(paths.sessionsIndex, { sessions: [], roundRobinIndex: 0 });
  const index = data && typeof data === "object" ? data : { sessions: [], roundRobinIndex: 0 };
  if (!Array.isArray(index.sessions)) index.sessions = [];
  if (!Number.isInteger(index.roundRobinIndex)) index.roundRobinIndex = 0;
  return index;
}

function writeSessionsIndex(paths, index) {
  writeJsonAtomic(paths.sessionsIndex, index);
}

function ensureDefaultSession(paths) {
  const index = readSessionsIndex(paths);
  if (index.sessions.length > 0) return index.sessions[0];
  const item = {
    id: "agent-1",
    name: "会话 1",
    created_at: new Date().toISOString(),
    created_at_ms: nowMs(),
  };
  index.sessions.push(item);
  writeSessionsIndex(paths, index);
  fs.mkdirSync(sessionPaths(paths, item.id).dir, { recursive: true });
  return item;
}

function sessionsLockDir(paths) {
  return path.join(paths.stateDir, ".sessions.lock");
}

function registerSession(paths, name) {
  // Serialize sessions.json read-modify-write so concurrent create/delete/rename
  // from the panel can't lose an entry via last-writer-wins.
  return withDirectoryLock(sessionsLockDir(paths), () => {
    const settings = readSettings(paths);
    const index = readSessionsIndex(paths);
    if (index.sessions.length >= settings.maxConcurrentSessions) {
      throw new Error(`已达到最大并发会话数 ${settings.maxConcurrentSessions}。`);
    }
    // Sequence the display name off the highest existing "会话 N" number instead
    // of sessions.length, so deleting a middle session and re-creating doesn't
    // produce a duplicate "会话 4" that collides with an already-named sibling.
    // The internal id still carries a Date.now() suffix so it stays globally
    // unique regardless of the display number.
    const nextSeq = nextSessionSeq(index.sessions);
    const id = safeSessionId(`agent-${nextSeq}-${Date.now().toString(36)}`);
    const item = {
      id,
      name: name || `会话 ${nextSeq}`,
      created_at: new Date().toISOString(),
      created_at_ms: nowMs(),
    };
    index.sessions.push(item);
    writeSessionsIndex(paths, index);
    fs.mkdirSync(sessionPaths(paths, id).dir, { recursive: true });
    return item;
  });
}

// Pick the next display sequence number for a new session: one higher than the
// largest "会话 N" number currently in use (defaulting to 1 when none parse).
// This survives middle deletions -- e.g. after removing 会话 1 from [1,2,3,4],
// the next create yields 会话 5, not a colliding 会话 4.
function nextSessionSeq(sessions) {
  let max = 0;
  for (const s of sessions) {
    const m = /^(?:会话\s*)?(\d+)$/.exec(String(s.name || "").trim());
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

function removeSession(paths, sessionId) {
  const id = safeSessionId(sessionId);
  return withDirectoryLock(sessionsLockDir(paths), () => {
    const index = readSessionsIndex(paths);
    if (index.sessions.length <= 1) throw new Error("至少需要保留一个会话。");
    const next = index.sessions.filter((item) => item.id !== id);
    if (next.length === index.sessions.length) return false;
    index.sessions = next;
    writeSessionsIndex(paths, index);
    fs.rmSync(sessionPaths(paths, id).dir, { recursive: true, force: true });
    return true;
  });
}

function cleanSessionOverrides(raw) {
  const overrides = {};
  if (!raw || typeof raw !== "object") return overrides;
  const has = (value) => value !== undefined && value !== null && String(value).trim() !== "";
  if (has(raw.keepaliveSeconds)) {
    const value = Math.max(10, Number(raw.keepaliveSeconds) || 0);
    if (value) overrides.keepaliveSeconds = value;
  }
  if (has(raw.waitTimeoutSeconds)) {
    overrides.waitTimeoutSeconds = Math.max(0, Number(raw.waitTimeoutSeconds) || 0);
  }
  if (has(raw.pollSeconds)) {
    const value = Math.max(0.1, Number(raw.pollSeconds) || 0);
    if (value) overrides.pollSeconds = value;
  }
  return overrides;
}

function setSessionOverrides(paths, sessionId, raw) {
  const id = safeSessionId(sessionId);
  const overrides = cleanSessionOverrides(raw);
  return withDirectoryLock(sessionsLockDir(paths), () => {
    const index = readSessionsIndex(paths);
    const item = index.sessions.find((entry) => entry.id === id);
    if (!item) throw new Error("没有找到该会话。");
    if (Object.keys(overrides).length) item.overrides = overrides;
    else delete item.overrides;
    writeSessionsIndex(paths, index);
    return item;
  });
}

// Pin a session to a specific project directory within a multi-project workspace
// (empty clears it). Stored on the session index item so both the panel and the
// runtime (which prepends a scope note to that session's instructions) can read it.
function setSessionProject(paths, sessionId, dir) {
  const id = safeSessionId(sessionId);
  const clean = String(dir || "").trim();
  // Validate that the pinned directory lives inside the workspace root so a
  // session can't be silently scoped to an arbitrary outside path.
  if (clean) {
    const resolved = path.resolve(clean);
    const rel = path.relative(paths.workspaceRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("项目目录必须在工作区根目录之内。");
    }
  }
  return withDirectoryLock(sessionsLockDir(paths), () => {
    const index = readSessionsIndex(paths);
    const item = index.sessions.find((entry) => entry.id === id);
    if (!item) throw new Error("没有找到该会话。");
    if (clean) item.projectDir = clean;
    else delete item.projectDir;
    writeSessionsIndex(paths, index);
    return item;
  });
}

// Per-session keepalive/timeout/poll overrides win over the global settings when
// generating that session's wait command; everything else stays global.
function effectiveSessionSettings(paths, settings, sessionId) {
  const item = readSessionsIndex(paths).sessions.find((entry) => entry.id === safeSessionId(sessionId));
  const overrides = (item && item.overrides) || {};
  return { ...settings, ...overrides };
}

function renameSession(paths, sessionId, name) {
  const id = safeSessionId(sessionId);
  const clean = String(name || "").trim().slice(0, 60);
  if (!clean) throw new Error("会话名称不能为空。");
  return withDirectoryLock(sessionsLockDir(paths), () => {
    const index = readSessionsIndex(paths);
    const item = index.sessions.find((entry) => entry.id === id);
    if (!item) throw new Error("没有找到该会话。");
    item.name = clean;
    // A manual rename pins the name so the auto-title heuristic never overwrites it.
    item.nameManual = true;
    writeSessionsIndex(paths, index);
    return item;
  });
}

// Auto-name a session from the gist of its first instruction, so the panel shows
// a meaningful title instead of "会话 N" without the user typing anything. Only
// fills once and never overrides a manual rename (nameManual) or an existing
// auto-title -- so the title stays stable after the first task.
function maybeSetAutoTitle(paths, sessionId, text) {
  const gist = compactForUi(String(text || ""), 40);
  if (!gist) return;
  const id = safeSessionId(sessionId);
  try {
    withDirectoryLock(sessionsLockDir(paths), () => {
      const index = readSessionsIndex(paths);
      const item = index.sessions.find((entry) => entry.id === id);
      if (!item || item.nameManual || item.autoTitle) return;
      item.autoTitle = gist;
      writeSessionsIndex(paths, index);
    });
  } catch {
    // Best effort: a missed auto-title just leaves the default name.
  }
}

module.exports = {
  readSessionsIndex,
  writeSessionsIndex,
  ensureDefaultSession,
  sessionsLockDir,
  registerSession,
  removeSession,
  cleanSessionOverrides,
  setSessionOverrides,
  setSessionProject,
  effectiveSessionSettings,
  renameSession,
  maybeSetAutoTitle,
};
