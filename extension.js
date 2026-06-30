const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const PATCH_START = "/* CUTC_CONTINUE_RETRY_PATCH_START */";
const PATCH_END = "/* CUTC_CONTINUE_RETRY_PATCH_END */";
// Remembers that the user installed the native retry patch, so we can offer to
// reinstall it after a Cursor update silently overwrites workbench.desktop.main.js.
const RETRY_WANTED_KEY = "localContinue.retryPatchWanted";
// Caches the P1/P2/P3 native-patch result recorded at install time, so the panel
// can show it without scanning the 60MB+ workbench file on every refresh.
const RETRY_NATIVE_KEY = "localContinue.retryPatchNative";
const DEFAULT_SETTINGS = {
  waitTimeoutSeconds: 0,
  keepaliveSeconds: 300,
  offlineAfterSeconds: 15,
  workingTimeoutSeconds: 300,
  maxConcurrentSessions: 4,
  schedulingMode: "direct",
  perSessionQueueLimit: 3,
  globalQueueLimit: 20,
  pollSeconds: 0.2,
  historyLimit: 200,
  imageLimit: 50,
  imageMaxDimension: 2000,
  notifyOnAttention: true,
  retryMaxRetries: 200,
};

let retryPatchCache = { at: 0, value: null };

function nowMs() {
  return Date.now();
}

function makeId(prefix = "msg") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const _RE_IMAGE_CTX = /IMAGE_CONTEXT_START:[\s\S]*?:IMAGE_CONTEXT_END/g;
const _RE_LONG_B64 = /[A-Za-z0-9+/=]{240,}/g;
const _RE_WS = /\s+/g;
function compactForUi(value, maxLength = 360) {
  const text = String(value || "")
    .replace(_RE_IMAGE_CTX, "[图片数据已折叠]")
    .replace(_RE_LONG_B64, "[长二进制数据已折叠]")
    .replace(_RE_WS, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function safeSessionId(value) {
  const raw = String(value || "").trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned || "agent-1";
}

const TRANSIENT_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST"]);
const RENAME_RETRY_ATTEMPTS = 24;
const RENAME_RETRY_BASE_DELAY = 15;
const RENAME_RETRY_MAX_DELAY = 300;

function isTransientFsError(error) {
  return Boolean(error) && TRANSIENT_FS_CODES.has(error.code);
}

function safeUnlink(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup of our own temp file.
  }
}

function renameWithRetry(tmp, filePath) {
  // Windows throws EPERM/EACCES/EBUSY when renaming a temp file over a target
  // that is briefly held open by another process (another waiter, the panel
  // reader, antivirus, the search indexer). Retry with jittered backoff instead
  // of surfacing the "拒绝访问" error to the user.
  let delay = RENAME_RETRY_BASE_DELAY;
  let lastError;
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (error) {
      if (!isTransientFsError(error)) throw error;
      lastError = error;
      if (attempt === RENAME_RETRY_ATTEMPTS - 1) break;
      sleepSync(Math.round(Math.min(delay, RENAME_RETRY_MAX_DELAY) * (0.5 + Math.random())));
      delay = Math.min(Math.round(delay * 1.7), RENAME_RETRY_MAX_DELAY);
    }
  }
  throw lastError;
}

function readJson(filePath, fallback) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch (error) {
      if (isTransientFsError(error) && attempt < 4) {
        sleepSync(20 * (attempt + 1));
        continue;
      }
      return fallback;
    }
  }
  return fallback;
}

// Stat-signature cache for hot-path JSON reads (getBridgeStatus refreshes).
// Avoids re-reading+re-parsing files whose mtime+size haven't changed between
// refreshes. status.json is NOT cached (heartbeat age needs fresh data). The
// cache is self-invalidating: a changed file has a new stat signature.
const _jsonCache = new Map();
function readJsonCached(filePath, fallback) {
  let sig;
  try {
    const stat = fs.statSync(filePath);
    sig = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    _jsonCache.delete(filePath);
    return fallback;
  }
  const cached = _jsonCache.get(filePath);
  if (cached && cached.sig === sig) return cached.data;
  const data = readJson(filePath, fallback);
  _jsonCache.set(filePath, { sig, data });
  return data;
}

