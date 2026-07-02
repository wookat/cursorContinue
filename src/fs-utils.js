"use strict";

// ---------------------------------------------------------------------------
// fs-utils — the extension host's low-level IO toolbox: atomic JSON read/write
// with transient-error retry, capped JSONL append/trim, a cross-process
// directory lock (mkdir + owner token), and small text helpers (makeId,
// compactForUi).
//
// Extracted from extension.js as the second most independent block (after
// src/local-channel.js): it depends only on node fs/path and the shared
// data-contract constants in runtime/shared.js — no vscode, no panel state.
// The lock semantics MUST stay identical to runtime/instruction.js (same
// mkdir + owner-token protocol over the same lock dirs).
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const {
  RENAME_RETRY_ATTEMPTS, RENAME_RETRY_BASE_DELAY, RENAME_RETRY_MAX_DELAY,
  nowMs, sleepSync, isTransientFsError,
} = require("../runtime/shared.js");

function makeId(prefix = "msg") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
const JSON_CACHE_MAX = 100;
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
  if (cached && cached.sig === sig) {
    // LRU touch: move to end of insertion order so the oldest entry is evicted.
    _jsonCache.delete(filePath);
    _jsonCache.set(filePath, cached);
    return cached.data;
  }
  const data = readJson(filePath, fallback);
  // Evict the oldest entry (first in insertion order) when the cache is full.
  if (_jsonCache.size >= JSON_CACHE_MAX) {
    const oldest = _jsonCache.keys().next().value;
    if (oldest !== undefined) _jsonCache.delete(oldest);
  }
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
    // Stream-friendly trim: read a tail chunk sized to comfortably hold `limit`
    // lines (capped so we never read more than 8MB just to trim). If the chunk
    // yields enough lines we avoid loading the whole file into memory.
    const tailBudget = Math.min(Math.max(limit * 1024, 65536), 8 * 1024 * 1024);
    let text = readFileTail(filePath, tailBudget);
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
      // after a stale-takeover we must not delete the successor's lock. If the
      // owner file cannot be written we release the lock immediately and retry
      // — proceeding without a verifiable owner would let another process
      // treat the lock as stale and take it over while we are still inside the
      // critical section.
      try {
        fs.writeFileSync(path.join(lockDir, "owner"), token, "utf8");
      } catch {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }
        if (nowMs() - started > timeoutMs) throw new Error("队列正忙，请稍后再试。");
        sleepSync(40);
        continue;
      }
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

// Read only the last `maxBytes` of a file without loading the whole thing into
// memory (the workbench file is 60MB+). Used to detect the appended retry-patch
// block, which lives at EOF.
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

module.exports = {
  makeId,
  compactForUi,
  safeUnlink,
  renameWithRetry,
  readJson,
  readJsonCached,
  writeJsonAtomic,
  appendJsonl,
  trimJsonl,
  withDirectoryLock,
  readFileTail,
};
