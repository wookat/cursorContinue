#!/usr/bin/env node
"use strict";

// The multi-session bridge runtime (Node, the shell fallback transport).
//
// Why Node: the agent's terminal always has a Node binary reachable (locally the
// Cursor/Electron binary via ELECTRON_RUN_AS_NODE=1, on a Remote-SSH host the
// Cursor server's bundled node), whereas Python is not guaranteed and, on
// Windows, pays a heavy per-spawn antivirus cost -- which is why the former
// Python runtime was dropped in 1.0.1. The MCP server (mcp-server.js) reuses this
// file's queue/session/state machine, so both transports behave identically.
// Runs the same on Windows and Linux.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, spawn } = require("child_process");

// Constants + stateless data-contract helpers now live in shared.js, so this
// runtime and the extension host can never disagree on the queue item shape,
// the default settings, or the transient-fs set again. The classes below keep
// their own IO/caching, but use these shared primitives -- and MUST keep the
// lock semantics (mkdir + owner token) identical to extension.js.
const shared = require("./shared.js");
const {
  IMAGE_EXTENSIONS, TEXT_EXTENSIONS, TRANSIENT_FS_CODES,
  RENAME_RETRY_ATTEMPTS, RENAME_RETRY_BASE_DELAY, RENAME_RETRY_MAX_DELAY,
  BEST_EFFORT_ATTEMPTS, READ_RETRY_ATTEMPTS, LOCK_STALE_MS, LOCK_WAIT_SECONDS,
  BEACON_INTERVAL_MS, BEACON_STALE_MS, BEACON_MAX_LIFETIME_MS,
  DEFAULT_SETTINGS,
  nowMs, isoNow, sleepSync, isTransientFsError, retryTransient,
  captureAgentEnv, safeSessionId,
  normalizePayload, normalizeQueue, makeQueueItem, queueSignature,
  isProcessAlive, createQueueNotifier,
} = shared;

class ProjectState {
  constructor(stateDir) {
    this.stateDir = path.resolve(stateDir);
    this.sessionsDir = path.join(this.stateDir, "sessions");
    this.sessionsPath = path.join(this.stateDir, "sessions.json");
    this.settingsPath = path.join(this.stateDir, "settings.json");
    this.globalQueuePath = path.join(this.stateDir, "global_queue.json");
    this.globalQueueLock = path.join(this.stateDir, ".global_queue.lock");
    this.historyPath = path.join(this.stateDir, "history.jsonl");
  }