const _tmpSuffix = `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${_tmpSuffix}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  try {
    renameWithRetry(tmp, filePath);
  } finally {
    if (fs.existsSync(tmp)) safeUnlink(tmp);
  }
}

function appendJsonl(filePath, record, limit = 200) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  let delay = RENAME_RETRY_BASE_DELAY;
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      fs.appendFileSync(filePath, line, "utf8");
      break;
    } catch (error) {
      if (!isTransientFsError(error) || attempt === RENAME_RETRY_ATTEMPTS - 1) return;
      sleepSync(Math.round(Math.min(delay, RENAME_RETRY_MAX_DELAY) * (0.5 + Math.random())));
      delay = Math.min(Math.round(delay * 1.7), RENAME_RETRY_MAX_DELAY);
    }
  }
  trimJsonl(filePath, limit);
}

function trimJsonl(filePath, limit) {
  if (!limit || limit <= 0) return;
  try {
    // Skip the full read+parse when the file is clearly under the limit (~512
    // bytes per line heuristic). Avoids reading the whole file on every append.
    const stat = fs.statSync(filePath);
    if (stat.size < limit * 512) return;
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length <= limit) return;
    // Atomic rewrite (tmp + rename) so a concurrent append from a waiter process
    // can't be clobbered by a partial trim write.
    const tmp = `${filePath}.${_tmpSuffix}.tmp`;
    try {
      fs.writeFileSync(tmp, `${lines.slice(-limit).join("\n")}\n`, "utf8");
      renameWithRetry(tmp, filePath);
    } finally {
      if (fs.existsSync(tmp)) safeUnlink(tmp);
    }
  } catch {
    // Best effort.
  }
}

function withDirectoryLock(lockDir, action, timeoutMs = 5000, staleMs = 15000) {
  const started = nowMs();
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  while (true) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      // Stamp ownership so the finally below only deletes a lock we still hold;
      // after a stale-takeover we must not delete the successor's lock.
      try { fs.writeFileSync(path.join(lockDir, "owner"), token, "utf8"); } catch { /* best effort */ }
      break;
    } catch (error) {
      if (error && error.code !== "EEXIST") throw error;
      try {
        const age = nowMs() - fs.statSync(lockDir).mtimeMs;
        if (age > staleMs) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Retry.
      }
      if (nowMs() - started > timeoutMs) throw new Error("队列正忙，请稍后再试。");
      sleepSync(40);
    }
  }
  try {
    return action();
  } finally {
    try {
      let current = null;
      try { current = fs.readFileSync(path.join(lockDir, "owner"), "utf8"); } catch { /* missing */ }
      if (current === null || current === token) {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    } catch {
      // Best effort: a transient lock on the lock directory clears on a later pass.
    }
  }
}

function normalizeQueue(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.messages)) return data.messages;
  if (data && typeof data === "object" && (data.payload || data.message || data.id)) return [data];
  return [];
}

function normalizePayload(input) {
  if (typeof input === "string") {
    return {
      status: "continue",
      user_input: input,
      selected_choice: undefined,
      file_paths: [],
      image_paths: [],
      suggested_tools: [],
    };
  }
  const payload = input && typeof input === "object" ? input : {};
  return {
    status: payload.status || "continue",
    user_input: String(payload.user_input || payload.message || ""),
    selected_choice: payload.selected_choice || undefined,
    file_paths: Array.isArray(payload.file_paths) ? payload.file_paths.filter(Boolean) : [],
    image_paths: Array.isArray(payload.image_paths) ? payload.image_paths.filter(Boolean) : [],
    suggested_tools: Array.isArray(payload.suggested_tools) ? payload.suggested_tools.filter(Boolean) : [],
  };
}

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) throw new Error("请先在 Cursor 打开一个项目目录。");
  return folders[0].uri.fsPath;
}

function getPaths(context) {
  const workspaceRoot = getWorkspaceRoot();
  const runtimeDir = path.join(context.extensionPath, "runtime");
  const stateDir = path.join(workspaceRoot, ".cursor", "local-continue-state");
  return {
    workspaceRoot,
    runtimeDir,
    instructionJs: path.join(runtimeDir, "instruction.js"),
    mcpServerJs: path.join(runtimeDir, "mcp-server.js"),
    mcpConfig: path.join(workspaceRoot, ".cursor", "mcp.json"),
    template: path.join(runtimeDir, "cutc_rules_template.mdc"),
    stateDir,
    sessionsDir: path.join(stateDir, "sessions"),
    sessionsIndex: path.join(stateDir, "sessions.json"),
    globalQueue: path.join(stateDir, "global_queue.json"),
    globalQueueLock: path.join(stateDir, ".global_queue.lock"),
    history: path.join(stateDir, "history.jsonl"),
    settings: path.join(stateDir, "settings.json"),
    images: path.join(stateDir, "images"),
    rule: path.join(workspaceRoot, ".cursor", "rules", "cutc_rules.mdc"),
    retryHelper: path.join(context.extensionPath, "media", "official-retry-helper.js"),
  };
}

function sessionPaths(paths, sessionId) {
  const id = safeSessionId(sessionId);
  const dir = path.join(paths.sessionsDir, id);
  return {
    id,
    dir,
    queue: path.join(dir, "queue.json"),
    queueLock: path.join(dir, ".queue.lock"),
    status: path.join(dir, "status.json"),
    history: path.join(dir, "history.jsonl"),
    presence: path.join(dir, "presence.json"),
  };
}

// Cache the runtime check so hot-path callers (postStatus, handleMessage) don't
// re-stat the instruction script and re-mkdir the state dir on every call. The
// cache is keyed by the workspace root, which is the only variable input.
const _runtimeCache = new Map();
function ensureRuntime(context) {
  const paths = getPaths(context);
  const cacheKey = paths.workspaceRoot || paths.stateDir;
  const cached = _runtimeCache.get(cacheKey);
  if (cached) return cached;
  if (!fs.existsSync(paths.instructionJs)) {
    throw new Error(`找不到运行时脚本：${paths.instructionJs}`);
  }
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  ensureDefaultSession(paths);
  _runtimeCache.set(cacheKey, paths);
  return paths;
}

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

// The runtime that runs the bridge in the agent's terminal is always Node:
// `node` in the Cursor integrated terminal resolves to Cursor's bundled node
// (locally the helper node.exe, on a Remote-SSH host the server's node), so it is
// reliably present on Windows and Linux and avoids the per-spawn antivirus cost
// that made the old Python runtime slow on Windows. (The Python runtime was
// removed in 1.0.1 to end the dual-maintenance burden.)
function resolveRuntime(paths) {
  return { kind: "node", bin: "node", script: paths.instructionJs };
}

function runtimeWaitCommand(paths, settings, sessionId, extra = "") {
  const runtime = resolveRuntime(paths, settings);
  const id = safeSessionId(sessionId || "agent-1");
  const base = `${runtime.bin} ${quoteArg(runtime.script)} wait --state-dir ${quoteArg(paths.stateDir)} --session-id ${quoteArg(id)} --keepalive ${settings.keepaliveSeconds} --timeout ${settings.waitTimeoutSeconds} --poll ${settings.pollSeconds}`;
  return extra ? `${base} ${extra}` : base;
}

function runtimeDoctorCommand(paths, settings) {
  const runtime = resolveRuntime(paths, settings);
  return `${runtime.bin} ${quoteArg(runtime.script)} doctor --state-dir ${quoteArg(paths.stateDir)}`;
}

function readSettings(paths) {
  const raw = readJsonCached(paths.settings, {});
  const settings = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) };
  settings.waitTimeoutSeconds = Math.max(0, Number(settings.waitTimeoutSeconds || 0));
  settings.keepaliveSeconds = Math.max(10, Number(settings.keepaliveSeconds || 300));
  settings.offlineAfterSeconds = Math.max(5, Number(settings.offlineAfterSeconds || 15));
  settings.workingTimeoutSeconds = Math.max(30, Number(settings.workingTimeoutSeconds || 300) || 300);
  settings.maxConcurrentSessions = Math.max(1, Number(settings.maxConcurrentSessions || 4));
  settings.perSessionQueueLimit = Math.max(1, Number(settings.perSessionQueueLimit || 3));
  settings.globalQueueLimit = Math.max(1, Number(settings.globalQueueLimit || 20));
  settings.pollSeconds = Math.max(0.1, Number(settings.pollSeconds || 0.2));
  settings.historyLimit = Math.max(20, Number(settings.historyLimit || 200));
  settings.imageLimit = Math.max(5, Number(settings.imageLimit || 50));
  settings.imageMaxDimension = Number.isFinite(Number(settings.imageMaxDimension)) ? Math.max(0, Math.round(Number(settings.imageMaxDimension))) : 2000;
  settings.notifyOnAttention = settings.notifyOnAttention !== false;
  settings.retryMaxRetries = Math.min(1000, Math.max(1, Math.round(Number(settings.retryMaxRetries || 200) || 200)));
  if (!["direct", "broadcast", "idle-first", "round-robin"].includes(settings.schedulingMode)) {
    settings.schedulingMode = "direct";
  }
  return settings;
}

function saveSettings(context, settingsPatch) {
  const paths = ensureRuntime(context);
  const next = { ...readSettings(paths), ...(settingsPatch || {}) };
  const cleaned = { ...DEFAULT_SETTINGS, ...next };
  cleaned.waitTimeoutSeconds = Math.max(0, Number(cleaned.waitTimeoutSeconds || 0));
  cleaned.keepaliveSeconds = Math.max(10, Number(cleaned.keepaliveSeconds || 300));
  cleaned.offlineAfterSeconds = Math.max(5, Number(cleaned.offlineAfterSeconds || 15));
  cleaned.workingTimeoutSeconds = Math.max(30, Number(cleaned.workingTimeoutSeconds || 300) || 300);
  cleaned.maxConcurrentSessions = Math.max(1, Number(cleaned.maxConcurrentSessions || 4));
  cleaned.perSessionQueueLimit = Math.max(1, Number(cleaned.perSessionQueueLimit || 3));
  cleaned.globalQueueLimit = Math.max(1, Number(cleaned.globalQueueLimit || 20));
  cleaned.pollSeconds = Math.max(0.1, Number(cleaned.pollSeconds || 0.2));
  cleaned.historyLimit = Math.max(20, Number(cleaned.historyLimit || 200));
  cleaned.imageLimit = Math.max(5, Number(cleaned.imageLimit || 50));
  cleaned.imageMaxDimension = Number.isFinite(Number(cleaned.imageMaxDimension)) ? Math.max(0, Math.round(Number(cleaned.imageMaxDimension))) : 2000;
  cleaned.notifyOnAttention = cleaned.notifyOnAttention !== false;
  cleaned.retryMaxRetries = Math.min(1000, Math.max(1, Math.round(Number(cleaned.retryMaxRetries || 200) || 200)));
  if (!["direct", "broadcast", "idle-first", "round-robin"].includes(cleaned.schedulingMode)) cleaned.schedulingMode = "direct";
  writeJsonAtomic(paths.settings, cleaned);
  trimJsonl(paths.history, cleaned.historyLimit);
  cleanupImages(paths.images, cleaned.imageLimit);
  return cleaned;
}

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
    const id = safeSessionId(`agent-${index.sessions.length + 1}-${Date.now().toString(36)}`);
    const item = {
      id,
      name: name || `会话 ${index.sessions.length + 1}`,
      created_at: new Date().toISOString(),
      created_at_ms: nowMs(),
    };
    index.sessions.push(item);
    writeSessionsIndex(paths, index);
    fs.mkdirSync(sessionPaths(paths, id).dir, { recursive: true });
    return item;
  });
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

function makeQueueItem(payloadInput, source, target) {
  const payload = normalizePayload(payloadInput);
  return {
    id: makeId("queued"),
    payload,
    message: payload.user_input,
    source,
    target,
    created_at: new Date().toISOString(),
    created_at_ms: nowMs(),
  };
}

function readQueue(filePath) {
  return normalizeQueue(readJsonCached(filePath, []));
}

function writeQueue(filePath, queue) {
  writeJsonAtomic(filePath, queue);
}

function enqueueToSession(paths, sessionId, payload, source = "panel") {
  const settings = readSettings(paths);
  const sp = sessionPaths(paths, sessionId);
  return withDirectoryLock(sp.queueLock, () => {
    const queue = readQueue(sp.queue);
    if (queue.length >= settings.perSessionQueueLimit) {
      throw new Error(`${sp.id} 的队列已达到上限 ${settings.perSessionQueueLimit}。`);
    }
    const item = makeQueueItem(payload, source, sp.id);
    queue.push(item);
    writeQueue(sp.queue, queue);
    appendJsonl(sp.history, { type: "queued", ...item }, settings.historyLimit);
    appendJsonl(paths.history, { type: "queued_session", session_id: sp.id, ...item }, settings.historyLimit);
    return item;
  });
}

function enqueueGlobal(paths, payload, source = "panel") {
  const settings = readSettings(paths);
  return withDirectoryLock(paths.globalQueueLock, () => {
    const queue = readQueue(paths.globalQueue);
    if (queue.length >= settings.globalQueueLimit) {
      throw new Error(`空闲优先队列已达到上限 ${settings.globalQueueLimit}。`);
    }
    const item = makeQueueItem(payload, source, "idle-first");
    queue.push(item);
    writeQueue(paths.globalQueue, queue);
    appendJsonl(paths.history, { type: "queued_global", ...item }, settings.historyLimit);
    return item;
  });
}

function removeQueued(paths, sessionId, itemId, scope = "session") {
  const settings = readSettings(paths);
  if (scope === "global") {
    return withDirectoryLock(paths.globalQueueLock, () => {
      const queue = readQueue(paths.globalQueue);
      const next = queue.filter((item) => item.id !== itemId);
      writeQueue(paths.globalQueue, next);
      if (next.length !== queue.length) appendJsonl(paths.history, { type: "global_queue_removed", id: itemId, at: new Date().toISOString() }, settings.historyLimit);
      return queue.length - next.length;
    });
  }
  const sp = sessionPaths(paths, sessionId);
  return withDirectoryLock(sp.queueLock, () => {
    const queue = readQueue(sp.queue);
    const next = queue.filter((item) => item.id !== itemId);
    writeQueue(sp.queue, next);
    if (next.length !== queue.length) appendJsonl(sp.history, { type: "queue_removed", id: itemId, at: new Date().toISOString() }, settings.historyLimit);
    return queue.length - next.length;
  });
}

function moveQueued(paths, sessionId, itemId, direction, scope = "session") {
  const delta = direction === "up" ? -1 : 1;
  const reorder = (queue) => {
    const index = queue.findIndex((item) => item.id === itemId);
    if (index < 0) return false;
    const next = index + delta;
    if (next < 0 || next >= queue.length) return false;
    const [item] = queue.splice(index, 1);
    queue.splice(next, 0, item);
    return true;
  };
  if (scope === "global") {
    return withDirectoryLock(paths.globalQueueLock, () => {
      const queue = readQueue(paths.globalQueue);
      if (!reorder(queue)) return false;
      writeQueue(paths.globalQueue, queue);
      return true;
    });
  }
  const sp = sessionPaths(paths, sessionId);
  return withDirectoryLock(sp.queueLock, () => {
    const queue = readQueue(sp.queue);
    if (!reorder(queue)) return false;
    writeQueue(sp.queue, queue);
    return true;
  });
}

function clearQueue(paths, scope, sessionId) {
  const settings = readSettings(paths);
  if (scope === "global" || scope === "all") {
    withDirectoryLock(paths.globalQueueLock, () => writeQueue(paths.globalQueue, []));
    appendJsonl(paths.history, { type: "global_queue_cleared", at: new Date().toISOString() }, settings.historyLimit);
  }
  if (scope === "session" || scope === "all") {
    const sessions = scope === "all" ? readSessionsIndex(paths).sessions.map((item) => item.id) : [sessionId];
    for (const id of sessions) {
      const sp = sessionPaths(paths, id);
      withDirectoryLock(sp.queueLock, () => writeQueue(sp.queue, []));
      appendJsonl(sp.history, { type: "queue_cleared", at: new Date().toISOString() }, settings.historyLimit);
    }
  }
}

function sessionSummary(paths, indexItem, settings = readSettings(paths)) {
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
  const presence = readJsonCached(sp.presence, null);
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
  // Display name precedence: a manual rename wins; otherwise the auto-title
  // derived from the first instruction; otherwise the default "会话 N".
  const displayName = (indexItem.nameManual && indexItem.name)
    ? indexItem.name
    : (indexItem.autoTitle || indexItem.name || sp.id);
  return {
    id: sp.id,
    name: displayName,
    baseName: indexItem.name || sp.id,
    autoTitled: Boolean(!indexItem.nameManual && indexItem.autoTitle),
    created_at: indexItem.created_at || "",
    state: status.state || "new",
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
    conversationId: status.conversation_id || "",
    conversationShort: status.conversation_id ? String(status.conversation_id).slice(0, 8) : "",
    workspaceLabel: status.workspace_label || "",
    lastMessagePreview: compactForUi(status.last_message_preview || "", 160),
    lastResult: compactForUi(status.last_result || "", 240),
    lastResultStatus: status.last_result_status || "",
    lastResultAt: status.last_result_at || "",
    lastResultAtMs: Number(status.last_result_at_ms || 0),
    keepaliveDeadlineMs: Number(status.keepalive_deadline_ms || 0),
    waiter: status.waiter || null,
    overrides: indexItem.overrides || null,
  };
}

function getAllSessions(paths, settings = readSettings(paths)) {
  ensureDefaultSession(paths);
  return readSessionsIndex(paths).sessions.map((item) => sessionSummary(paths, item, settings));
}

function chooseRoundRobinSession(paths) {
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
  const userInput = [
    `会话转接：请接管原会话「${sourceName}」未完成的任务。`,
    sourceCid ? `原 Cursor 会话 ID：${sourceCid}` : "",
    `转接原因：${why}`,
    "",
    "需要你继续完成的内容/上下文：",
    ctx || "（未提供额外上下文，请根据上述会话标识与任务名继续。）",
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

function buildAgentInstruction(context, sessionId) {
  const paths = ensureRuntime(context);
  const settings = readSettings(paths);
  const resolved = resolveInstructionSession(paths, settings, sessionId);
  const id = resolved.id;
  const waitCmd = runtimeWaitCommand(paths, effectiveSessionSettings(paths, settings, id), id);
  const text = `请从现在开始使用“续聊助手”的多会话 bridge 循环工作。

当前会话 ID：${id}

