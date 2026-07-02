"use strict";

// Single source of truth for the pieces that both the runtime (instruction.js /
// mcp-server.js) and the extension host (extension.js) must agree on: the queue
// item / payload data contract, the default settings, the shared filesystem
// constants, and the small stateless helpers. Before this module those lived in
// two independently maintained copies (one per file) that had already drifted --
// extension.js was missing ENFILE/EMFILE from the transient-fs set and two keys
// from DEFAULT_SETTINGS, and the two normalizePayload/makeQueueItem versions
// disagreed on null-vs-undefined and the item id format. Centralising them here
// makes such drift impossible.
//
// Scope note: the *mechanism* code (each file's readJson/writeJsonAtomic caches,
// directory locks, fs.watch wiring) intentionally stays in its own file, because
// each side layers its own caching on top; those bodies use the primitives below
// and must keep the lock semantics (mkdir + owner token) identical on both sides.

const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

// --- Filesystem constants ----------------------------------------------------
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"]);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".py", ".js", ".ts", ".tsx", ".jsx", ".md", ".html", ".css",
  ".json", ".xml", ".yaml", ".yml", ".toml", ".ini", ".ps1", ".sh", ".bat",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".java", ".go", ".rs", ".php", ".rb",
]);

// Windows holds files open briefly (other waiter, panel reader, AV, indexer),
// making an atomic rename/read fail transiently. Retry with jittered backoff
// instead of crashing -- this is what keeps multi-session stable.
const TRANSIENT_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST", "ENFILE", "EMFILE"]);
const RENAME_RETRY_ATTEMPTS = 24;
const RENAME_RETRY_BASE_DELAY = 15;
const RENAME_RETRY_MAX_DELAY = 300;
const BEST_EFFORT_ATTEMPTS = 6;
const READ_RETRY_ATTEMPTS = 6;
const LOCK_STALE_MS = 15000;
const LOCK_WAIT_SECONDS = 5;

// Presence beacon cadence (shared by the shell beacon and the MCP working-presence
// heartbeat so the panel's staleness math matches whichever transport wrote it).
const BEACON_INTERVAL_MS = 4000;
const BEACON_STALE_MS = 12000;
const BEACON_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;

// The single default-settings table. The runtime ignores the UI-only keys
// (workingTimeoutSeconds / retryMaxRetries) harmlessly; keeping them here means
// the extension and runtime can never disagree on a default again.
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
  notifyOnAttention: true,
  retryMaxRetries: 200,
  // Opt-in outbound webhook: when a session finishes a turn and re-enters the
  // wait loop (reports a result), POST a small JSON to this URL. Empty = off.
  webhookUrl: "",
  webhookEvents: ["done", "need_input", "error"],
};

// --- Time / small utilities --------------------------------------------------
function nowMs() {
  return Date.now();
}

function isoNow() {
  return new Date().toISOString();
}

// Synchronous sleep for retry backoff (no event loop work to do mid-retry).
// Atomics.wait on a private buffer blocks the thread for the full timeout.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Math.round(ms)));
}

function isTransientFsError(error) {
  return Boolean(error) && TRANSIENT_FS_CODES.has(error.code);
}

function retryTransient(action, attempts = RENAME_RETRY_ATTEMPTS, baseDelay = RENAME_RETRY_BASE_DELAY, maxDelay = RENAME_RETRY_MAX_DELAY) {
  let delay = baseDelay;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (!isTransientFsError(error)) throw error;
      lastError = error;
      if (attempt === attempts - 1) break;
      sleepSync(Math.min(delay, maxDelay) * (0.5 + Math.random()));
      delay = Math.min(delay * 1.7, maxDelay);
    }
  }
  if (lastError) throw lastError;
  return undefined;
}

// Read the Cursor conversation identity the agent terminal exposes via env vars
// (set by Cursor for agent-exec terminals). All optional -- absent on a plain
// user terminal, in which case the fields are simply empty.
function captureAgentEnv() {
  return {
    conversation_id: process.env.CURSOR_CONVERSATION_ID || "",
    workspace_label: process.env.CURSOR_WORKSPACE_LABEL || "",
    cursor_agent: process.env.CURSOR_AGENT === "1",
  };
}

function safeSessionId(value) {
  const raw = String(value == null ? "" : value).trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned || "agent-1";
}

// --- Queue item / payload data contract --------------------------------------
// The one canonical payload shape both the panel (producer) and the runtime
// (consumer) use. Accepts a raw string, a flat payload, or a full queue item
// (in which case the nested .payload is unwrapped) and tolerates the legacy
// `message` field on either the item or the payload.
function normalizePayload(input) {
  if (typeof input === "string") {
    return {
      status: "continue",
      user_input: input,
      selected_choice: null,
      file_paths: [],
      image_paths: [],
      folder_paths: [],
      suggested_tools: [],
    };
  }
  const source = input && typeof input === "object" ? input : {};
  const payload = source.payload && typeof source.payload === "object" ? source.payload : source;
  return {
    status: payload.status || "continue",
    user_input: String(payload.user_input || payload.message || source.message || ""),
    selected_choice: payload.selected_choice != null ? payload.selected_choice : null,
    file_paths: (payload.file_paths || []).filter(Boolean).map(String),
    image_paths: (payload.image_paths || []).filter(Boolean).map(String),
    folder_paths: (payload.folder_paths || []).filter(Boolean).map(String),
    suggested_tools: (payload.suggested_tools || []).filter(Boolean).map(String),
  };
}

