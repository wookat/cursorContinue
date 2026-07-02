"use strict";

// ---------------------------------------------------------------------------
// cursor-history — read a Cursor chat conversation's full message history from
// Cursor's global state.vscdb (SQLite). Cursor stores every conversation bubble
// under cursorDiskKV with key "bubbleId:<composerId>:<bubbleId>", and conversation
// metadata under "composerData:<composerId>". This module extracts a structured,
// token-bounded summary so session handoff can inject real context instead of
// the 160-char preview the runtime currently captures.
//
// No external dependency: uses Node's built-in node:sqlite (Node 22+ / 24).
// Falls back gracefully (returns null) when sqlite is unavailable or the DB
// doesn't exist, so the plugin never crashes on older Node or non-Cursor setups.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const os = require("os");

const META_CACHE_TTL_MS = 5000;
const SESSION_LOOKUP_CACHE_TTL_MS = 10000;
const metaCache = new Map();
const sessionLookupCache = new Map();

function cursorGlobalDbPath() {
  // Windows: %APPDATA%\Cursor\User\globalStorage\state.vscdb
  // macOS:   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
  // Linux:   ~/.config/Cursor/User/globalStorage/state.vscdb
  const base = process.env.APPDATA
    ? path.join(process.env.APPDATA, "Cursor")
    : (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Cursor")
      : path.join(os.homedir(), ".config", "Cursor"));
  return path.join(base, "User", "globalStorage", "state.vscdb");
}

function openCursorDb() {
  const dbPath = cursorGlobalDbPath();
  if (!fs.existsSync(dbPath)) return null;
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); } catch { return null; }
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

function parseComposerMeta(composerId, raw) {
  let meta = null;
  try { meta = JSON.parse(String(raw || "")); } catch { return null; }
  return {
    composerId,
    name: meta ? String(meta.name || "").trim() : "",
    createdAt: meta ? meta.createdAt : 0,
    lastUpdatedAt: meta ? meta.lastUpdatedAt : 0,
  };
}

function readConversationMetaFromDb(db, composerId) {
  try {
    const row = db.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(`composerData:${composerId}`);
    return row ? parseComposerMeta(composerId, row.value) : null;
  } catch {
    return null;
  }
}

function composerIdFromBubbleKey(key) {
  const match = /^bubbleId:([^:]+):/.exec(String(key || ""));
  return match ? match[1] : "";
}