具体要求：
1. 正常完成当前这轮任务。
2. 每轮任务结束后，不要调用 input()，也不要让我在终端手动输入。
3. 第一次进入等待时，请在当前项目终端运行下面这条命令：

\`\`\`powershell
${waitCmd}
\`\`\`

4. 之后每完成一轮任务、重新进入等待时，请在同一条命令后面加上 --report，把刚做完的事用一句话反馈给面板（状态用 done/need_input/error）：

\`\`\`powershell
${waitCmd} --report "一句话说明刚完成或遇到的情况" --report-status done
\`\`\`

   如果需要我做决定或补充信息，用 --report-status need_input；如果失败，用 error。面板会高亮该会话并提醒我。

**重要 · 前台阻塞，别提前收工**：wait 是会一直阻塞的命令，可能几秒到几分钟。运行后你必须**停在本轮**、等它自己返回结果（KEEPALIVE_NOOP / 一条指令 / SESSION_BUSY / stop / timeout）才算这一轮结束。
   - 只看到 \`[续聊助手] 等待中… Ns\` 转圈**不代表完成**，那只是心跳。**绝不要**因为看到转圈就回复"已进入等待循环 / 后台已在运行"之类然后结束本轮——那样循环会空转死掉。
   - 如果你的工具把命令放到后台并提前把控制权还给你（你只看到转圈、没有上面任一结果），它**还在运行**：请继续等待 / 重新查看**同一个后台命令**的输出（await/轮询同一条命令）直到它打印出结果，**不要另起一条新的 wait**（会 SESSION_BUSY）。
   - 请尽量用**前台 / 阻塞**方式运行，并把超时设到你的工具支持的**最长值**（如 timeout=0 或很大的值）。
5. 如果输出以 KEEPALIVE_NOOP 开头，表示当前没有新的用户指令。不要修改项目，请立即重新运行 wait 命令（可不带 --report），让本对话保持活跃。
6. 如果输出普通文本、文件上下文或图片上下文，请执行收到的指令；执行完成后回到第 3/4 步继续等待。图片上下文会给出本地图片文件路径，请用读取文件工具打开查看。
7. 如果收到 stop，结束这个会话循环。
8. 如果输出以 SESSION_BUSY 开头（或包含 another instruction waiter is already active），说明本 session-id 已被另一个对话占用。不要重复运行 wait、也不要去结束其它进程；请用 --report-status need_input 反馈，并提醒我为本对话改用唯一的 session-id（或在面板新建会话后重开本循环），然后停止本轮等待。`;
  return { id, text, created: resolved.created };
}

async function copyAgentInstruction(context, sessionId) {
  const built = buildAgentInstruction(context, sessionId);
  await vscode.env.clipboard.writeText(built.text);
  return built;
}

// Write/merge the MCP server entry into the project's .cursor/mcp.json so Cursor
// launches the 续聊助手 MCP server. Uses the host's own node-capable binary
// (process.execPath + ELECTRON_RUN_AS_NODE=1) so it works without `node` on PATH,
// locally and over Remote-SSH alike. Existing servers in the file are preserved.
function installMcpConfig(context) {
  const paths = ensureRuntime(context);
  if (!fs.existsSync(paths.mcpServerJs)) throw new Error(`找不到 MCP 服务器脚本：${paths.mcpServerJs}`);
  const config = readJson(paths.mcpConfig, {});
  const root = config && typeof config === "object" ? config : {};
  if (!root.mcpServers || typeof root.mcpServers !== "object") root.mcpServers = {};
  root.mcpServers["local-continue"] = {
    command: process.execPath,
    args: [paths.mcpServerJs, "--state-dir", paths.stateDir],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  fs.mkdirSync(path.dirname(paths.mcpConfig), { recursive: true });
  fs.writeFileSync(paths.mcpConfig, JSON.stringify(root, null, 2), "utf8");
  return { target: paths.mcpConfig };
}

function buildMcpInstruction(context, sessionId) {
  const paths = ensureRuntime(context);
  const settings = readSettings(paths);
  const resolved = resolveInstructionSession(paths, settings, sessionId);
  const id = resolved.id;
  const text = `请从现在开始使用“续聊助手”的 MCP bridge 循环工作。

当前会话 ID：${id}

具体要求：
1. 正常完成当前这轮任务。
2. 每轮任务结束后，调用 MCP 工具 \`wait_for_instruction\`（参数 session_id="${id}"，可附带 report 用一句话反馈刚做完的事、report_status 用 done/need_input/error）来等待下一条指令。这是 MCP 工具调用，会被原生阻塞等待，**不会被放到后台**，请耐心等它返回。
3. 按 \`wait_for_instruction\` 的返回值处理：
   - 普通文本（含文件/图片上下文）→ 当作用户指令执行；执行完回到第 2 步**再次调用** \`wait_for_instruction\`。
   - 以 \`KEEPALIVE_NOOP\` 开头 → 当前没有新指令，**不要修改项目、不要结束本轮**，立即**再次调用** \`wait_for_instruction\`。
   - 以 \`SESSION_BUSY\` 开头 → 本 session_id 被另一个对话占用，请改用唯一 session_id 或在面板新建会话后重开，不要反复重试。
   - \`stop\` → 结束本会话循环。
4. 不要调用 input()，也不要让我在终端手动输入；所有新指令都来自面板。
5. **绝不要因为“已调用工具/已进入等待”就提前结束本轮**——必须持续循环调用 \`wait_for_instruction\` 直到收到 \`stop\`。
6. 图片上下文会给出本地图片文件路径，请用读取文件工具打开查看。`;
  return { id, text, created: resolved.created };
}

async function copyMcpInstruction(context, sessionId) {
  const built = buildMcpInstruction(context, sessionId);
  await vscode.env.clipboard.writeText(built.text);
  return built;
}

// True when this project's .cursor/mcp.json already registers our MCP server.
function mcpInstalled(paths) {
  try {
    const cfg = readJson(paths.mcpConfig, null);
    return Boolean(cfg && cfg.mcpServers && cfg.mcpServers["local-continue"]);
  } catch {
    return false;
  }
}

// The "smart" copy used by the top bar: hand back the MCP start instruction once
// the MCP server is installed in this project, otherwise the shell one. This way
// the single primary button always yields a command that works right now -- no
// transport choice for the user, and it auto-upgrades to MCP after install+restart.
async function copySmartInstruction(context, sessionId) {
  const paths = ensureRuntime(context);
  if (mcpInstalled(paths)) {
    const built = await copyMcpInstruction(context, sessionId);
    return { ...built, mode: "mcp" };
  }
  const built = await copyAgentInstruction(context, sessionId);
  return { ...built, mode: "shell" };
}

function startWaitTerminal(context, sessionId) {
  const paths = ensureRuntime(context);
  const settings = readSettings(paths);
  const resolved = resolveInstructionSession(paths, settings, sessionId);
  const id = resolved.id;
  const terminal = vscode.window.createTerminal({ name: `续聊助手 ${id}`, cwd: paths.workspaceRoot });
  terminal.show(true);
  terminal.sendText(runtimeWaitCommand(paths, effectiveSessionSettings(paths, settings, id), id));
  return resolved;
}

function startDoctorTerminal(context) {
  const paths = ensureRuntime(context);
  const settings = readSettings(paths);
  const terminal = vscode.window.createTerminal({ name: "续聊助手 doctor", cwd: paths.workspaceRoot });
  terminal.show(true);
  terminal.sendText(runtimeDoctorCommand(paths, settings));
}

function installRule(context) {
  const paths = ensureRuntime(context);
  const template = fs.readFileSync(paths.template, "utf8");
  const settings = readSettings(paths);
  const runtime = resolveRuntime(paths, settings);
  const content = template
    // Function replacements so values containing $ (e.g. $&, $1 in a path) are
    // inserted literally instead of being treated as replacement patterns.
    .replaceAll("{{PYTHON_COMMAND}}", () => runtime.bin)
    .replaceAll("{{RUNTIME_COMMAND}}", () => runtime.bin)
    .replaceAll("{{INSTRUCTION_PATH}}", () => runtime.script)
    .replaceAll("{{RUNTIME_SCRIPT}}", () => runtime.script)
    .replaceAll("{{STATE_DIR}}", () => paths.stateDir)
    .replaceAll("{{KEEPALIVE_SECONDS}}", String(settings.keepaliveSeconds))
    .replaceAll("{{WAIT_TIMEOUT_SECONDS}}", String(settings.waitTimeoutSeconds))
    .replaceAll("{{POLL_SECONDS}}", String(settings.pollSeconds));
  fs.mkdirSync(path.dirname(paths.rule), { recursive: true });
  fs.writeFileSync(paths.rule, content, "utf8");
  return paths.rule;
}

function readHistory(filePath, limit = 100) {
  try {
    // For large history files, read only the tail instead of the whole file.
    // Each JSONL line is ~200-500 bytes; limit*1024 covers the last N lines
    // with comfortable margin. Falls back to full read if the heuristic is
    // too small (e.g. lines with large image contexts).
    const stat = fs.statSync(filePath);
    const tailBytes = limit * 1024;
    if (stat.size > tailBytes) {
      const fd = fs.openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(tailBytes);
        const bytes = fs.readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
        const text = buf.toString("utf8", 0, bytes);
        // Drop the partial first line (it starts mid-record).
        const firstNewline = text.indexOf("\n");
        const lines = (firstNewline >= 0 ? text.slice(firstNewline + 1) : text).split(/\r?\n/).filter(Boolean).slice(-limit);
        return lines.map((line) => {
          try { return JSON.parse(line); } catch { return { type: "raw", text: line }; }
        });
      } finally {
        fs.closeSync(fd);
      }
    }
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "raw", text: line };
      }
    });
  } catch {
    return [];
  }
}

function getBridgeStatus(context, options = {}) {
  let paths;
  try {
    paths = ensureRuntime(context);
  } catch (error) {
    return {
      state: "未打开项目",
      statusText: "未打开项目",
      sessions: [],
      globalQueueLength: 0,
      totalQueueLength: 0,
      extensionSettings: DEFAULT_SETTINGS,
      patch: patchStatusWithNative(context, options.forcePatch),
      remoteName: vscode.env.remoteName || "",
      detail: error.message,
    };
  }

  const settings = readSettings(paths);
  const sessions = getAllSessions(paths, settings);
  const globalQueue = readQueue(paths.globalQueue);
  let totalQueueLength = globalQueue.length;
  let onlineCount = 0;
  for (let i = 0; i < sessions.length; i++) {
    totalQueueLength += sessions[i].queueLength;
    if (sessions[i].connected) onlineCount++;
  }
  return {
    workspaceRoot: paths.workspaceRoot,
    stateDir: paths.stateDir,
    sessions,
    globalQueueLength: globalQueue.length,
    globalQueuedResponses: globalQueue.map((item) => {
      const raw = item.payload || item.message || "";
      const payload = typeof raw === "string" ? normalizePayload(raw) : raw;
      return {
        id: item.id,
        payload,
        source: item.source || "",
        created_at: item.created_at || "",
        target: "idle-first",
      };
    }),
    totalQueueLength,
    onlineCount,
    maxConcurrentSessions: settings.maxConcurrentSessions,
    statusText: onlineCount > 0 ? `在线会话 ${onlineCount}/${sessions.length}` : "暂无在线会话，请复制启动指令到 Cursor 对话",
    history: options.includeHistory ? readHistory(paths.history, 100) : [],
    extensionSettings: settings,
    patch: patchStatusWithNative(context, options.forcePatch),
    remoteName: vscode.env.remoteName || "",
    mcpInstalled: mcpInstalled(paths),
  };
}