  ensure() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  readJson(filePath, fallback) {
    for (let attempt = 0; attempt < READ_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
      } catch (error) {
        if (error && (error.code === "ENOENT" || error instanceof SyntaxError)) return fallback;
        if (!isTransientFsError(error) || attempt === READ_RETRY_ATTEMPTS - 1) return fallback;
        sleepSync(20 * (attempt + 1));
      }
    }
    return fallback;
  }

  _tmpSuffix = null;
  writeJsonAtomic(filePath, data, attempts = RENAME_RETRY_ATTEMPTS) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!this._tmpSuffix) this._tmpSuffix = `${process.pid}.${crypto.randomUUID().replace(/-/g, "")}`;
    const tmp = `${filePath}.${this._tmpSuffix}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
      retryTransient(() => fs.renameSync(tmp, filePath), attempts);
    } finally {
      try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  }

  writeJsonBestEffort(filePath, data) {
    try {
      this.writeJsonAtomic(filePath, data, BEST_EFFORT_ATTEMPTS);
      return true;
    } catch {
      return false;
    }
  }

  _settingsSig = null;
  _settingsCache = null;
  settings() {
    let sig;
    try {
      const stat = fs.statSync(this.settingsPath);
      sig = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
    if (this._settingsSig === sig && this._settingsCache) return this._settingsCache;
    const data = this.readJson(this.settingsPath, {});
    this._settingsCache = { ...DEFAULT_SETTINGS, ...(data && typeof data === "object" ? data : {}) };
    this._settingsSig = sig;
    return this._settingsCache;
  }

  acquireLock(lockDir, timeoutSeconds = LOCK_WAIT_SECONDS, staleMs = LOCK_STALE_MS) {
    this.ensure();
    const started = Date.now();
    const token = `${process.pid}.${crypto.randomUUID().replace(/-/g, "")}`;
    for (;;) {
      try {
        fs.mkdirSync(lockDir, { recursive: false });
        // Stamp ownership so releaseLock only deletes a lock we still hold: after
        // a stale-takeover the original owner must not delete the successor's lock.
        try { fs.writeFileSync(path.join(lockDir, "owner"), token, "utf8"); } catch { /* best effort */ }
        return token;
      } catch (error) {
        if (error && error.code !== "EEXIST") throw error;
        try {
          const ageMs = nowMs() - fs.statSync(lockDir).mtimeMs;
          if (ageMs > staleMs) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (statError && statError.code === "ENOENT") continue;
        }
        if ((Date.now() - started) / 1000 > timeoutSeconds) throw new Error(`lock timeout: ${lockDir}`);
        sleepSync(40);
      }
    }
  }

  releaseLock(lockDir, token) {
    // With a token, only remove the lock if we still own it (don't delete a
    // successor's lock after a stale-takeover). Without one, keep old behavior.
    if (token) {
      let current = null;
      try { current = fs.readFileSync(path.join(lockDir, "owner"), "utf8"); } catch { /* missing */ }
      if (current !== null && current !== token) return;
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
  }

  _historyLimit = null;
  appendHistory(record, limit) {
    this.ensure();
    const line = `${JSON.stringify(record)}\n`;
    try {
      retryTransient(() => fs.appendFileSync(this.historyPath, line, "utf8"), BEST_EFFORT_ATTEMPTS);
    } catch {
      return;
    }
    if (this._historyLimit === null) this._historyLimit = Number(this.settings().historyLimit || 200);
    this.trimJsonl(this.historyPath, limit || this._historyLimit);
  }

  trimJsonl(filePath, limit) {
    if (!limit || limit <= 0) return;
    try {
      // Skip the full read+parse when the file is clearly under the limit (~512
      // bytes per line heuristic). Avoids reading the whole file on every append.
      const stat = fs.statSync(filePath);
      if (stat.size < limit * 512) return;
      // Stream-friendly trim: read a tail chunk sized to comfortably hold
      // `limit` lines (capped so we never read more than 8MB just to trim).
      // If the chunk yields enough lines we avoid loading the whole file.
      const tailBudget = Math.min(Math.max(limit * 1024, 65536), 8 * 1024 * 1024);
      const start = Math.max(0, stat.size - tailBudget);
      const length = stat.size - start;
      let text;
      {
        const fd = fs.openSync(filePath, "r");
        try {
          const buf = Buffer.alloc(length);
          fs.readSync(fd, buf, 0, length, start);
          text = buf.toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
      }
      let lines = text.split(/\r?\n/).filter(Boolean);
      // Drop the first line if we started mid-file (it is likely partial).
      if (text.length === tailBudget && stat.size > tailBudget && lines.length > 1) {
        lines = lines.slice(1);
      }
      if (lines.length < limit) {
        // Tail chunk didn't hold enough lines (very long lines) — fall back to a
        // full read. This is rare and only happens once per trim cycle.
        lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
      }
      if (lines.length <= limit) return;
      // Atomic rewrite (tmp + rename) so a concurrent append from another process
      // can't be clobbered by a partial trim write.
      const tmp = `${filePath}.${this._tmpSuffix || (this._tmpSuffix = `${process.pid}.${crypto.randomUUID().replace(/-/g, "")}`)}.tmp`;
      try {
        fs.writeFileSync(tmp, `${lines.slice(-limit).join("\n")}\n`, "utf8");
        retryTransient(() => fs.renameSync(tmp, filePath), BEST_EFFORT_ATTEMPTS);
      } finally {
        try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      }
    } catch {
      /* best effort */
    }
  }

  sessionsIndex() {
    const data = this.readJson(this.sessionsPath, { sessions: [], roundRobinIndex: 0 });
    const index = data && typeof data === "object" ? data : { sessions: [], roundRobinIndex: 0 };
    if (!Array.isArray(index.sessions)) index.sessions = [];
    if (!Number.isInteger(index.roundRobinIndex)) index.roundRobinIndex = 0;
    return index;
  }

  saveSessionsIndex(index) {
    this.writeJsonAtomic(this.sessionsPath, index);
  }

  registerSession(sessionId, name) {
    this.ensure();
    const id = safeSessionId(sessionId);
    const index = this.sessionsIndex();
    const existing = index.sessions.find((item) => item.id === id);
    if (existing) {
      if (name && existing.name !== name) {
        existing.name = name;
        this.saveSessionsIndex(index);
      }
      return existing;
    }
    const item = { id, name: name || id, created_at: isoNow(), created_at_ms: nowMs() };
    index.sessions.push(item);
    this.saveSessionsIndex(index);
    new SessionState(this, id).ensure();
    return item;
  }

  session(sessionId) {
    const id = safeSessionId(sessionId);
    this.registerSession(id);
    return new SessionState(this, id);
  }

  readGlobalQueue() {
    return normalizeQueue(this.readJson(this.globalQueuePath, []));
  }

  enqueueGlobal(payload, source = "manual") {
    const lockToken = this.acquireLock(this.globalQueueLock);
    let item;
    try {
      const queue = this.readGlobalQueue();
      const limit = Number(this.settings().globalQueueLimit || 20) || 20;
      if (queue.length >= limit) throw new Error(`空闲优先队列已达到上限 ${limit}。`);
      item = makeQueueItem(payload, source, "idle-first");
      queue.push(item);
      this.writeJsonAtomic(this.globalQueuePath, queue);
    } finally {
      this.releaseLock(this.globalQueueLock, lockToken);
    }
    this.appendHistory({ type: "queued_global", ...item });
    return item;
  }

  popGlobal() {
    if (!this.readGlobalQueue().length) return [null, 0, true];
    let lockToken = null;
    try {
      lockToken = this.acquireLock(this.globalQueueLock);
      const queue = this.readGlobalQueue();
      if (!queue.length) return [null, 0, true];
      const item = queue.shift();
      this.writeJsonAtomic(this.globalQueuePath, queue);
      return [item, queue.length, true];
    } catch {
      // Lock busy or write failed -> inconclusive. Signal the caller to retry
      // without advancing the queue signature, so the item is not skipped.
      return [null, 0, false];
    } finally {
      if (lockToken) this.releaseLock(this.globalQueueLock, lockToken);
    }
  }

  clearGlobal() {
    const lockToken = this.acquireLock(this.globalQueueLock);
    try {
      this.writeJsonAtomic(this.globalQueuePath, []);
    } finally {
      this.releaseLock(this.globalQueueLock, lockToken);
    }
    this.appendHistory({ type: "global_queue_cleared", at: isoNow() });
  }

  statusSummary() {
    const settings = this.settings();
    const offlineAfterMs = Number(settings.offlineAfterSeconds || 15) * 1000;
    const sessions = this.sessionsIndex().sessions.map((item) => new SessionState(this, item.id).summary(item, offlineAfterMs));
    return {
      settings,
      sessions,
      global_queue_length: this.readGlobalQueue().length,
    };
  }
}

class SessionState {
  constructor(project, sessionId) {
    this.project = project;
    this.sessionId = safeSessionId(sessionId);
    this.dir = path.join(project.sessionsDir, this.sessionId);
    this.queuePath = path.join(this.dir, "queue.json");
    this.statusPath = path.join(this.dir, "status.json");
    this.historyPath = path.join(this.dir, "history.jsonl");
    this.queueLockDir = path.join(this.dir, ".queue.lock");
    this.waiterLockDir = path.join(this.dir, "waiter.lock");
    this.presencePath = path.join(this.dir, "presence.json");
  }

  ensure() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  readJson(filePath, fallback) {
    return this.project.readJson(filePath, fallback);
  }

  writeJsonBestEffort(filePath, data) {
    return this.project.writeJsonBestEffort(filePath, data);
  }

  queue() {
    return normalizeQueue(this.readJson(this.queuePath, []));
  }

  // Cached queue length keyed by stat signature, so writeStatus's heartbeat
  // path doesn't re-read+parse the queue file when it hasn't changed.
  _queueLenSig = null;
  _queueLenCache = 0;
  queueLengthCached() {
    let sig;
    try {
      const stat = fs.statSync(this.queuePath);
      sig = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return 0;
    }
    if (this._queueLenSig === sig) return this._queueLenCache;
    const len = this.queue().length;
    this._queueLenSig = sig;
    this._queueLenCache = len;
    return len;
  }

  _historyLimit = null;
  appendHistory(record) {
    this.ensure();
    const line = `${JSON.stringify(record)}\n`;
    try {
      retryTransient(() => fs.appendFileSync(this.historyPath, line, "utf8"), BEST_EFFORT_ATTEMPTS);
    } catch {
      return;
    }
    if (this._historyLimit === null) this._historyLimit = Number(this.project.settings().historyLimit || 200);
    this.project.trimJsonl(this.historyPath, this._historyLimit);
  }

  enqueue(payload, source = "manual") {
    const lockToken = this.project.acquireLock(this.queueLockDir);
    let item;
    try {
      const queue = this.queue();
      const limit = Number(this.project.settings().perSessionQueueLimit || 3) || 3;
      if (queue.length >= limit) throw new Error(`${this.sessionId} 的队列已达到上限 ${limit}。`);
      item = makeQueueItem(payload, source, this.sessionId);
      queue.push(item);
      this.project.writeJsonAtomic(this.queuePath, queue);
    } finally {
      this.project.releaseLock(this.queueLockDir, lockToken);
    }
    this.appendHistory({ type: "queued", ...item });
    this.project.appendHistory({ type: "queued_session", session_id: this.sessionId, ...item });
    return item;
  }

  popNext() {
    if (!this.queue().length) return [null, 0, true];
    let lockToken = null;
    try {
      lockToken = this.project.acquireLock(this.queueLockDir);
      const queue = this.queue();
      if (!queue.length) return [null, 0, true];
      const item = queue.shift();
      this.project.writeJsonAtomic(this.queuePath, queue);
      return [item, queue.length, true];
    } catch {
      // Lock busy or write failed -> inconclusive. Signal the caller to retry
      // without advancing the queue signature, so the item is not skipped.
      return [null, 0, false];
    } finally {
      if (lockToken) this.project.releaseLock(this.queueLockDir, lockToken);
    }
  }

  _waiterCache = null;
  currentWaiter() {
    if (this._waiterCache) return this._waiterCache;
    const owner = this.readJson(path.join(this.waiterLockDir, "owner.json"), null);
    this._waiterCache = owner;
    return owner;
  }

  writeWaiterOwner(runId) {
    const owner = {
      pid: process.pid,
      session_id: this.sessionId,
      run_id: runId,
      heartbeat_ms: nowMs(),
      heartbeat_at: isoNow(),
    };
    const ok = this.writeJsonBestEffort(path.join(this.waiterLockDir, "owner.json"), owner);
    if (ok) this._waiterCache = owner;
    return [ok, owner];
  }

  acquireWaiter(runId) {
    this.ensure();
    for (;;) {
      try {
        fs.mkdirSync(this.waiterLockDir, { recursive: false });
      } catch (error) {
        if (error && error.code !== "EEXIST") throw error;
        const owner = this.currentWaiter() || {};
        const heartbeatMs = Number(owner.heartbeat_ms || 0);
        const ageMs = heartbeatMs ? nowMs() - heartbeatMs : LOCK_STALE_MS + 1;
        if (ageMs > LOCK_STALE_MS) {
          fs.rmSync(this.waiterLockDir, { recursive: true, force: true });
          continue;
        }
        return [false, owner];
      }
      // We hold the lock dir; persist ownership or back out. A missing owner.json
      // would otherwise be misread as a stale lock by a rival waiter (heartbeat
      // absent -> treated as expired), allowing two waiters for one session.
      const [ok, owner] = this.writeWaiterOwner(runId);
      if (!ok) {
        fs.rmSync(this.waiterLockDir, { recursive: true, force: true });
        return [false, owner];
      }
      return [true, owner];
    }
  }

  refreshWaiter(runId) {
    const owner = this.currentWaiter() || {};
    if (owner.run_id === runId) this.writeWaiterOwner(runId);
  }

  releaseWaiter(runId) {
    const owner = this.currentWaiter() || {};
    if (owner.run_id === runId) fs.rmSync(this.waiterLockDir, { recursive: true, force: true });
    this._waiterCache = null;
  }

  _lastStatus = null;
  writeStatus(runId, state, extra = {}) {
    // Reuse the last-written status as the base instead of re-reading
    // status.json every heartbeat. Only one waiter owns the session, so
    // there's no concurrent writer to invalidate our cache.
    const status = this._lastStatus ? { ...this._lastStatus } : this.readJson(this.statusPath, {});
    Object.assign(status, {
      protocol: 6,
      session_id: this.sessionId,
      run_id: runId,
      state,
      pid: process.pid,
      heartbeat_ms: nowMs(),
      heartbeat_at: isoNow(),
      queue_length: this.queueLengthCached(),
      queue_path: this.queuePath,
      status_path: this.statusPath,
      waiter: this.currentWaiter(),
    }, extra);
    this.writeJsonBestEffort(this.statusPath, status);
    this._lastStatus = status;
  }

  recordResult(summary, resultStatus = "done", runId = null) {
    const text = String(summary || "").trim();
    if (!text) return;
    if (!["done", "need_input", "error"].includes(resultStatus)) resultStatus = "done";
    this.appendHistory({
      type: "result", session_id: this.sessionId, run_id: runId,
      status: resultStatus, summary: text.slice(0, 2000), at: isoNow(),
    });
    this.project.appendHistory({
      type: "result", session_id: this.sessionId, status: resultStatus,
      summary_preview: text.slice(0, 240), at: isoNow(),
    });
    const status = this.readJson(this.statusPath, {});
    Object.assign(status, {
      last_result: text.slice(0, 1000),
      last_result_status: resultStatus,
      last_result_at: isoNow(),
      last_result_at_ms: nowMs(),
    });
    this.writeJsonBestEffort(this.statusPath, status);
  }

  status() {
    const status = this.readJson(this.statusPath, {});
    status.queue_length = this.queue().length;
    return status;
  }

  summary(indexItem, offlineAfterMs) {
    const status = this.status();
    const heartbeatMs = Number(status.heartbeat_ms || 0);
    const heartbeatAgeMs = heartbeatMs ? nowMs() - heartbeatMs : null;
    const connected = status.state === "waiting" && heartbeatAgeMs !== null && heartbeatAgeMs <= offlineAfterMs;
    return {
      id: this.sessionId,
      name: indexItem.name || this.sessionId,
      created_at: indexItem.created_at,
      state: status.state || "new",
      connected,
      heartbeat_age_ms: heartbeatAgeMs,
      queue_length: status.queue_length || 0,
      last_ack_id: status.last_ack_id || "",
      last_ack_at: status.last_ack_at || "",
      last_message_preview: status.last_message_preview || "",
      conversation_id: status.conversation_id || "",
      workspace_label: status.workspace_label || "",
      waiter: status.waiter || null,
    };
  }
}

const MAX_TEXT_CONTEXT_BYTES = 256 * 1024;

// If workspaceRoot is known, return a visible warning tag when a resolved path
// falls outside it. This makes it obvious to both the user and the agent when a
// referenced file lives beyond the project boundary (e.g. via ~ expansion),
// without blocking legitimate cross-directory references.
function isOutsideWorkspace(target, workspaceRoot) {
  if (!workspaceRoot) return "";
  try {
    const rel = path.relative(workspaceRoot, target);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return "";
    return "\n[注意：该路径位于工作区目录之外]";
  } catch {
    return "";
  }
}

function readTextFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_TEXT_CONTEXT_BYTES) {
      // Cap inlined attachment context so an oversized file can't flood the
      // agent's stdout / memory; read only the first chunk.
      const fd = fs.openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(MAX_TEXT_CONTEXT_BYTES);
        const bytes = fs.readSync(fd, buf, 0, MAX_TEXT_CONTEXT_BYTES, 0);
        return `${buf.toString("utf8", 0, bytes)}\n[...内容过长已截断：文件共 ${stat.size} 字节，仅显示前 ${MAX_TEXT_CONTEXT_BYTES} 字节...]`;
      } finally {
        fs.closeSync(fd);
      }
    }
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return `[读取失败: ${error.message}]`;
  }
}

function renderFileContext(filePath, workspaceRoot) {
  const target = path.resolve(filePath.replace(/^~(?=$|[\\/])/, os.homedir()));
  const outsideNote = isOutsideWorkspace(target, workspaceRoot);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return `\n\n[文件不存在: ${target}]${outsideNote}`;
  }
  if (stat.isDirectory()) {
    let children;
    try {
      children = fs.readdirSync(target).map((child) => path.join(target, child)).sort();
    } catch (error) {
      children = [`[读取目录失败: ${error.message}]`];
    }
    return `\n\n[目录上下文: ${target}]${outsideNote}\n${children.slice(0, 300).join("\n")}\n[/目录上下文]`;
  }
  if (!stat.isFile()) return `\n\n[文件不存在: ${target}]${outsideNote}`;
  const ext = path.extname(target).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return renderImageContext(target, workspaceRoot);
  if (!TEXT_EXTENSIONS.has(ext)) return `\n\n[附件路径: ${target}]${outsideNote}`;
  return `\n\n[文件上下文: ${target}]${outsideNote}\n${readTextFile(target)}\n[/文件上下文]`;
}

// Directories that would flood a folder tree with generated / vendored files;
// skipped when rendering a referenced folder so the tree stays useful.
const FOLDER_SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "out", "build", ".next",
  ".nuxt", ".venv", "venv", "__pycache__", ".cache", ".idea", ".vscode-test",
  "coverage", ".gradle", "target", "bin", "obj", ".turbo", ".parcel-cache",
]);
const FOLDER_MAX_ENTRIES = 400;
const FOLDER_MAX_DEPTH = 4;

// Render a referenced folder as a bounded, readable tree so the agent learns the
// structure without flooding stdout. Depth- and count-capped, skips heavy vendor
// dirs, and marks where it truncated. The agent uses its own tools to open files.
function renderFolderContext(folderPath, workspaceRoot) {
  const root = path.resolve(String(folderPath).replace(/^~(?=$|[\\/])/, os.homedir()));
  const outsideNote = isOutsideWorkspace(root, workspaceRoot);
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch {
    return `\n\n[文件夹不存在: ${root}]${outsideNote}`;
  }
  if (!rootStat.isDirectory()) return renderFileContext(root, workspaceRoot);

  const lines = [];
  let count = 0;
  let truncated = false;
  // Track canonical (realpath) directories we've already walked to detect
  // symlink cycles. Without this a self-referencing symlink would loop until
  // FOLDER_MAX_ENTRIES is hit, flooding the output with repeated entries.
  const visited = new Set();
  const walk = (dir, prefix, depth) => {
    if (truncated) return;
    let realDir;
    try { realDir = fs.realpathSync(dir); } catch { realDir = dir; }
    if (visited.has(realDir)) {
      lines.push(`${prefix}[循环已跳过]`);
      count += 1;
      return;
    }
    visited.add(realDir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      lines.push(`${prefix}[读取失败: ${error.message}]`);
      return;
    }
    // Directories first, then files; each alphabetically -- a stable, scannable order.
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (count >= FOLDER_MAX_ENTRIES) { truncated = true; return; }
      const isDir = entry.isDirectory();
      if (isDir && FOLDER_SKIP_DIRS.has(entry.name)) {
        lines.push(`${prefix}${entry.name}/  [已跳过]`);
        count += 1;
        continue;
      }
      lines.push(`${prefix}${entry.name}${isDir ? "/" : ""}`);
      count += 1;
      if (isDir) {
        if (depth + 1 <= FOLDER_MAX_DEPTH) walk(path.join(dir, entry.name), `${prefix}  `, depth + 1);
        else lines.push(`${prefix}  …（更深层级已省略）`);
      }
    }
  };
  walk(root, "", 1);
  const note = truncated ? `\n…（条目超过 ${FOLDER_MAX_ENTRIES} 项已截断；请用文件工具浏览更多）` : "";
  const body = lines.length ? lines.join("\n") : "（空文件夹）";
  return `\n\n[文件夹上下文: ${root}]${outsideNote}\n${body}${note}\n[/文件夹上下文]`;
}

function renderImageContext(filePath, workspaceRoot) {
  let target = path.resolve(filePath.replace(/^~(?=$|[\\/])/, os.homedir()));
  const outsideNote = isOutsideWorkspace(target, workspaceRoot);
  try {
    if (!fs.statSync(target).isFile()) return `\n\n[图片不存在: ${target}]${outsideNote}`;
  } catch {
    return `\n\n[图片不存在: ${target}]${outsideNote}`;
  }
  const name = path.basename(target);
  return (
    `\n\n[图片上下文: ${name}]${outsideNote}\n` +
    "图片已保存到本地。请使用 Read / 读取文件工具打开下面的路径来查看图像内容" +
    "（这是真实的图片文件，不要当作纯文本或尝试手动解码）：\n" +
    `${target}\n` +
    "[/图片上下文]"
  );
}

function renderPayload(payload, workspaceRoot) {
  const status = payload.status || "continue";
  if (status === "stop") return "stop";
  const parts = [];
  if (payload.selected_choice) parts.push(`已选择: ${payload.selected_choice}`);
  if (payload.user_input) parts.push(payload.user_input);
  for (const filePath of payload.file_paths || []) parts.push(renderFileContext(filePath, workspaceRoot));
  for (const folderPath of payload.folder_paths || []) parts.push(renderFolderContext(folderPath, workspaceRoot));
  for (const imagePath of payload.image_paths || []) parts.push(renderImageContext(imagePath, workspaceRoot));
  if ((payload.suggested_tools || []).length) parts.push(`\n建议工具: ${payload.suggested_tools.join(", ")}`);
  return parts.filter(Boolean).join("\n").trim();
}

function keepaliveMessage(sessionId, rerunCmd) {
  const cmd = rerunCmd ? `\n\n请立即执行以下命令重新进入等待：\n\`${rerunCmd}\`` : "\n请立刻重新运行同一条 wait 命令";
  return `KEEPALIVE_NOOP:
当前没有新的用户指令。请不要修改项目，也不要总结，只需要继续保持这个 Cursor 对话可用。${cmd}，继续等待会话 ${sessionId} 的下一条插件消息。`;
}

