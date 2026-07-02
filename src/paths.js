"use strict";

// ---------------------------------------------------------------------------
// paths — workspace path resolution, runtime cache, and command builder.
// Centralises every path computation so the rest of the extension never
// touches vscode.workspace or context.extensionPath directly.
//
// ensureRuntime uses a lazy require for sessions.js to avoid a circular
// dependency at module-load time (sessions.js depends on paths.js).
// ---------------------------------------------------------------------------

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const { safeSessionId } = require("../runtime/shared.js");

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) throw new Error("请先在 Cursor 打开一个项目目录。");
  // Multi-root workspace: prefer the folder that contains the active editor's
  // file so commands target the project the user is actually working in. Falls
  // back to the first folder when there is no active editor or it doesn't live
  // in any workspace folder.
  if (folders.length > 1) {
    const active = vscode.window.activeTextEditor;
    if (active && active.document && active.document.uri) {
      const folder = vscode.workspace.getWorkspaceFolder(active.document.uri);
      if (folder) return folder.uri.fsPath;
    }
  }
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
  // Lazy require to avoid circular dependency: sessions.js depends on paths.js.
  const { ensureDefaultSession } = require("./sessions.js");
  ensureDefaultSession(paths);
  _runtimeCache.set(cacheKey, paths);
  return paths;
}

// Wrap a value in double quotes for shell consumption. Inside double quotes
// the characters that can break out or trigger interpolation are: " $ ` and \.
// We escape them so a value cannot inject extra flags or commands. Note: we
// intentionally do NOT escape backslashes, because Windows paths contain many
// "\" and in cmd.exe / PowerShell double-quoted strings "\" is a literal.
function quoteArg(value) {
  const escaped = String(value)
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
  return `"${escaped}"`;
}

// reliably present on Windows and Linux and avoids the per-spawn antivirus cost
// that made the old Python runtime slow on Windows. (The Python runtime was
// removed in 1.0.1 to end the dual-maintenance burden.)
function resolveRuntime(paths) {
  return { kind: "node", bin: "node", script: paths.instructionJs };
}

function runtimeWaitCommand(paths, settings, sessionId, extra = "") {
  const runtime = resolveRuntime(paths, settings);
  const id = safeSessionId(sessionId || "agent-1");
  // All arguments are quoted — including numeric settings — so that even if a
  // settings value were tampered to contain shell metacharacters it could not
  // break out of its argument slot.
  const base = `${runtime.bin} ${quoteArg(runtime.script)} wait --state-dir ${quoteArg(paths.stateDir)} --session-id ${quoteArg(id)} --keepalive ${quoteArg(settings.keepaliveSeconds)} --timeout ${quoteArg(settings.waitTimeoutSeconds)} --poll ${quoteArg(settings.pollSeconds)}`;
  return extra ? `${base} ${extra}` : base;
}

function runtimeDoctorCommand(paths, settings) {
  const runtime = resolveRuntime(paths, settings);
  return `${runtime.bin} ${quoteArg(runtime.script)} doctor --state-dir ${quoteArg(paths.stateDir)}`;
}

module.exports = {
  getWorkspaceRoot,
  getPaths,
  sessionPaths,
  ensureRuntime,
  quoteArg,
  resolveRuntime,
  runtimeWaitCommand,
  runtimeDoctorCommand,
};