async function pickFiles() {
  const uris = await vscode.window.showOpenDialog({ title: "选择要引用的文件", canSelectFiles: true, canSelectFolders: false, canSelectMany: true });
  return (uris || []).map((uri) => uri.fsPath);
}

function pickActiveEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error("当前没有打开的编辑器文件。");
  return editor.document.uri.fsPath;
}

function cleanupImages(imagesDir, limit) {
  if (!limit || limit <= 0) return;
  try {
    if (!fs.existsSync(imagesDir)) return;
    const files = fs.readdirSync(imagesDir)
      .map((name) => {
        const filePath = path.join(imagesDir, name);
        try {
          const stat = fs.statSync(filePath);
          return stat.isFile() ? { filePath, mtimeMs: stat.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const item of files.slice(limit)) fs.rmSync(item.filePath, { force: true });
  } catch {
    // Best effort.
  }
}

const THUMB_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
};
const THUMB_MAX_BYTES = 3 * 1024 * 1024;

// F-7: produce a data URL so the panel can preview an attached image. Capped by
// size (pasted images are already downscaled in the webview); larger picked
// files just fall back to the filename chip. CSP allows img-src data:.
function readImageThumb(filePath) {
  try {
    const mime = THUMB_MIME[path.extname(String(filePath)).toLowerCase()];
    if (!mime) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > THUMB_MAX_BYTES) return null;
    return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
  } catch {
    return null;
  }
}

function savePastedImage(context, dataUrl) {
  const paths = ensureRuntime(context);
  const settings = readSettings(paths);
  const match = String(dataUrl || "").match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) throw new Error("收到的图片不是 data URL 格式。");
  // Cap decoded image size so a huge accidental/malicious paste can't exhaust
  // host memory/disk (base64 decodes to ~3/4 of its length).
  const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
  if (Math.floor(match[2].length * 0.75) > MAX_IMAGE_BYTES) {
    throw new Error(`粘贴的图片过大，上限 ${MAX_IMAGE_BYTES / 1048576}MB。`);
  }
  const ext = match[1].toLowerCase().replace("jpeg", "jpg").replace("+xml", "");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`粘贴的图片过大（${Math.round(buffer.length / 1048576)}MB），上限 ${MAX_IMAGE_BYTES / 1048576}MB。`);
  }
  const filePath = path.join(paths.images, `${makeId("paste")}.${ext}`);
  fs.mkdirSync(paths.images, { recursive: true });
  fs.writeFileSync(filePath, buffer);
  cleanupImages(paths.images, settings.imageLimit);
  return filePath;
}

function findCursorAppRoot() {
  const candidates = [];
  // execPath-relative resolves the real install dir on any drive (the host's
  // process.execPath is the Cursor/Electron binary), so it is the primary source;
  // the rest are generic env-based fallbacks (no hardcoded user/drive paths).
  if (process.execPath) candidates.push(path.join(path.dirname(process.execPath), "resources", "app"));
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "cursor", "resources", "app"));
  if (process.env.PROGRAMFILES) candidates.push(path.join(process.env.PROGRAMFILES, "cursor", "resources", "app"));
  if (process.env["PROGRAMFILES(X86)"]) candidates.push(path.join(process.env["PROGRAMFILES(X86)"], "cursor", "resources", "app"));
  return candidates.find((candidate) => candidate && fs.existsSync(path.join(candidate, "out", "vs", "workbench", "workbench.desktop.main.js"))) || null;
}

function workbenchPath() {
  const appRoot = findCursorAppRoot();
  return appRoot ? path.join(appRoot, "out", "vs", "workbench", "workbench.desktop.main.js") : null;
}

// Read only the last `maxBytes` of a file without loading the whole 60MB+
// workbench into memory. The appended patch block lives at EOF, so the tail is
// enough to detect `installed` cheaply on every panel refresh. The native
// P1/P2/P3 edits live in the file body and are tracked separately via globalState
// (recorded at install time) so we never scan the full file on a status refresh.
function readFileTail(filePath, maxBytes) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

const RETRY_PATCH_CACHE_MS = 300000;

function getRetryPatchStatus({ force = false } = {}) {
  if (vscode.env.remoteName) return { found: false, installed: false, target: "", remote: true, note: "此功能只作用于本机 Cursor，不作用于远程服务器。" };
  if (!force && retryPatchCache.value && nowMs() - retryPatchCache.at < RETRY_PATCH_CACHE_MS) return retryPatchCache.value;
  const target = workbenchPath();
  let value;
  if (!target) value = { found: false, installed: false, target: "" };
  else {
    try {
      const tail = readFileTail(target, 524288);
      value = { found: true, installed: tail.includes(PATCH_START), target };
    } catch (error) {
      value = { found: true, installed: false, target, error: error.message };
    }
  }
  retryPatchCache = { at: nowMs(), value };
  return value;
}

// Returns the cheap patch status, plus the P1/P2/P3 detail (from globalState) when
// the patch is installed. Clones so the cached status object is never mutated.
function patchStatusWithNative(context, force) {
  const patch = { ...getRetryPatchStatus({ force }) };
  if (patch.installed && context && context.globalState) {
    const native = context.globalState.get(RETRY_NATIVE_KEY);
    if (native) patch.native = native;
  }
  return patch;
}

// --- Native Patch P1/P2/P3 -------------------------------------------------
// Patches Cursor's own workbench.desktop.main.js so retries happen at the
// request layer instead of only via DOM clicks:
//   P1: don't throw the paywall error while in endless-retry mode
//   P2: high-capacity circuit breaker. Returns true for 5000 attempts (~4 min
//       at 50ms), then false ONCE so the request completes and its object graph
//       is released for GC. The DOM helper instantly resets globalThis.__lcaNR
//       and clicks retry, starting a fresh native wave. The user never sees the
//       ~1-2s gap (auto-hide + hidden popup). This is functionally infinite retry
//       but prevents the monotonic JS-heap growth that caused the 0.7.0 OOM.
//   P3: pin the retry delay to 50ms (fast retry). The rate-limit messages this
//       can produce are auto-hidden by the DOM helper.
// These only match/modify Cursor's own code (no external binary or license).
const NATIVE_P2_FROM = "getSmokeTestEndlessRetries(){if(this.environmentService.smokeTestNalEndlessRetries)return()=>!0}";
// 5000 retries * 50ms = ~4.2 min per wave before one GC-friendly completion.
const NATIVE_P2_WAVE_LIMIT = 5000;
const NATIVE_P2_TO = "getSmokeTestEndlessRetries(){return()=>{var g=globalThis,s=g.__lcaNR||(g.__lcaNR={n:0,t:0}),t=Date.now();if(t-s.t>2500)s.n=0;s.t=t;return++s.n<=" + NATIVE_P2_WAVE_LIMIT + "}}";
// 0.7.0/0.7.5 shipped a truly unbounded P2 (always true); keep the literal so
// applyNativePatch can upgrade it to the circuit breaker and removeNativePatch
// can revert installs made by them.
const NATIVE_P2_TO_LEGACY_INFINITE = "getSmokeTestEndlessRetries(){return()=>!0}";
// 0.7.2–0.7.4 shipped a bounded P2 (maxRetries=200); keep the literal for the
// same reason.
const NATIVE_P2_TO_BOUNDED = "getSmokeTestEndlessRetries(){return()=>{var g=globalThis,s=g.__lcaNR||(g.__lcaNR={n:0,t:0}),t=Date.now(),c=g.__lcaRetryConfig||{},m=c.maxRetries>0?c.maxRetries:200;if(t-s.t>2500)s.n=0;s.t=t;return++s.n<=m}}";
const NATIVE_P3_FROM = "getSmokeTestRetryDelayMs(){return this.environmentService.smokeTestNalRetryDelayMs}";
// P3 pins the request-layer retry delay to a flat 50ms (fast retry). This used to
// surface rate-limit messages; instead of slowing retries with backoff, the DOM
// helper now auto-hides those messages (per user choice), so we keep 50ms.
const NATIVE_P3_TO = "getSmokeTestRetryDelayMs(){return 50}";
// 0.7.3 briefly shipped an exponential-backoff P3; keep the literal so
// applyNativePatch can replace it back with 50ms and removeNativePatch can revert
// installs made by that build.
const NATIVE_P3_TO_BACKOFF = "getSmokeTestRetryDelayMs(){var g=globalThis,n=(g.__lcaNR&&g.__lcaNR.n)||0;return n<=2?500:n<=8?1500:n<=20?4000:8000}";
const NATIVE_P1_ORIG = /(\w+) instanceof (\w+)\|\|\1 instanceof (\w+)\|\|\1 instanceof (\w+)\?\{action:"throw",error:\1\}/;
const NATIVE_P1_ORIG_G = /(\w+) instanceof (\w+)\|\|\1 instanceof (\w+)\|\|\1 instanceof (\w+)\?\{action:"throw",error:\1\}/g;
const NATIVE_P1_PATCHED = /(\w+) instanceof (\w+)\|\|!(\w+)&&\1 instanceof (\w+)\|\|\1 instanceof (\w+)\?\{action:"throw",error:\1\}/;
const NATIVE_P1_ENDLESS = /!(\w+)&&\w+>=\w+\?\{action:"throw"/;

function applyNativePatch(content) {
  const notes = [];
  let changed = false;
  let p1 = NATIVE_P1_PATCHED.test(content);
  let p2 = content.includes(NATIVE_P2_TO);
  let p3 = content.includes(NATIVE_P3_TO);
  if (p1) {
    notes.push("P1 已是最新");
  } else {
    const matches = content.match(NATIVE_P1_ORIG_G);
    if (!matches || matches.length === 0) {
      notes.push("P1 未找到匹配（Cursor 版本变化？）");
    } else if (matches.length > 1) {
      notes.push(`P1 匹配到 ${matches.length} 处，有歧义，跳过`);
    } else {
      const ev = NATIVE_P1_ENDLESS.exec(content);
      const endlessVar = ev ? ev[1] : "o";
      const next = content.replace(NATIVE_P1_ORIG, `$1 instanceof $2||!${endlessVar}&&$1 instanceof $3||$1 instanceof $4?{action:"throw",error:$1}`);
      if (next !== content) {
        content = next;
        changed = true;
        p1 = true;
        notes.push("P1 已应用：跳过付费墙 throw");
      } else {
        notes.push("P1 替换失败");
      }
    }
  }
  if (p2) {
    notes.push("P2 已是最新");
  } else if (content.includes(NATIVE_P2_TO_LEGACY_INFINITE)) {
    content = content.replace(NATIVE_P2_TO_LEGACY_INFINITE, NATIVE_P2_TO);
    changed = true;
    p2 = true;
    notes.push("P2 已升级：无限重试 → 高容量断路器（5000次/波，防OOM）");
  } else if (content.includes(NATIVE_P2_TO_BOUNDED)) {
    content = content.replace(NATIVE_P2_TO_BOUNDED, NATIVE_P2_TO);
    changed = true;
    p2 = true;
    notes.push("P2 已升级：有界(200) → 高容量断路器（5000次/波，防OOM）");
  } else if (content.includes(NATIVE_P2_FROM)) {
    content = content.replace(NATIVE_P2_FROM, NATIVE_P2_TO);
    changed = true;
    p2 = true;
    notes.push("P2 已应用：高容量断路器（5000次/波，~4分钟后GC一次）");
  } else {
    notes.push("P2 未找到匹配");
  }
  if (p3) {
    notes.push("P3 已是最新");
  } else if (content.includes(NATIVE_P3_TO_BACKOFF)) {
    content = content.replace(NATIVE_P3_TO_BACKOFF, NATIVE_P3_TO);
    changed = true;
    p3 = true;
    notes.push("P3 已改回：退避 → 50ms（错误改由 DOM 自动隐藏）");
  } else if (content.includes(NATIVE_P3_FROM)) {
    content = content.replace(NATIVE_P3_FROM, NATIVE_P3_TO);
    changed = true;
    p3 = true;
    notes.push("P3 已应用：50ms 快速重试");
  } else {
    notes.push("P3 未找到匹配");
  }
  return { content, changed, p1, p2, p3, notes };
}

function removeNativePatch(content) {
  let changed = false;
  if (content.includes(NATIVE_P2_TO)) {
    content = content.replace(NATIVE_P2_TO, NATIVE_P2_FROM);
    changed = true;
  }
  if (content.includes(NATIVE_P2_TO_LEGACY_INFINITE)) {
    content = content.replace(NATIVE_P2_TO_LEGACY_INFINITE, NATIVE_P2_FROM);
    changed = true;
  }
  if (content.includes(NATIVE_P2_TO_BOUNDED)) {
    content = content.replace(NATIVE_P2_TO_BOUNDED, NATIVE_P2_FROM);
    changed = true;
  }
  if (content.includes(NATIVE_P3_TO)) {
    content = content.replace(NATIVE_P3_TO, NATIVE_P3_FROM);
    changed = true;
  }
  if (content.includes(NATIVE_P3_TO_BACKOFF)) {
    content = content.replace(NATIVE_P3_TO_BACKOFF, NATIVE_P3_FROM);
    changed = true;
  }
  const next = content.replace(NATIVE_P1_PATCHED, '$1 instanceof $2||$1 instanceof $4||$1 instanceof $5?{action:"throw",error:$1}');
  if (next !== content) {
    content = next;
    changed = true;
  }
  return { content, changed };
}

// Stray DOM-injection blocks left in the workbench by earlier experiments or
// older tooling (e.g. the "==CC_AUTO_DISMISS==" indicator that injects a `.cc-ind`
// dot). These live outside our PATCH_START/PATCH_END markers, so the normal
// uninstall never touches them and they pile up across reinstalls. Strip them on
// both install and uninstall so the appended region stays clean and only our
// current retry helper runs. The block is a single IIFE whose only `})();` is the
// closing call, so a lazy match to the first `})();` is safe.
const LEGACY_INJECTION_RE = /\n*\/\/\s*==CC_AUTO_DISMISS==[\s\S]*?\}\)\(\);/g;