function normalizeQueue(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.messages)) return data.messages;
  if (data && typeof data === "object" && (data.payload || data.message || data.id)) return [data];
  return [];
}

function makeQueueItem(payloadInput, source, target) {
  const payload = normalizePayload(payloadInput);
  return {
    id: crypto.randomUUID().replace(/-/g, ""),
    payload,
    message: payload.user_input,
    source,
    target,
    created_at: isoNow(),
    created_at_ms: nowMs(),
    pid: process.pid,
  };
}

// Cheap change-detection token for a queue file: a rename-based write flips
// mtime and usually size, so a differing signature means "re-check this file".
function queueSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    // ESRCH -> gone; EPERM -> exists but not ours to signal (still alive).
    return Boolean(error) && error.code === "EPERM";
  }
}

// Event-driven wakeup for a wait loop. Watches the *directories* holding the
// queue files (not the files: atomic-rename writes would orphan a file-bound
// watch) and wakes the loop the instant a relevant queue file changes. fs.watch
// is best-effort -- some platforms deliver no events or a null filename -- so
// callers keep a slower polling safety-net; correctness never depends on an
// event actually arriving.
function createQueueNotifier(targets) {
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
  for (const target of targets) {
    try {
      const watcher = fs.watch(target.dir, { persistent: false }, (eventType, filename) => {
        if (!filename || filename === target.file) fire();
      });
      watcher.on("error", () => { /* best effort; the polling safety-net covers gaps */ });
      watchers.push(watcher);
    } catch {
      /* fs.watch unsupported here (e.g. some network filesystems) -> polling covers it */
    }
  }

  return {
    active: watchers.length > 0,
    wait(maxMs) {
      if (pending) { pending = false; return Promise.resolve(); }
      return new Promise((resolve) => {
        resolver = resolve;
        timer = setTimeout(() => { resolver = null; timer = null; resolve(); }, Math.max(0, maxMs));
      });
    },
    close() {
      for (const watcher of watchers) { try { watcher.close(); } catch { /* ignore */ } }
      watchers.length = 0;
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}

// --- Outbound webhook (opt-in result notifications) --------------------------
// Normalise the configured event filter to a safe list of result statuses.
function webhookEventsList(settings) {
  const raw = settings && settings.webhookEvents;
  if (Array.isArray(raw) && raw.length) {
    const cleaned = raw.map(String).filter((event) => ["done", "need_input", "error"].includes(event));
    if (cleaned.length) return cleaned;
  }
  return ["done", "need_input", "error"];
}

// Best-effort JSON POST to a user-configured webhook. Never throws; always
// resolves to true/false. Kept dependency-free (Node http/https) and time-boxed
// so it can never block or crash the wait loop that triggers it.
function postWebhook(url, body, opts = {}) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(String(url || ""));
    } catch {
      resolve(false);
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      resolve(false);
      return;
    }
    const lib = target.protocol === "https:" ? https : http;
    const payload = Buffer.from(JSON.stringify(body || {}), "utf8");
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": payload.length,
      "User-Agent": "local-continue-assistant",
    };
    if (opts.headers && typeof opts.headers === "object") Object.assign(headers, opts.headers);
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    let req;
    try {
      req = lib.request({
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname || "/"}${target.search || ""}`,
        method: "POST",
        headers,
      }, (res) => {
        res.on("data", () => { /* drain; we only care it was delivered */ });
        res.on("end", () => finish(res.statusCode >= 200 && res.statusCode < 400));
      });
    } catch {
      finish(false);
      return;
    }
    req.on("error", () => finish(false));
    req.setTimeout(Math.max(1000, Number(opts.timeoutMs || 8000)), () => {
      try { req.destroy(); } catch { /* ignore */ }
      finish(false);
    });
    try {
      req.write(payload);
      req.end();
    } catch {
      finish(false);
    }
  });
}

module.exports = {
  // constants
  IMAGE_EXTENSIONS,
  TEXT_EXTENSIONS,
  TRANSIENT_FS_CODES,
  RENAME_RETRY_ATTEMPTS,
  RENAME_RETRY_BASE_DELAY,
  RENAME_RETRY_MAX_DELAY,
  BEST_EFFORT_ATTEMPTS,
  READ_RETRY_ATTEMPTS,
  LOCK_STALE_MS,
  LOCK_WAIT_SECONDS,
  BEACON_INTERVAL_MS,
  BEACON_STALE_MS,
  BEACON_MAX_LIFETIME_MS,
  DEFAULT_SETTINGS,
  // utilities
  nowMs,
  isoNow,
  sleepSync,
  isTransientFsError,
  retryTransient,
  captureAgentEnv,
  safeSessionId,
  // data contract
  normalizePayload,
  normalizeQueue,
  makeQueueItem,
  queueSignature,
  isProcessAlive,
  createQueueNotifier,
  // webhook
  webhookEventsList,
  postWebhook,
};