// Lightweight metadata read used by the panel refresh path. Cached briefly so
// syncing Cursor's official title does not reopen/scan SQLite on every repaint.
function readConversationMeta(composerId) {
  const id = String(composerId || "").trim();
  if (!id) return null;
  const cached = metaCache.get(id);
  const now = Date.now();
  if (cached && now - cached.at < META_CACHE_TTL_MS) return cached.value;

  const db = openCursorDb();
  if (!db) {
    metaCache.set(id, { at: now, value: null });
    return null;
  }
  try {
    const value = readConversationMetaFromDb(db, id);
    metaCache.set(id, { at: now, value });
    return value;
  } catch {
    metaCache.set(id, { at: now, value: null });
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

// MCP mode cannot read CURSOR_CONVERSATION_ID from an agent terminal. As a
// fallback, find the Cursor conversation whose pasted bootstrap prompt contains
// this local session id, then use its official title/history.
function findConversationBySessionId(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  const cached = sessionLookupCache.get(id);
  const now = Date.now();
  if (cached && now - cached.at < SESSION_LOOKUP_CACHE_TTL_MS) return cached.value;

  const db = openCursorDb();
  if (!db) {
    sessionLookupCache.set(id, { at: now, value: null });
    return null;
  }
  try {
    const rows = db.prepare(
      "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE ? LIMIT 80",
    ).all(`%${id}%`);
    let best = null;
    for (const row of rows || []) {
      const composerId = composerIdFromBubbleKey(row.key);
      if (!composerId) continue;
      let bubble = null;
      try { bubble = JSON.parse(String(row.value)); } catch { continue; }
      const text = String((bubble && bubble.text) || "");
      if (!text.includes(id) || !/当前会话\s*ID|session_id|wait_for_instruction|续聊助手/.test(text)) continue;
      const meta = readConversationMetaFromDb(db, composerId) || { composerId, name: "", createdAt: 0, lastUpdatedAt: 0 };
      const score = Number(meta.lastUpdatedAt || bubble.createdAt || meta.createdAt || 0);
      if (!best || score >= best.score) best = { ...meta, score };
    }
    const value = best ? { composerId: best.composerId, name: best.name, createdAt: best.createdAt, lastUpdatedAt: best.lastUpdatedAt } : null;
    sessionLookupCache.set(id, { at: now, value });
    return value;
  } catch {
    sessionLookupCache.set(id, { at: now, value: null });
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

// Read one conversation's full bubble history from Cursor's SQLite DB.
// Returns { composerId, name, createdAt, messages: [{type, text, createdAt, ...}] }
// or null when the DB / conversation can't be found.
function readConversation(composerId) {
  if (!composerId) return null;
  const db = openCursorDb();
  if (!db) return null;

  try {
    // Conversation metadata (title, timestamps).
    let meta = null;
    try {
      const metaRow = db.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(`composerData:${composerId}`);
      if (metaRow) meta = JSON.parse(String(metaRow.value));
    } catch {}

    // All message bubbles for this conversation.
    let bubbleRows = [];
    try {
      bubbleRows = db.prepare("SELECT value FROM cursorDiskKV WHERE key LIKE ?").all(`bubbleId:${composerId}:%`);
    } catch {}

    if (!meta && bubbleRows.length === 0) return null;

    const messages = [];
    for (const row of bubbleRows) {
      try {
        const b = JSON.parse(String(row.value));
        const text = String(b.text || "").trim();
        if (!text) continue; // skip empty bubbles (loading placeholders, etc.)
        messages.push({
          type: b.type === 1 ? "user" : b.type === 2 ? "assistant" : "other",
          text,
          createdAt: b.createdAt || 0,
          hasCodeBlocks: !!(b.codeBlocks && b.codeBlocks.length),
          hasToolResults: !!(b.toolResults && b.toolResults.length),
          hasDiffs: !!(b.assistantSuggestedDiffs && b.assistantSuggestedDiffs.length),
        });
      } catch {}
    }

    messages.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    return {
      composerId,
      name: meta ? (meta.name || "") : "",
      createdAt: meta ? meta.createdAt : 0,
      lastUpdatedAt: meta ? meta.lastUpdatedAt : 0,
      messageCount: messages.length,
      messages,
    };
  } finally {
    try { db.close(); } catch {}
  }
}

// Build a compact, token-bounded handoff brief from a conversation's messages.
// Filters out empty/system bubbles, truncates each message to maxCharsPerMessage,
// and caps the total to maxMessages so the injected context doesn't blow up the
// target session's context window. Returns a formatted string ready to embed
// in the handoff instruction.
function buildHandoffBrief(composerId, opts = {}) {
  const maxMessages = opts.maxMessages || 40;
  const maxCharsPerMessage = opts.maxCharsPerMessage || 800;
  const conv = readConversation(composerId);
  if (!conv || conv.messages.length === 0) return null;

  const lines = [];
  lines.push(`== 原会话完整历史（${conv.messageCount} 条消息，${conv.name || "未命名"}）==`);

  // Take the most recent N messages to stay within bounds.
  const recent = conv.messages.slice(-maxMessages);
  if (conv.messages.length > maxMessages) {
    lines.push(`（仅显示最近 ${maxMessages} 条，完整对话共 ${conv.messages.length} 条）`);
  }
  lines.push("");

  for (const m of recent) {
    const tag = m.type === "user" ? "用户" : m.type === "assistant" ? "AI  " : "其他";
    const extras = [
      m.hasCodeBlocks ? "含代码" : "",
      m.hasToolResults ? "含工具调用" : "",
      m.hasDiffs ? "含diff" : "",
    ].filter(Boolean).join(",");
    const text = m.text.length > maxCharsPerMessage
      ? m.text.slice(0, maxCharsPerMessage) + "…[截断]"
      : m.text;
    lines.push(`[${tag}]${extras ? ` <${extras}>` : ""} ${text}`);
    lines.push("");
  }

  return lines.join("\n");
}

module.exports = {
  cursorGlobalDbPath,
  readConversationMeta,
  findConversationBySessionId,
  readConversation,
  buildHandoffBrief,
};