function stripLegacyInjections(content) {
  const next = content.replace(LEGACY_INJECTION_RE, "");
  return { content: next, changed: next !== content };
}

function patchBlock(context) {
  const paths = getPaths(context);
  const helper = fs.readFileSync(paths.retryHelper, "utf8");
  // Inject the user-configurable retry budget into the DOM helper. The helper
  // reads window.__lcaRetryConfig.maxRetries to cap how many times one DOM failure
  // wave is retried. The native P2 uses a fixed 5000-attempt circuit breaker
  // (not configurable) to periodically release memory. autoHide keeps transient
  // errors out of view.
  let maxRetries = 200;
  try { maxRetries = readSettings(paths).retryMaxRetries; } catch { /* keep default */ }
  // autoHide keeps the rate-limit/paywall error UI out of view while the native
  // 50ms retry runs in the background (per user request). Always on for now.
  const config = `window.__lcaRetryConfig=${JSON.stringify({ maxRetries, autoHide: true })};`;
  return `\n;${PATCH_START}\n${config}\n${helper}\n${PATCH_END}\n`;
}

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// F-2: when the Cursor install lives under a protected dir (e.g. Program Files),
// writing workbench.desktop.main.js needs admin. Re-run the copy via an elevated
// PowerShell (UAC prompt) so the user doesn't have to relaunch Cursor as admin.
function elevatedApplyWindows(targetPath, newContentPath, backupPath) {
  const steps = ["$ErrorActionPreference='Stop'"];
  if (backupPath) steps.push(`Copy-Item -LiteralPath ${psSingleQuote(targetPath)} -Destination ${psSingleQuote(backupPath)} -Force`);
  steps.push(`Copy-Item -LiteralPath ${psSingleQuote(newContentPath)} -Destination ${psSingleQuote(targetPath)} -Force`);
  const scriptPath = path.join(os.tmpdir(), `cutc-elevate-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(scriptPath, steps.join("\n"), "utf8");
  try {
    const launcher = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${psSingleQuote(scriptPath)})`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", launcher], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || "").trim() || `提权进程退出码 ${result.status}（可能取消了 UAC 授权）。`);
  } finally {
    safeUnlink(scriptPath);
  }
}