function buildRerunCmd(project, sessionId, timeoutSeconds, keepaliveSeconds, pollSeconds, report, reportStatus) {
  const script = process.argv[1] || "";
  const stateDir = project.stateDir;
  // Escape a value for use inside a double-quoted shell argument. Backslashes
  // are left literal (Windows paths rely on that); only the characters that can
  // break out of the double-quote context are escaped.
  const q = (v) => `"${String(v).replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
  const parts = [
    `node ${q(script)} wait`,
    `--state-dir ${q(stateDir)}`,
    `--session-id ${q(sessionId)}`,
    `--keepalive ${q(keepaliveSeconds)}`,
    `--timeout ${q(timeoutSeconds)}`,
    `--poll ${q(pollSeconds)}`,
  ];
  if (report) parts.push(`--report ${q(report)}`);
  if (reportStatus && reportStatus !== "done") parts.push(`--report-status ${q(reportStatus)}`);
  return parts.join(" ");
}

function sessionBusyMessage(sessionId, ownerPid) {
  const pid = ownerPid ? `pid ${ownerPid}` : "另一个进程";
  // Keep the English phrase below so any older detection still matches.
  return `SESSION_BUSY:
会话 ${sessionId} 已有一个活动的等待进程（${pid}），通常是另一个 Cursor 对话也在用同一个 session-id。
为避免两个对话互相抢消息，同一个会话同时只允许一个 wait（another instruction waiter is already active for this session）。
请不要重复运行 wait、也不要去结束其它进程；请在续聊助手面板为本对话新建一个会话并复制其启动指令重开本循环，或让本对话改用一个唯一的 --session-id。`;
}

// queueSignature / createQueueNotifier / isProcessAlive and the BEACON_* cadence
// constants are imported from shared.js at the top of this file.

// --- Presence beacon ----------------------------------------------------------
// During the agent's work between two `wait` calls no plugin process runs, so the
// session has no heartbeat and the panel can't tell "working" from "interrupted".
// The beacon fills that gap: a tiny detached process, launched transparently by
// `wait`, that writes a presence heartbeat for the whole session lifetime and
// self-terminates when the launching shell dies (terminal closed / conversation
// interrupted). The panel then reads presence.json: fresh + no waiter == working;
// stale == the terminal went away, i.e. interrupted -- detected within ~one
// interval instead of a multi-minute time guess. (The MCP transport can't spawn a
// terminal-bound beacon, so mcp-server.js writes an equivalent presence heartbeat
// itself; both use the shared BEACON_* cadence so the panel's staleness math matches.)
function spawnBeaconIfNeeded(project, session) {
  try {
    const existing = session.readJson(session.presencePath, null);
    if (existing && Number(existing.heartbeat_ms || 0)
        && (nowMs() - Number(existing.heartbeat_ms)) <= BEACON_STALE_MS
        && isProcessAlive(existing.pid)) {
      return; // a live beacon already covers this session
    }
    const script = process.argv[1];
    if (!script) return;
    const child = spawn(process.execPath, [
      script, "beacon",
      "--state-dir", project.stateDir,
      "--session-id", session.sessionId,
      "--watch-ppid", String(process.ppid || 0),
      "--interval", String(Math.round(BEACON_INTERVAL_MS / 1000)),
    ], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch {
    // Best effort: without a beacon the panel just falls back to the time threshold.
  }
}

async function runBeacon(project, sessionId, watchPpid, intervalMs) {
  const session = project.session(sessionId);
  // Dedupe: stand aside if a fresh beacon from another process already covers this
  // session, so beacons never pile up across wait cycles.
  const existing = session.readJson(session.presencePath, null);
  if (existing && existing.pid !== process.pid && Number(existing.heartbeat_ms || 0)
      && (nowMs() - Number(existing.heartbeat_ms)) <= BEACON_STALE_MS
      && isProcessAlive(existing.pid)) {
    return 0;
  }
  let stop = false;
  const onSignal = () => { stop = true; };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const interval = Math.max(1000, Number(intervalMs) || BEACON_INTERVAL_MS);
  const startedMs = nowMs();
  const ppid = Number(watchPpid) || 0;
  while (!stop) {
    // The launching shell vanishing (terminal closed / conversation interrupted)
    // is the cue to exit, so presence.json goes stale within ~one interval.
    if (ppid > 0 && !isProcessAlive(ppid)) break;
    if (nowMs() - startedMs > BEACON_MAX_LIFETIME_MS) break;
    session.writeJsonBestEffort(session.presencePath, {
      beacon: true,
      pid: process.pid,
      watch_ppid: ppid,
      heartbeat_ms: nowMs(),
      heartbeat_at: isoNow(),
      interval_ms: interval,
    });
    await sleep(interval);
  }
  return 0;
}

async function waitForInstruction(project, sessionId, timeoutSeconds, keepaliveSeconds, pollSeconds, report = null, reportStatus = "done") {
  sessionId = safeSessionId(sessionId);
  project.registerSession(sessionId);
  const session = project.session(sessionId);
  const runId = crypto.randomUUID().replace(/-/g, "");
  if (report) {
    session.recordResult(report, reportStatus, runId);
    notifyWebhookResult(project, sessionId, report, reportStatus, { transport: "shell" });
  }
  const [acquired, owner] = session.acquireWaiter(runId);
  if (!acquired) {
    session.writeStatus(runId, "busy", { last_error: "another waiter is already active", active_waiter: owner });
    console.log(sessionBusyMessage(sessionId, owner && owner.pid));
    return 3;
  }

  const startedAtMs = nowMs();
  const deadline = timeoutSeconds <= 0 ? null : Date.now() + timeoutSeconds * 1000;
  const keepaliveDeadline = keepaliveSeconds <= 0 ? null : Date.now() + keepaliveSeconds * 1000;
  const offlineAfter = Number(project.settings().offlineAfterSeconds || 15);
  const heartbeatInterval = Math.max(1.0, Math.min(5.0, offlineAfter / 3.0, LOCK_STALE_MS / 3000.0)) * 1000;
  // Auto-capture the Cursor conversation identity from the agent terminal's
  // environment. Cursor sets CURSOR_CONVERSATION_ID (and friends) for its
  // agent-exec terminals, so the panel can show / reference the exact chat with
  // zero manual entry and without reading Cursor's private SQLite store. Written
  // once here; writeStatus reuses _lastStatus as its base, so it persists across
  // every later heartbeat write.
  const agentEnv = captureAgentEnv();
  session.writeStatus(runId, "waiting", {
    started_at: isoNow(),
    last_ack_id: null,
    keepalive_deadline_ms: keepaliveDeadline,
    conversation_id: agentEnv.conversation_id,
    workspace_label: agentEnv.workspace_label,
    cursor_agent: agentEnv.cursor_agent,
  });
  // Launch (once per session) the detached presence beacon so the panel can see
  // real "working vs interrupted" state during the agent's work between waits.
  spawnBeaconIfNeeded(project, session);
  process.stdout.write(`[续聊助手] 会话 ${sessionId} 已进入等待状态，正在轮询队列…\n`);
  let lastHeartbeat = Date.now();
  let spinnerActive = false;
  let lastSpinnerBeat = Date.now();
  let spinnerIdx = 0;
  const spinnerChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  // Adaptive heartbeat. A real terminal (TTY) gets the per-second \r spinner so a
  // human watching sees a live animation. But when stdout is a pipe -- which is
  // how the Cursor Shell tool captures the agent's command -- \r and ANSI escapes
  // are NOT folded onto one line: they pile up at ~1 line/sec (≈300 lines per
  // 300s keepalive cycle) and the clear sequence leaks a literal "[K" right before
  // the result. So when not a TTY we emit a plain newline heartbeat far less
  // often: still enough output to prove the process is alive (the Shell tool never
  // flags a hang), but ~10x less captured noise for the agent to read past.
  const isTty = Boolean(process.stdout.isTTY);
  const spinnerIntervalMs = isTty ? 1000 : 10000;
  function clearSpinner() {
    // Only the TTY spinner leaves an unterminated line to wipe; the piped
    // heartbeat already ends each line with \n, so there is nothing to clear
    // (and we must not emit ANSI there, or it leaks as a literal "[K").
    if (spinnerActive && isTty) { process.stdout.write("\r\x1b[K"); }
    spinnerActive = false;
  }
  function writeSpinner() {
    const elapsed = Math.floor((Date.now() - startedAtMs) / 1000);
    if (isTty) {
      const ch = spinnerChars[spinnerIdx % spinnerChars.length];
      spinnerIdx++;
      process.stdout.write(`\r${ch} [续聊助手] 等待中… ${elapsed}s`);
      spinnerActive = true;
    } else {
      process.stdout.write(`[续聊助手] 等待中… ${elapsed}s\n`);
    }
  }
  let lastSessionSig = "init";
  let lastGlobalSig = "init";

  // P-3 adaptive poll: fast while active, gradually slower (up to maxPoll) after
  // a stretch of idleness, snapping back to base on any queue change.
  const basePoll = Math.max(50, (Number(pollSeconds) || 0.2) * 1000);
  const maxPoll = Math.max(basePoll, Math.min(1000, basePoll * 5));
  const idleBackoffAfter = 10000;
  let currentPoll = basePoll;
  let lastActivity = Date.now();

  // Wake the instant a queue file changes; the adaptive poll above degrades to a
  // safety-net for platforms/filesystems where fs.watch delivers nothing.
  const notifier = createQueueNotifier([
    { dir: session.dir, file: path.basename(session.queuePath) },
    { dir: project.stateDir, file: path.basename(project.globalQueuePath) },
  ]);

  try {
    for (;;) {
      const now = Date.now();
      if (now - lastSpinnerBeat >= spinnerIntervalMs) {
        writeSpinner();
        lastSpinnerBeat = now;
      }
      if (now - lastHeartbeat >= heartbeatInterval) {
        session.refreshWaiter(runId);
        session.writeStatus(runId, "waiting", { uptime_ms: nowMs() - startedAtMs, keepalive_deadline_ms: keepaliveDeadline });
        lastHeartbeat = now;
      }

      let item = null;
      let remaining = 0;
      let sourceQueue = "session";
      const sessionSig = queueSignature(session.queuePath);
      if (sessionSig !== lastSessionSig) {
        const [popped, poppedRemaining, conclusive] = session.popNext();
        // Advance the signature only once the pop conclusively succeeded or
        // confirmed the queue empty; a transient lock-busy / failed write leaves
        // it stale so the next iteration retries instead of skipping the item.
        if (conclusive) lastSessionSig = sessionSig;
        if (popped) {
          item = popped;
          remaining = poppedRemaining;
          lastActivity = now;
          currentPoll = basePoll;
        }
      }
      if (!item) {
        const globalSig = queueSignature(project.globalQueuePath);
        if (globalSig !== lastGlobalSig) {
          const [popped, poppedRemaining, conclusive] = project.popGlobal();
          if (conclusive) lastGlobalSig = globalSig;
          if (popped) {
            item = popped;
            remaining = poppedRemaining;
            lastActivity = now;
            currentPoll = basePoll;
            sourceQueue = "global";
          }
        }
      }
      if (item) {
        const payload = normalizePayload(item);
        // stateDir is <workspace>/.cursor/local-continue-state -> workspace root is two levels up.
        const wsRoot = path.dirname(path.dirname(project.stateDir));
        const rendered = renderPayload(payload, wsRoot);
        const ack = {
          id: item.id,
          payload,
          source: item.source,
          source_queue: sourceQueue,
          received_at: isoNow(),
          received_at_ms: nowMs(),
          remaining_queue_length: remaining,
          session_id: sessionId,
          run_id: runId,
          message_preview: rendered.slice(0, 160),
        };
        session.appendHistory({ type: "received", ...ack });
        project.appendHistory({ type: "received", ...ack });
        session.writeStatus(runId, "received", {
          last_ack_id: ack.id,
          last_ack_at: ack.received_at,
          last_message_preview: ack.message_preview,
          remaining_queue_length: remaining,
          uptime_ms: nowMs() - startedAtMs,
        });
        clearSpinner();
        process.stdout.write(`${applySessionScope(project, sessionId, rendered)}\n`);
        return 0;
      }

      if (deadline !== null && Date.now() >= deadline) {
        session.writeStatus(runId, "timeout", { uptime_ms: nowMs() - startedAtMs });
        clearSpinner();
        console.log("timeout waiting for instruction");
        return 2;
      }

      if (keepaliveDeadline !== null && Date.now() >= keepaliveDeadline) {
        session.appendHistory({ type: "keepalive", session_id: sessionId, run_id: runId, at: isoNow() });
        session.writeStatus(runId, "keepalive", { last_message_preview: "KEEPALIVE_NOOP", uptime_ms: nowMs() - startedAtMs });
        const rerunCmd = buildRerunCmd(project, sessionId, timeoutSeconds, keepaliveSeconds, pollSeconds, report, reportStatus);
        clearSpinner();
        process.stdout.write(`${keepaliveMessage(sessionId, rerunCmd)}\n`);
        return 4;
      }

      if (now - lastActivity >= idleBackoffAfter) {
        currentPoll = Math.min(maxPoll, currentPoll * 1.5);
      }
      // Sleep until a queue change wakes us (fs.watch) or the bounded interval
      // elapses -- whichever comes first. The cap is the smallest of the poll
      // cadence and the time left until the next heartbeat / keepalive / timeout,
      // so those deadlines still fire on schedule. With fs.watch active the poll
      // is only a safety-net, so we relax it to maxPoll to save wakeups.
      let waitMs = notifier.active ? maxPoll : currentPoll;
      const untilHeartbeat = heartbeatInterval - (now - lastHeartbeat);
      if (untilHeartbeat < waitMs) waitMs = untilHeartbeat;
      if (deadline !== null) waitMs = Math.min(waitMs, deadline - now);
      if (keepaliveDeadline !== null) waitMs = Math.min(waitMs, keepaliveDeadline - now);
      await notifier.wait(Math.max(1, waitMs));
    }
  } finally {
    notifier.close();
    session.releaseWaiter(runId);
  }
}

// --- F-6 doctor ---------------------------------------------------------------
function timeSubprocess(cmd, args) {
  const start = process.hrtime.bigint();
  let result;
  // A bare command name (node) needs shell PATH/PATHEXT resolution on Windows;
  // an absolute path (process.execPath, which may contain spaces) must NOT go
  // through the shell or the space breaks the command.
  const useShell = process.platform === "win32" && !path.isAbsolute(cmd);
  try {
    result = spawnSync(cmd, args, { encoding: "utf8", timeout: 60000, shell: useShell });
  } catch (error) {
    return { ok: false, ms: null, error: error.message, out: "" };
  }
  if (result.error) {
    const code = result.error.code === "ENOENT" ? "命令未找到" : result.error.message;
    return { ok: false, ms: null, error: code, out: "" };
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const out = ((result.stdout || "").trim() || (result.stderr || "").trim()).slice(0, 200);
  const ok = result.status === 0;
  return { ok, ms, error: ok ? null : `退出码 ${result.status}`, out };
}

function checkStateWritable(project) {
  const probe = path.join(project.stateDir, `.doctor-${process.pid}-${crypto.randomUUID().replace(/-/g, "")}.tmp`);
  const start = process.hrtime.bigint();
  try {
    project.ensure();
    project.writeJsonAtomic(probe, { ok: true, at: isoNow() });
    const data = project.readJson(probe, null);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const ok = Boolean(data) && data.ok === true;
    return { ok, ms, error: ok ? null : "写入后读回不一致" };
  } catch (error) {
    return { ok: false, ms: null, error: error.message };
  } finally {
    try { if (fs.existsSync(probe)) fs.rmSync(probe, { force: true }); } catch { /* best effort */ }
  }
}

function doctorFindings(report) {
  const findings = [];
  const nodeSelf = report.node_self || {};
  if (typeof nodeSelf.ms === "number") {
    findings.push(`Node 自启动 ${nodeSelf.ms.toFixed(0)}ms（这是本运行时的实际冷启动成本）。`);
  }
  const nodePath = report.node_path || {};
  if (nodePath.ok) {
    findings.push(`PATH 中存在 node（${nodePath.out}）。`);
  } else {
    findings.push("PATH 中没有 node；扩展应使用 Cursor 自带 Electron(ELECTRON_RUN_AS_NODE=1) 或远程 server 的 node 来调用本运行时。");
  }
  const stateWrite = report.state_dir_write || {};
  findings.push(stateWrite.ok
    ? `状态目录可写（${typeof stateWrite.ms === "number" ? stateWrite.ms.toFixed(0) : "?"}ms）。`
    : `状态目录写入失败：${stateWrite.error}。请检查目录权限。`);
  return findings;
}

function runDoctor(project, sessionId) {
  const report = {
    runtime: "node",
    platform: {
      sys_platform: process.platform,
      os: `${os.type()} ${os.release()} (${process.arch})`,
      node_version: process.version,
      node_executable: process.execPath,
      is_electron: Boolean(process.versions.electron),
      remote_hint: process.env.VSCODE_IPC_HOOK_CLI || process.env.SSH_CONNECTION ? "疑似远程/SSH 环境" : "本机",
      state_dir: project.stateDir,
    },
    node_self: timeSubprocess(process.execPath, ["-e", "0"]),
    node_path: timeSubprocess("node", ["--version"]),
  };
  report.state_dir_write = checkStateWritable(project);
  if (sessionId) report.waiter = project.session(sessionId).currentWaiter();
  report.findings = doctorFindings(report);
  return report;
}

function renderDoctor(report) {
  const fmt = (entry) => {
    if (!entry) return "n/a";
    const ms = typeof entry.ms === "number" ? `${entry.ms.toFixed(0)}ms` : "—";
    const tag = entry.ok ? "OK" : `FAIL(${entry.error})`;
    const extra = entry.out ? ` ${entry.out}` : "";
    return `${tag} ${ms}${extra}`;
  };
  const info = report.platform;
  const lines = [
    "续聊助手 doctor 自检 (Node 运行时)",
    "=".repeat(36),
    `平台:           ${info.os}`,
    `Node:           ${info.node_version}  ${info.is_electron ? "[Electron]" : "[node]"}`,
    `Node 可执行:    ${info.node_executable}`,
    `环境:           ${info.remote_hint}`,
    `状态目录:       ${info.state_dir}`,
    "-".repeat(36),
    `Node 自启动:    ${fmt(report.node_self)}`,
    `PATH node:      ${fmt(report.node_path)}`,
    `状态目录可写:   ${fmt(report.state_dir_write)}`,
    "-".repeat(36),
    "诊断结论:",
  ];
  for (const finding of report.findings || []) lines.push(`  - ${finding}`);
  return lines.join("\n");
}

// --- CLI ----------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  const booleans = new Set(["global-queue", "json"]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      if (booleans.has(key)) args[key] = true;
      else args[key] = argv[++i];
    } else {
      args._.push(token);
    }
  }
  return args;
}

function defaultStateDir() {
  return path.join(process.cwd(), ".cursor", "local-continue-state");
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "";
  const args = parseArgs(command ? argv.slice(1) : argv);
  const stateDir = args["state-dir"] || defaultStateDir();
  const project = new ProjectState(stateDir);

  if (command === "wait") {
    const toInt = (value, fallback) => { const n = parseInt(value, 10); return Number.isFinite(n) ? n : fallback; };
    const toFloat = (value, fallback) => { const n = parseFloat(value); return Number.isFinite(n) ? n : fallback; };
    return waitForInstruction(
      project,
      args["session-id"] || "agent-1",
      toInt(args.timeout, 0),
      toInt(args.keepalive, 90),
      toFloat(args.poll, 0.2),
      args.report || null,
      args["report-status"] || "done",
    );
  }

  if (command === "beacon") {
    const toIntB = (value, fallback) => { const n = parseInt(value, 10); return Number.isFinite(n) ? n : fallback; };
    return runBeacon(project, args["session-id"] || "agent-1", toIntB(args["watch-ppid"], 0), toIntB(args.interval, 4) * 1000);
  }

  if (command === "send") {
    const payload = args.payload ? JSON.parse(args.payload) : normalizePayload(args.text || "");
    const item = args["global-queue"]
      ? project.enqueueGlobal(payload, "send")
      : project.session(args["session-id"] || "agent-1").enqueue(payload, "send");
    console.log(`queued: ${item.id}`);
    return 0;
  }

  if (command === "status") {
    console.log(JSON.stringify(project.statusSummary(), null, 2));
    return 0;
  }

  if (command === "doctor") {
    const report = runDoctor(project, args["session-id"] || null);
    console.log(args.json ? JSON.stringify(report, null, 2) : renderDoctor(report));
    return 0;
  }

  if (command === "clear") {
    if (args["global-queue"] || !args["session-id"]) project.clearGlobal();
    if (args["session-id"]) {
      const session = project.session(args["session-id"]);
      const lockToken = project.acquireLock(session.queueLockDir);
      try {
        project.writeJsonAtomic(session.queuePath, []);
      } finally {
        project.releaseLock(session.queueLockDir, lockToken);
      }
    }
    console.log("cleared");
    return 0;
  }

  console.error("usage: node instruction.js <wait|send|status|clear|doctor|beacon> [--state-dir DIR] [--session-id ID] ...");
  return 1;
}

// Export the reusable pieces so other runtimes (e.g. the MCP server) can drive
// the very same on-disk queue/session/state machine instead of duplicating it.
// Only auto-run the CLI when executed directly, never when `require`d.
// Fire the opt-in result webhook when a session finishes a turn and re-enters
// the wait loop (i.e. it reported a result). Both the shell `wait --report` path
// and the MCP wait/report paths route through here. Fire-and-forget: any failure
// is swallowed so it can never disrupt the bridge loop.
function notifyWebhookResult(project, sessionId, summary, resultStatus = "done", extra = {}) {
  let settings;
  try {
    settings = project.settings();
  } catch {
    return;
  }
  const url = settings && settings.webhookUrl ? String(settings.webhookUrl).trim() : "";
  if (!url) return;
  const status = ["done", "need_input", "error"].includes(resultStatus) ? resultStatus : "done";
  if (!shared.webhookEventsList(settings).includes(status)) return;
  const id = safeSessionId(sessionId);
  let name = id;
  let workspaceRoot = "";
  try {
    const item = project.sessionsIndex().sessions.find((entry) => entry.id === id);
    if (item && item.name) name = item.name;
  } catch { /* ignore */ }
  try {
    // stateDir is <workspace>/.cursor/local-continue-state -> up two levels.
    workspaceRoot = path.dirname(path.dirname(project.stateDir));
  } catch { /* ignore */ }
  const body = {
    event: "session_result",
    session_id: id,
    session_name: name,
    status,
    summary: String(summary || "").slice(0, 2000),
    transport: extra.transport || "",
    workspace: workspaceRoot ? path.basename(workspaceRoot) : "",
    workspace_path: workspaceRoot,
    at: isoNow(),
  };
  Promise.resolve(shared.postWebhook(url, body, { timeoutMs: 8000 })).catch(() => { /* best effort */ });
}

// Per-session project scope: a workspace may hold many projects, so a session
// can be pinned to one project directory. When set, prepend a concise scope note
// to each instruction handed to that session so the agent keeps its work inside
// that folder. Read from the shared sessions index (written by the panel), so it
// works over both the shell and MCP transports with no payload change.
function sessionProjectDir(project, sessionId) {
  try {
    const item = project.sessionsIndex().sessions.find((entry) => entry.id === safeSessionId(sessionId));
    return item && item.projectDir ? String(item.projectDir).trim() : "";
  } catch {
    return "";
  }
}

function applySessionScope(project, sessionId, rendered) {
  if (!rendered || rendered === "stop") return rendered;
  const dir = sessionProjectDir(project, sessionId);
  if (!dir) return rendered;
  return `[项目范围] 本会话负责的项目目录：\`${dir}\`。请只在该目录内进行开发/操作；本工作区包含多个项目，未经我明确要求，不要改动此目录以外的内容。\n\n${rendered}`;
}

module.exports = {
  ProjectState,
  SessionState,
  notifyWebhookResult,
  sessionProjectDir,
  applySessionScope,
  renderPayload,
  normalizePayload,
  makeQueueItem,
  safeSessionId,
  queueSignature,
  createQueueNotifier,
  captureAgentEnv,
  isProcessAlive,
  spawnBeaconIfNeeded,
  nowMs,
  isoNow,
  keepaliveMessage,
};

if (require.main === module) {
  main()
    .then((code) => {
      // Set exitCode instead of process.exit() so a buffered stdout write (the
      // rendered instruction can be large on a pipe) fully drains before exit.
      process.exitCode = code || 0;
    })
    .catch((error) => {
      console.error(`error: ${error && error.message ? error.message : error}`);
      process.exitCode = 1;
    });
}