// Write `content` to the workbench file, transparently elevating on Windows
// permission errors. `backupPath` (optional) is copied from the current target
// before overwriting.
function writeWorkbench(targetPath, content, backupPath) {
  try {
    if (backupPath) fs.copyFileSync(targetPath, backupPath);
    fs.writeFileSync(targetPath, content, "utf8");
  } catch (error) {
    if (process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES")) {
      const tmp = path.join(os.tmpdir(), `cutc-workbench-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
      fs.writeFileSync(tmp, content, "utf8");
      try {
        elevatedApplyWindows(targetPath, tmp, backupPath);
      } finally {
        safeUnlink(tmp);
      }
      return { elevated: true };
    }
    throw error;
  }
  return { elevated: false };
}

function pruneWorkbenchBackups(targetPath, keep = 3) {
  try {
    const dir = path.dirname(targetPath);
    const prefix = `${path.basename(targetPath)}.local-continue-backup-`;
    const backups = fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(dir, name))
      .sort(); // ISO-timestamp suffix sorts chronologically
    for (const old of backups.slice(0, Math.max(0, backups.length - keep))) safeUnlink(old);
  } catch {
    // Best effort: an extra leftover backup is harmless.
  }
}

function installRetryPatch(context) {
  if (vscode.env.remoteName) throw new Error("重试助手只修改本机 Cursor。请在本机窗口安装。");
  const target = workbenchPath();
  if (!target) throw new Error("没有找到 Cursor workbench.desktop.main.js。");
  const original = fs.readFileSync(target, "utf8");
  const backup = `${target}.local-continue-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const legacy = stripLegacyInjections(original);
  // Apply the native patch: P1 (skip paywall throw) + P2 (high-capacity circuit
  // breaker: 5000 retries/wave then one GC-friendly completion) + P3 (50ms). The
  // 402/paywall auto-retry lives at the request layer. The DOM helper resets
  // globalThis.__lcaNR to instantly restart each wave, and auto-hide keeps any
  // transient errors out of view. The periodic completion prevents the OOM that
  // a truly infinite retry caused in 0.7.0.
  const native = applyNativePatch(legacy.content);
  let content = native.content;
  if (content.includes(PATCH_START)) {
    const start = content.indexOf(`;${PATCH_START}`);
    const end = content.indexOf(PATCH_END, start);
    if (start < 0 || end < 0) throw new Error("补丁标记不完整，已停止更新。");
    content = content.slice(0, start) + patchBlock(context) + content.slice(end + PATCH_END.length);
  } else {
    content = content + patchBlock(context);
  }
  const write = writeWorkbench(target, content, backup);
  pruneWorkbenchBackups(target);
  retryPatchCache = { at: 0, value: null };
  const nativeInfo = { p1: native.p1, p2: native.p2, p3: native.p3, notes: native.notes };
  if (context && context.globalState) {
    context.globalState.update(RETRY_WANTED_KEY, true);
    context.globalState.update(RETRY_NATIVE_KEY, nativeInfo);
  }
  return { target, backup, changed: true, elevated: write.elevated, legacyCleaned: legacy.changed, native: nativeInfo, nativeChanged: native.changed };
}

function uninstallRetryPatch(context) {
  if (vscode.env.remoteName) throw new Error("重试助手只修改本机 Cursor。请在本机窗口卸载。");
  const target = workbenchPath();
  if (!target) throw new Error("没有找到 Cursor workbench.desktop.main.js。");
  let content = fs.readFileSync(target, "utf8");
  let changed = false;
  if (content.includes(PATCH_START)) {
    const start = content.indexOf(`;${PATCH_START}`);
    const end = content.indexOf(PATCH_END, start);
    if (start < 0 || end < 0) throw new Error("补丁标记不完整，已停止卸载。");
    content = content.slice(0, start) + content.slice(end + PATCH_END.length);
    changed = true;
  }
  const reverted = removeNativePatch(content);
  if (reverted.changed) {
    content = reverted.content;
    changed = true;
  }
  const legacy = stripLegacyInjections(content);
  if (legacy.changed) {
    content = legacy.content;
    changed = true;
  }
  if (changed) writeWorkbench(target, content);
  retryPatchCache = { at: 0, value: null };
  if (context && context.globalState) {
    context.globalState.update(RETRY_WANTED_KEY, false);
    context.globalState.update(RETRY_NATIVE_KEY, null);
  }
  return { target, changed };
}

// ---------------------------------------------------------------------------
// WorkspaceTools — file search, read, and summary utilities for the agent.
// Ported from cursor-continue 0.6.0's Ee class, adapted for local-continue.
// ---------------------------------------------------------------------------
const WS_TEXT_EXTENSIONS = new Set([
  ".txt", ".py", ".js", ".ts", ".tsx", ".jsx", ".md", ".html", ".css",
  ".json", ".xml", ".yaml", ".yml", ".toml", ".ini", ".ps1", ".sh", ".bat",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".java", ".go", ".rs", ".php", ".rb",
  ".vue", ".svelte", ".sql", ".graphql", ".proto", ".dart", ".swift", ".kt",
]);

class WorkspaceTools {
  constructor(outputChannel) {
    this.output = outputChannel;
  }

  getWorkspaceFolders() {
    const folders = vscode.workspace.workspaceFolders;
    return folders ? Array.from(folders) : [];
  }

  getPrimaryWorkspaceFolder() {
    const folders = this.getWorkspaceFolders();
    return folders.length ? folders[0] : null;
  }

  toDisplayPath(uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return uri.fsPath;
    const rel = path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
    return this.getWorkspaceFolders().length === 1 ? rel : `${folder.name}/${rel}`;
  }

  isTextFile(filePath, buffer) {
    if (buffer && buffer.includes(0)) return false;
    const ext = path.extname(filePath).toLowerCase();
    return WS_TEXT_EXTENSIONS.has(ext);
  }

  isPathInsideWorkspace(target, workspaceRoot) {
    const rel = path.relative(workspaceRoot, target);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
      || path.normalize(target) === path.normalize(workspaceRoot);
  }

  resolveWorkspacePath(relativePath) {
    const folders = this.getWorkspaceFolders();
    if (!folders.length) throw new Error("没有打开的工作区。");
    const rel = String(relativePath || "").replace(/\\/g, "/").replace(/^\.?\//, "");
    if (path.isAbsolute(rel)) {
      const abs = rel;
      const folder = folders.find((f) => this.isPathInsideWorkspace(abs, f.uri.fsPath));
      if (!folder) throw new Error("绝对路径不在当前工作区内。");
      return { absolutePath: abs, displayPath: this.toDisplayPath(vscode.Uri.file(abs)), workspaceFolder: folder };
    }
    if (folders.length === 1) {
      const abs = path.join(folders[0].uri.fsPath, rel);
      return { absolutePath: abs, displayPath: this.toDisplayPath(vscode.Uri.file(abs)), workspaceFolder: folders[0] };
    }
    const [first, ...rest] = rel.split("/");
    const folder = folders.find((f) => f.name === first);
    if (folder) {
      const abs = path.join(folder.uri.fsPath, ...rest);
      return { absolutePath: abs, displayPath: this.toDisplayPath(vscode.Uri.file(abs)), workspaceFolder: folder };
    }
    const candidates = folders.map((f) => ({ folder: f, absolutePath: path.join(f.uri.fsPath, rel) }))
      .filter((c) => fs.existsSync(c.absolutePath));
    if (candidates.length === 1) {
      return { absolutePath: candidates[0].absolutePath, displayPath: this.toDisplayPath(vscode.Uri.file(candidates[0].absolutePath)), workspaceFolder: candidates[0].folder };
    }
    throw new Error("多工作区下路径不明确，请使用 <工作区名>/<相对路径>。");
  }

  async listWorkspaceFiles(maxResults = 200) {
    const excludes = "**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/out/**";
    const uris = await vscode.workspace.findFiles("**/*", excludes, maxResults);
    return uris.map((uri) => this.toDisplayPath(uri));
  }

  async readWorkspaceFile(relativePath, startLine, endLine) {
    const { absolutePath } = this.resolveWorkspacePath(relativePath);
    const stat = fs.statSync(absolutePath);
    if (stat.size > 256 * 1024) {
      const fd = fs.openSync(absolutePath, "r");
      try {
        const buf = Buffer.alloc(256 * 1024);
        const bytes = fs.readSync(fd, buf, 0, 256 * 1024, 0);
        return `${buf.toString("utf8", 0, bytes)}\n[...文件过大已截断：共 ${stat.size} 字节，仅显示前 ${bytes} 字节...]`;
      } finally {
        fs.closeSync(fd);
      }
    }
    let content = fs.readFileSync(absolutePath, "utf8");
    if (startLine != null || endLine != null) {
      const lines = content.split(/\r?\n/);
      const start = Math.max(0, Number(startLine || 1) - 1);
      const end = Math.min(lines.length, Number(endLine || lines.length));
      content = lines.slice(start, end).join("\n");
    }
    return content;
  }

  async searchWithRipgrep(query, globPattern, maxResults = 50) {
    const folders = this.getWorkspaceFolders();
    if (!folders.length) return [];
    const args = ["--line-number", "--no-heading", "--color", "never", "--smart-case", "--hidden",
      "--glob", "!.git", "--glob", "!node_modules", "--max-count", String(maxResults), query];
    if (globPattern) args.unshift("--glob", globPattern);
    const results = [];
    for (const folder of folders) {
      try {
        const { stdout } = await new Promise((resolve, reject) => {
          require("child_process").execFile("rg", args, { cwd: folder.uri.fsPath, maxBuffer: 8388608 }, (err, stdout, stderr) => {
            if (err && err.code !== 1) reject(err);
            else resolve({ stdout: stdout || "", stderr: stderr || "" });
          });
        });
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const firstColon = line.indexOf(":");
          const secondColon = line.indexOf(":", firstColon + 1);
          if (firstColon <= 0 || secondColon <= firstColon) continue;
          const file = line.slice(0, firstColon);
          const lineNum = Number(line.slice(firstColon + 1, secondColon));
          const text = line.slice(secondColon + 1);
          results.push({ file: this.toDisplayPath(vscode.Uri.file(path.join(folder.uri.fsPath, file))), line: lineNum, text });
          if (results.length >= maxResults) return results;
        }
      } catch {
        // rg not available, fall through to workspace API
      }
    }
    if (!results.length) return await this.searchWithWorkspaceApi(query, globPattern, maxResults);
    return results;
  }

  async searchWithWorkspaceApi(query, globPattern, maxResults) {
    const excludes = "**/node_modules/**,**/.git/**,**/dist/**,**/build/**";
    const uris = await vscode.workspace.findFiles(globPattern?.trim() || "**/*", excludes, 200);
    const results = [];
    for (const uri of uris) {
      if (results.length >= maxResults) break;
      const buf = await vscode.workspace.fs.readFile(uri);
      if (!this.isTextFile(uri.fsPath, buf)) continue;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        if (lines[i].includes(query)) {
          results.push({ file: this.toDisplayPath(uri), line: i + 1, text: lines[i] });
        }
      }
    }
    return results;
  }

  formatMatches(matches) {
    return matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n");
  }

  async buildWorkspaceSummary() {
    const folder = this.getPrimaryWorkspaceFolder();
    if (!folder) return "没有打开的工作区。";
    const root = folder.uri.fsPath;
    let topFiles = [];
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      topFiles = entries.filter((e) => e.isFile()).slice(0, 20).map((e) => e.name);
    } catch { /* best effort */ }
    const editor = vscode.window.activeTextEditor;
    let activeFile = "";
    let activeSelection = "";
    if (editor) {
      activeFile = this.toDisplayPath(editor.document.uri);
      const sel = editor.selection;
      if (sel && !sel.isEmpty) {
        activeSelection = editor.document.getText(sel).slice(0, 2048);
      }
    }
    const parts = [`工作区：${root}`, `顶层文件：${topFiles.join(", ") || "(无)"}`];
    if (activeFile) {
      parts.push(`当前编辑器：${activeFile}`);
      if (activeSelection) parts.push(`选区内容：\n${activeSelection}`);
    }
    return parts.join("\n");
  }
}

class PanelProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.timer = undefined;
    this.watcher = undefined;
    this.watchDebounce = undefined;
    this.notifiedResultMs = {};
    this.attentionBaselineSet = false;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.onDidDispose(() => {
      this.clearTimer();
      this.disposeWatcher();
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.setupWatcher();
        this.postStatus({ forcePatch: false });
      } else {
        this.clearTimer();
      }
    });
    view.webview.onDidReceiveMessage(async (message) => {
      let statusPosted = false;
      try {
        statusPosted = await this.handleMessage(message || {});
      } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        this.event(`错误：${detail}`);
        vscode.window.showErrorMessage(`续聊助手：${detail}`);
      } finally {
        if (!statusPosted) this.postStatus({ forcePatch: false });
      }
    });
    this.setupWatcher();
    this.postStatus({ forcePatch: true });
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // P-2: watch the state dir so queue/status changes refresh the panel almost
  // instantly (event-driven) instead of relying only on polling. The polling
  // timer stays as a slower safety net (it also recomputes the heartbeat-age /
  // offline transition, which is the *absence* of writes and so has no event).
  setupWatcher() {
    if (this.watcher) return;
    let stateDir;
    try {
      stateDir = ensureRuntime(this.context).stateDir;
    } catch {
      return;
    }
    try {
      this.watcher = fs.watch(stateDir, { recursive: true }, () => this.onWatchEvent());
      this.watcher.on("error", () => this.disposeWatcher());
    } catch {
      this.watcher = undefined;
    }
  }

  onWatchEvent() {
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = undefined;
      if (this.view && this.view.visible) this.postStatus({ forcePatch: false });
    }, 150);
  }

  disposeWatcher() {
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* already closed */ }
      this.watcher = undefined;
    }
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = undefined;
    }
  }

  scheduleNext(status) {
    this.clearTimer();
    if (!this.view || !this.view.visible) return;
    const sessions = status.sessions || [];
    const hasOnline = sessions.some((session) => session.connected);
    // A session that is "working" or "stalled" has no live heartbeat (the waiter
    // exited while the agent works), so only the timer -- not the fs watcher --
    // can tick its elapsed time and flip it to "stalled". Refresh faster while any
    // such session exists so the list reflects mid-run progress in near real time.
    const hasLive = sessions.some((session) => session.activity === "working" || session.activity === "stalled");
    // With the watcher driving queue/heartbeat updates, the timer only needs to
    // catch the time-based transitions, so it can run slower otherwise.
    const delay = this.watcher
      ? (hasLive ? 3000 : 5000)
      : (hasOnline || hasLive || status.totalQueueLength > 0 ? 1000 : 3000);
    this.timer = setTimeout(() => this.postStatus({ forcePatch: false }), delay);
  }

  async handleMessage(message) {
    const paths = ensureRuntime(this.context);
    if (message.type === "createSession") {
      const item = registerSession(paths, message.name);
      this.event(`已创建会话：${item.name}`);
      this.reply({ type: "sessionCreated", session: item });
    } else if (message.type === "deleteSession") {
      removeSession(paths, message.sessionId);
      this.event("已删除会话。");
    } else if (message.type === "updateSessionSettings") {
      const item = setSessionOverrides(paths, message.sessionId, message.overrides || {});
      this.event(item.overrides ? `已更新会话设置：${item.name}` : `已清除会话覆盖：${item.name}`);
    } else if (message.type === "renameSessionPrompt") {
      const current = readSessionsIndex(paths).sessions.find((entry) => entry.id === safeSessionId(message.sessionId || ""));
      const value = await vscode.window.showInputBox({ title: "重命名会话", value: current ? current.name : "", ignoreFocusOut: true });
      if (value !== undefined && value.trim()) {
        const item = renameSession(paths, message.sessionId, value);
        this.event(`已重命名会话为：${item.name}`);
      }
    } else if (message.type === "copyAgentInstruction") {
      const built = await copySmartInstruction(this.context, message.sessionId || "agent-1");
      const modeLabel = built.mode === "mcp" ? "MCP" : "shell";
      if (built.created) {
        this.reply({ type: "sessionCreated", session: { id: built.id } });
        this.postStatus({ forcePatch: false });
        this.event(`当前会话已有在线 Agent，已为新对话创建独立会话并复制其${modeLabel}启动指令（${built.id}）。`);
        return true;
      } else {
        this.event(`已复制${modeLabel}启动指令（会话 ${built.id}）。${built.mode === "shell" ? "装好 MCP 配置并重启 Cursor 后会自动改用 MCP。" : ""}`);
      }
    } else if (message.type === "copyShellInstruction") {
      const built = await copyAgentInstruction(this.context, message.sessionId || "agent-1");
      if (built.created) {
        this.reply({ type: "sessionCreated", session: { id: built.id } });
        this.postStatus({ forcePatch: false });
        this.event(`已为新对话创建独立会话并复制其 shell 启动指令（${built.id}）。`);
        return true;
      }
      this.event(`已复制 shell 启动指令（会话 ${built.id}）。`);
    } else if (message.type === "startWait") {
      const resolved = startWaitTerminal(this.context, message.sessionId || "agent-1");
      if (resolved.created) {
        this.reply({ type: "sessionCreated", session: { id: resolved.id } });
        this.postStatus({ forcePatch: false });
        this.event(`当前会话已有在线 Agent，已为新对话创建独立会话并在终端启动等待（${resolved.id}）。`);
        return true;
      } else {
        this.event("已启动当前会话等待终端。");
      }
    } else if (message.type === "startDoctor") {
      startDoctorTerminal(this.context);
      this.event("已在终端运行 doctor 自检。");
    } else if (message.type === "installMcp") {
      const result = installMcpConfig(this.context);
      this.event(`已写入 MCP 配置：${result.target}（需重启 Cursor 让 MCP 服务器生效）。`);
    } else if (message.type === "copyMcpInstruction") {
      const built = await copyMcpInstruction(this.context, message.sessionId || "agent-1");
      if (built.created) {
        this.reply({ type: "sessionCreated", session: { id: built.id } });
        this.postStatus({ forcePatch: false });
        this.event(`当前会话已有在线 Agent，已为新对话创建独立会话并复制其 MCP 启动指令（${built.id}）。`);
        return true;
      }
      this.event(`已复制 MCP 启动指令（会话 ${built.id}）。`);
    } else if (message.type === "installRule") {
      this.event(`已同步项目规则：${installRule(this.context)}`);
    } else if (message.type === "send") {
      const payload = normalizePayload(message.payload || {});
      if (!payload.user_input.trim() && payload.file_paths.length === 0 && payload.image_paths.length === 0) throw new Error("指令、文件和图片不能同时为空。");
      const items = dispatchPayload(paths, payload, message.targetMode, message.sessionId);
      // Seed an auto-title from the first real instruction each session receives.
      for (const it of items) {
        if (it && it.target && it.target !== "idle-first") maybeSetAutoTitle(paths, it.target, payload.user_input);
      }
      this.event(`已入队 ${items.length} 条消息。`);
    } else if (message.type === "stop") {
      enqueueToSession(paths, message.sessionId || "agent-1", { status: "stop", user_input: "stop" }, "panel-stop");
      this.event("已发送停止指令。");
    } else if (message.type === "handoffSession") {
      const res = handoffSession(paths, message.sourceId, message.targetId, message.context, message.reason);
      this.event(`已转接「${res.sourceName}」→ ${res.targetId}，等待目标会话消费。`);
    } else if (message.type === "clearQueue") {
      clearQueue(paths, message.scope || "session", message.sessionId || "agent-1");
      this.event("已清空队列。");
    } else if (message.type === "removeQueued") {
      const removed = removeQueued(paths, message.sessionId || "agent-1", String(message.id || ""), message.scope || "session");
      this.event(removed ? "已移除排队消息。" : "没有找到要移除的消息。");
    } else if (message.type === "moveQueued") {
      const moved = moveQueued(paths, message.sessionId || "agent-1", String(message.id || ""), message.direction === "up" ? "up" : "down", message.scope || "session");
      if (!moved) this.event("无法移动该消息（已在顶部/底部）。");
    } else if (message.type === "pickFiles") {
      this.reply({ type: "filesPicked", paths: await pickFiles() });
    } else if (message.type === "pickActiveEditor") {
      this.reply({ type: "filesPicked", paths: [pickActiveEditor()] });
    } else if (message.type === "pickWorkspaceFolder") {
      this.reply({ type: "filesPicked", paths: [paths.workspaceRoot] });
    } else if (message.type === "pasteImage") {
      this.reply({ type: "pastedImageSaved", path: savePastedImage(this.context, message.dataUrl) });
    } else if (message.type === "copyText") {
      const text = String(message.text || "");
      if (text) {
        await vscode.env.clipboard.writeText(text);
        this.event(`已复制：${compactForUi(text, 80)}`);
      }
    } else if (message.type === "requestThumb") {
      const dataUrl = readImageThumb(message.path);
      if (dataUrl) this.reply({ type: "thumb", path: message.path, dataUrl });
    } else if (message.type === "requestResultTimeline") {
      const items = readHistory(paths.history, 300).filter((record) => record && record.type === "result").slice(-120).reverse();
      this.reply({ type: "resultTimeline", items });
    } else if (message.type === "updateExtensionSettings") {
      this.reply({ type: "extensionSettingsSaved", settings: saveSettings(this.context, message.settings || {}) });
      this.event("设置已保存。");
    } else if (message.type === "installRetryPatch") {
      const result = installRetryPatch(this.context);
      const np = result.nativeChanged ? "（已写入 native 断路器补丁：5000次/波自动重试+GC回收，错误自动隐藏）" : "";
      const elev = result.elevated ? "（已通过管理员提权写入）" : "";
      const cleaned = result.legacyCleaned ? "（已清理旧注入残留）" : "";
      this.event(`已注入图标 / 安装重试助手${np}${elev}${cleaned}，需完全退出并重启 Cursor（不是重载窗口）才会生效：${result.target}`);
      this.postStatus({ forcePatch: true });
      return true;
    } else if (message.type === "uninstallRetryPatch") {
      const result = uninstallRetryPatch(this.context);
      this.event(result.changed ? `已卸载本机聊天框重试助手，重启 Cursor 生效：${result.target}` : "重试助手未安装。");
      this.postStatus({ forcePatch: true });
      return true;
    } else if (message.type === "workspaceListFiles") {
      const tools = this._getWorkspaceTools();
      const files = await tools.listWorkspaceFiles(message.maxResults || 200);
      this.reply({ type: "workspaceFiles", files });
    } else if (message.type === "workspaceReadFile") {
      const tools = this._getWorkspaceTools();
      try {
        const content = await tools.readWorkspaceFile(message.filePath, message.startLine, message.endLine);
        this.reply({ type: "workspaceFileContent", filePath: message.filePath, content });
      } catch (err) {
        this.reply({ type: "workspaceFileContent", filePath: message.filePath, error: err.message });
      }
    } else if (message.type === "workspaceSearch") {
      const tools = this._getWorkspaceTools();
      const matches = await tools.searchWithRipgrep(message.query, message.globPattern, message.maxResults || 50);
      this.reply({ type: "workspaceSearchResults", matches, formatted: tools.formatMatches(matches) });
    } else if (message.type === "workspaceSummary") {
      const tools = this._getWorkspaceTools();
      const summary = await tools.buildWorkspaceSummary();
      this.reply({ type: "workspaceSummary", summary });
    }
    return false;
  }

  postStatus(options = {}) {
    if (!this.view) return;
    const status = getBridgeStatus(this.context, options);
    this.reply({ type: "status", status });
    this.notifyAttention(status);
    this.scheduleNext(status);
  }

  notifyAttention(status) {
    if (!status) return;
    const sessions = status.sessions || [];
    // Baseline existing results on first status so opening/reloading the panel
    // never fires popups for results that already happened.
    if (!this.attentionBaselineSet) {
      for (const session of sessions) this.notifiedResultMs[session.id] = Number(session.lastResultAtMs || 0);
      this.attentionBaselineSet = true;
      return;
    }
    if (status.extensionSettings && status.extensionSettings.notifyOnAttention === false) return;
    for (const session of sessions) {
      const at = Number(session.lastResultAtMs || 0);
      const needsAttention = session.lastResultStatus === "need_input" || session.lastResultStatus === "error";
      if (!needsAttention || !at || at <= (this.notifiedResultMs[session.id] || 0)) continue;
      this.notifiedResultMs[session.id] = at;
      const label = session.lastResultStatus === "need_input" ? "需要你确认" : "报告了错误";
      const detail = session.lastResult ? ` — ${session.lastResult}` : "";
      const text = `续聊助手 · ${session.name || session.id}：${label}${detail}`;
      if (session.lastResultStatus === "error") vscode.window.showWarningMessage(text);
      else vscode.window.showInformationMessage(text);
    }
  }

  reply(message) {
    if (this.view) this.view.webview.postMessage(message);
  }

  event(text) {
    this.reply({ type: "event", text: compactForUi(text), at: new Date().toLocaleTimeString() });
  }

  _getWorkspaceTools() {
    if (!this._workspaceTools) {
      const ch = vscode.window.createOutputChannel("local-continue-workspace");
      this._workspaceTools = new WorkspaceTools(ch);
    }
    return this._workspaceTools;
  }

  html(webview) {
    const nonce = String(Date.now());
    const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", "panel.css")));
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", "panel.js")));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div id="app">
    <div class="shell compact-shell">
      <section class="panel topbar app-topbar">
        <div class="brand">
          <div class="brand-mark">续</div>
          <div class="brand-copy">
            <div class="title-row">
              <div class="title">续聊助手</div>
              <span id="onlinePill" class="status-pill">在线会话 0/0</span>
              <span id="queuePill" class="meta-chip">待消费 0</span>
              <span id="modePill" class="meta-chip" title="启动模式：装了 MCP 配置走 MCP（更稳），否则走 shell">模式：shell</span>
              <span id="patchState" class="meta-chip">重试助手：未知</span>
            </div>
            <div id="workspace" class="subtitle">等待打开项目</div>
          </div>
        </div>
        <div class="header-actions">
          <button class="mini-button" id="newSession">新建会话</button>
          <button class="mini-button" id="installMcpTop" title="把 MCP 服务器写入 .cursor/mcp.json（首次用 MCP 模式需要，装好后完全重启 Cursor）">① 安装 MCP 配置</button>
          <button class="mini-button primary" id="copyInstruction" title="复制启动指令并发给 Cursor 对话。装了 MCP 就给 MCP 指令，否则给 shell 指令。">② 复制启动指令</button>
          <button class="mini-button" id="settingsBtn">设置</button>
          <button class="mini-button" id="moreBtn">更多</button>
        </div>
      </section>

      <section class="panel status-strip slim-status">
        <div class="status-row">
          <span id="statusText" class="meta-chip">等待会话连接</span>
          <span id="selectedSessionText" class="meta-chip">当前会话：未选择</span>
          <span class="status-row-spacer"></span>
          <button class="mini-button" id="eventHistoryBtn">执行记录</button>
        </div>
        <div id="events" class="meta-hint"></div>
      </section>

      <section class="panel chat-panel compact">
        <div class="composer">
          <div class="session-head">
            <div>
              <div class="composer-title">会话列表</div>
              <div class="composer-summary">每个 Cursor 官方对话使用一个会话启动指令。可以并行开启多个会话。</div>
            </div>
          </div>
          <div id="sessionList" class="session-list"></div>
          <div class="composer-head">
            <div>
              <div class="composer-title">下一条指令</div>
              <div class="composer-summary">选择发送目标后入队；Agent 下一次运行 bridge 时按调度策略消费。</div>
            </div>
          </div>
          <div class="target-row">
            <label>发送到</label>
            <select id="targetMode">
              <option value="direct">当前会话</option>
              <option value="idle-first">空闲优先</option>
              <option value="broadcast">全部在线</option>
              <option value="round-robin">轮询分配</option>
            </select>
          </div>
          <div class="toolbar-row">
            <button class="mini-button" id="pickFiles">引用文件</button>
            <button class="mini-button" id="pickEditor">当前编辑器</button>
            <button class="mini-button" id="pickWorkspace">工作区</button>
          </div>
          <div id="attachments" class="attachment-list"></div>
          <div id="inputShell" class="input-shell">
            <textarea id="instruction" placeholder="输入给 Agent 的指令，Ctrl+Enter 发送。也可以直接粘贴图片。"></textarea>
          </div>
          <div class="composer-footer">
            <div class="hint">保活到期时 Agent 会收到 KEEPALIVE_NOOP，并重新进入 wait。</div>
            <button class="mini-button primary send-button" id="send">发送</button>
          </div>
          <div id="queued-root"></div>
        </div>
      </section>
    </div>

    <div id="moreDialog" class="modal-layer hidden">
      <div class="modal-card advanced-dialog">
        <div class="modal-head"><div class="modal-title">更多操作</div><button class="mini-button" data-close-modal="moreDialog">关闭</button></div>
        <div class="advanced-grid">
          <section class="advanced-section">
            <div class="advanced-title">桥接</div>
            <button class="mini-button" id="installRule">同步项目规则</button>
            <button class="mini-button" id="startWait">启动当前会话等待终端</button>
            <button class="mini-button" id="runDoctor">运行 doctor 自检</button>
            <button class="mini-button" id="renameSession">重命名当前会话</button>
            <button class="mini-button" id="handoffBtn">会话转接</button>
            <button class="mini-button" id="sessionSettingsBtn">当前会话参数</button>
            <button class="mini-button danger" id="deleteCurrentSession">删除当前会话</button>
            <button class="mini-button danger" id="stopLoop">停止当前会话</button>
          </section>
          <section class="advanced-section">
            <div class="advanced-title">队列</div>
            <button class="mini-button" id="showQueueBtn">查看队列</button>
            <button class="mini-button" id="clearSelectedQueue">清空当前会话队列</button>
            <button class="mini-button" id="clearGlobalQueue">清空空闲优先队列</button>
          </section>
          <section class="advanced-section">
            <div class="advanced-title">记录</div>
            <button class="mini-button" id="showEventsBtn">执行记录</button>
            <button class="mini-button" id="showTimelineBtn">结果时间线</button>
          </section>
          <section class="advanced-section">
            <div class="advanced-title">图标注入 / 本机聊天框重试</div>
            <div id="retryNote" class="advanced-note">只作用于本机 Cursor 官方聊天框，不作用于 SSH 服务器。</div>
            <button class="mini-button primary" id="installPatch">注入图标 / 修复</button>
            <button class="mini-button" id="uninstallPatch">卸载注入</button>
          </section>
          <section class="advanced-section">
            <div class="advanced-title">工作区工具</div>
            <div class="advanced-note">让 Agent 可以搜索和读取工作区文件。</div>
            <button class="mini-button" id="workspaceSummaryBtn">生成工作区摘要</button>
            <div class="setting-row" style="flex-direction:row;align-items:center;gap:4px">
              <input id="workspaceSearchInput" type="text" placeholder="搜索内容…" style="flex:1;min-width:80px">
              <button class="mini-button" id="workspaceSearchBtn">搜索</button>
            </div>
          </section>
          <section class="advanced-section">
            <div class="advanced-title">启动模式（顶部按钮已智能处理）</div>
            <div class="advanced-note">顶部「复制启动指令」会自动判断：装了 MCP 就给 MCP 指令，否则给 shell 指令。下面是手动选择（一般不需要）。MCP 调用被 Cursor 原生阻塞等待、不会被模型放到后台，能解决 GPT-5.5 等模型"看到转圈就收工"的问题。</div>
            <button class="mini-button primary" id="installMcpBtn">安装 MCP 配置</button>
            <button class="mini-button" id="copyMcpInstructionBtn">复制 MCP 启动指令</button>
            <button class="mini-button" id="copyShellInstructionBtn">复制 shell 启动指令</button>
          </section>
        </div>
      </div>
    </div>

    <div id="settingsDialog" class="modal-layer hidden">
      <div class="modal-card settings-dialog">
        <div class="modal-head"><div class="modal-title">设置</div><button class="mini-button" data-close-modal="settingsDialog">关闭</button></div>
        <label class="setting-row"><span>最大并发会话数</span><input id="setMaxSessions" type="number" min="1"></label>
        <label class="setting-row"><span>默认调度策略</span><select id="setSchedulingMode"><option value="idle-first">空闲优先</option><option value="direct">当前会话</option><option value="broadcast">全部在线</option><option value="round-robin">轮询分配</option></select></label>
        <label class="setting-row"><span>保活间隔秒数</span><input id="setKeepalive" type="number" min="10"></label>
        <label class="setting-row"><span>会话需关注时弹系统通知</span><input id="setNotifyOnAttention" type="checkbox"></label>
        <div class="meta-hint">其余高级项（队列上限、离线/执行超时判定、轮询间隔、记录/图片上限、运行时、聊天框重试上限等）已采用合理默认值；确需微调可直接编辑 <code>.cursor/local-continue-state/settings.json</code>。</div>
        <div class="modal-actions"><button class="mini-button" data-close-modal="settingsDialog">取消</button><button class="mini-button primary" id="saveSettings">保存</button></div>
      </div>
    </div>

    <div id="eventDialog" class="modal-layer hidden">
      <div class="modal-card history-dialog">
        <div class="modal-head"><div class="modal-title">执行记录</div><button class="mini-button" data-close-modal="eventDialog">关闭</button></div>
        <div id="eventHistoryList" class="event-history-list"></div>
      </div>
    </div>

    <div id="queueDialog" class="modal-layer hidden">
      <div class="modal-card queue-dialog">
        <div class="modal-head"><div class="modal-title">队列</div><button class="mini-button" data-close-modal="queueDialog">关闭</button></div>
        <div id="queueDialogList" class="queued-list modal-queued-list"></div>
      </div>
    </div>

    <div id="timelineDialog" class="modal-layer hidden">
      <div class="modal-card history-dialog">
        <div class="modal-head"><div class="modal-title">结果时间线</div><button class="mini-button" data-close-modal="timelineDialog">关闭</button></div>
        <div id="timelineList" class="event-history-list"></div>
      </div>
    </div>

    <div id="handoffDialog" class="modal-layer hidden">
      <div class="modal-card settings-dialog">
        <div class="modal-head"><div class="modal-title">会话转接</div><button class="mini-button" data-close-modal="handoffDialog">关闭</button></div>
        <div class="meta-hint">把断流 / 上下文已满的会话未完成的工作，交给一个空闲在线会话继续。原会话 ID 已自动捕获并随指令带上，无需手填。</div>
        <label class="setting-row"><span>来源会话</span><select id="handoffSource"></select></label>
        <label class="setting-row"><span>目标会话（空闲在线）</span><select id="handoffTarget"></select></label>
        <label class="setting-row"><span>转接原因</span><input id="handoffReason" type="text" placeholder="如：断流 / 上下文已满（可留空）"></label>
        <label class="setting-row handoff-context-row"><span>续聊上下文（已自动预填，可编辑）</span><textarea id="handoffContext" rows="5" placeholder="要让目标会话继续完成的内容…"></textarea></label>
        <div id="handoffHint" class="meta-hint"></div>
        <div class="modal-actions"><button class="mini-button" data-close-modal="handoffDialog">取消</button><button class="mini-button primary" id="doHandoff">转接到目标会话</button></div>
      </div>
    </div>

    <div id="sessionSettingsDialog" class="modal-layer hidden">
      <div class="modal-card settings-dialog">
        <div class="modal-head"><div class="modal-title">当前会话参数（留空＝用全局默认）</div><button class="mini-button" data-close-modal="sessionSettingsDialog">关闭</button></div>
        <div id="sessionSettingsTarget" class="meta-hint"></div>
        <label class="setting-row"><span>保活间隔秒数</span><input id="sessKeepalive" type="number" min="10" placeholder="全局默认"></label>
        <label class="setting-row"><span>等待超时秒数</span><input id="sessTimeout" type="number" min="0" placeholder="全局默认"></label>
        <label class="setting-row"><span>队列轮询间隔秒数</span><input id="sessPoll" type="number" min="0.1" step="0.1" placeholder="全局默认"></label>
        <div class="modal-actions"><button class="mini-button" id="clearSessionSettings">清除覆盖</button><button class="mini-button primary" id="saveSessionSettings">保存</button></div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

const PATCH_AUTO_DISABLED_KEY = "localContinue.nativePatchAutoDisabled";

function maybeAutoReinstallPatch(context) {
  if (vscode.env.remoteName) return;
  if (!context.globalState.get(RETRY_WANTED_KEY)) return;
  if (context.globalState.get(PATCH_AUTO_DISABLED_KEY)) return;
  let status;
  try {
    status = getRetryPatchStatus({ force: true });
  } catch {
    return;
  }
  if (!status.found || status.installed) return;
  // Try silent install first (no elevation). If the write succeeds without
  // elevation, the patch is back in place and we just inform the user.
  try {
    const result = installRetryPatch(context);
    if (result.changed && !result.elevated) {
      vscode.window.showInformationMessage(
        "续聊助手：自动重试补丁已自动重新安装，完全重启 Cursor 后生效。",
        "重新加载",
        "稍后",
      ).then((choice) => {
        if (choice === "重新加载") vscode.commands.executeCommand("workbench.action.reloadWindow");
      });
      return;
    }
  } catch (error) {
    // Silent install failed (likely needs elevation) — fall through to prompt.
  }
  // If silent install failed or needed elevation, prompt the user.
  vscode.window.showWarningMessage(
    "续聊助手：检测到官方聊天框重试补丁已失效（可能因 Cursor 更新被覆盖），是否重新安装？",
    "立即安装",
    "不再提示",
  ).then((choice) => {
    if (choice === "立即安装") {
      try {
        const result = installRetryPatch(context);
        vscode.window.showInformationMessage(`续聊助手：补丁已重装${result.elevated ? "（已提权）" : ""}，重启 Cursor 生效。`);
      } catch (error) {
        vscode.window.showErrorMessage(`续聊助手：补丁重装失败：${error && error.message ? error.message : error}`);
      }
    } else if (choice === "不再提示") {
      context.globalState.update(PATCH_AUTO_DISABLED_KEY, true);
    }
  });
}

function activate(context) {
  const provider = new PanelProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("localContinue.panel", provider),
    vscode.commands.registerCommand("localContinue.open", () => vscode.commands.executeCommand("workbench.view.extension.local-continue-bottom-panel")),
    vscode.commands.registerCommand("localContinue.installRule", () => vscode.window.showInformationMessage(`项目规则已同步：${installRule(context)}`)),
    vscode.commands.registerCommand("localContinue.copyAgentInstruction", async () => {
      const built = await copyAgentInstruction(context, "agent-1");
      vscode.window.showInformationMessage(`续聊助手启动指令已复制（会话 ${built.id}）。`);
    }),
    vscode.commands.registerCommand("localContinue.startWait", () => startWaitTerminal(context, "agent-1")),
    vscode.commands.registerCommand("localContinue.runDoctor", () => startDoctorTerminal(context)),
    vscode.commands.registerCommand("localContinue.sendInstruction", async () => {
      const value = await vscode.window.showInputBox({ title: "发送续聊指令", ignoreFocusOut: true });
      if (value !== undefined) dispatchPayload(ensureRuntime(context), value, "direct", "agent-1");
    }),
    vscode.commands.registerCommand("localContinue.stop", () => enqueueToSession(ensureRuntime(context), "agent-1", { status: "stop", user_input: "stop" }, "command-stop")),
    vscode.commands.registerCommand("localContinue.installRetryPatch", () => vscode.window.showInformationMessage(installRetryPatch(context).changed ? "重试助手已安装，重启 Cursor 后生效。" : "重试助手已经安装。")),
    vscode.commands.registerCommand("localContinue.uninstallRetryPatch", () => vscode.window.showInformationMessage(uninstallRetryPatch(context).changed ? "重试助手已卸载，重启 Cursor 后生效。" : "重试助手未安装。")),
    vscode.commands.registerCommand("localContinue.workspaceSummary", async () => {
      const ch = vscode.window.createOutputChannel("local-continue-workspace");
      const tools = new WorkspaceTools(ch);
      const summary = await tools.buildWorkspaceSummary();
      vscode.window.showInformationMessage(summary.slice(0, 200));
    })
  );
  maybeAutoReinstallPatch(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
