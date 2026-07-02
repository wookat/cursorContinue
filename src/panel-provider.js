"use strict";

// ---------------------------------------------------------------------------
// panel-provider — the PanelProvider class that manages webview panels and
// the getBridgeStatus function that aggregates the extension's state.
//
// This is the "controller" layer: it wires together all the lower-level
// modules (sessions, queue, settings, instruction-builder, pickers, etc.)
// and drives the webview UI.
// ---------------------------------------------------------------------------

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const shared = require("../runtime/shared.js");
const { DEFAULT_SETTINGS, normalizePayload, safeSessionId, compactForUi } = shared;
const { ensureRuntime, getPaths } = require("./paths.js");
const { readSettings, saveSettings } = require("./settings.js");
const {
  registerSession, removeSession, setSessionOverrides, renameSession,
  setSessionProject, readSessionsIndex, maybeSetAutoTitle,
} = require("./sessions.js");
const {
  enqueueToSession, clearQueue, removeQueued, moveQueued, readQueue,
} = require("./queue.js");
const {
  getAllSessions, dispatchPayload, handoffSession,
} = require("./session-status.js");
const { readHistory } = require("./history.js");
const { savePastedImage, readImageThumb } = require("./image-utils.js");
const {
  copySmartInstruction, copyAgentInstruction, copyMcpInstruction,
  startWaitTerminal, startDoctorTerminal, installMcpConfig, installRule,
  mcpInstalled,
} = require("./instruction-builder.js");
const { pickFiles, pickFolders, pickProjectFolder, pickActiveEditor } = require("./pickers.js");
const { patchStatusWithNative, installRetryPatch, uninstallRetryPatch } = require("./retry-patch.js");
const { getChannelToken, LocalChannel } = require("./local-channel.js");
const { panelHtml } = require("./panel-html.js");

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
    extensionSettings: settings,
    patch: patchStatusWithNative(context, options.forcePatch),
    remoteName: vscode.env.remoteName || "",
    mcpInstalled: mcpInstalled(paths),
  };
}

class PanelProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.clients = new Set();
    this.timer = undefined;
    this.watcher = undefined;
    this.watchDebounce = undefined;
    this.notifiedResultMs = {};
    this.attentionBaselineSet = false;
    this.channel = undefined;
  }

  ensureChannel() {
    if (this.channel) return;
    try {
      const token = getChannelToken(this.context);
      this.channel = new LocalChannel(
        () => { try { return getPaths(this.context).sessionsDir; } catch { return ""; } },
        token,
        (agentId) => this.onActiveSession(agentId),
      );
      this.channel.start();
    } catch { /* best effort */ }
  }

  onActiveSession(agentId) {
    if (this.clients.size === 0 || !agentId) return;
    this.reply({ type: "selectSession", sessionId: agentId });
  }

  attachWebview(webview, getVisible) {
    webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    webview.html = this.html(webview);
    const client = { webview, getVisible: typeof getVisible === "function" ? getVisible : () => true };
    this.clients.add(client);
    webview.onDidReceiveMessage(async (message) => {
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
    this.ensureChannel();
    this.setupWatcher();
    this.postStatus({ forcePatch: true });
    return client;
  }

  detachClient(client) {
    if (!client) return;
    this.clients.delete(client);
    if (this.clients.size === 0) {
      this.clearTimer();
      this.disposeWatcher();
      if (this.channel) { this.channel.stop(); this.channel = undefined; }
    }
  }

  anyVisible() {
    for (const client of this.clients) {
      try { if (client.getVisible()) return true; } catch { /* treat as hidden */ }
    }
    return false;
  }

  onVisibilityChange() {
    if (this.anyVisible()) {
      this.setupWatcher();
      this.postStatus({ forcePatch: false });
    } else {
      this.clearTimer();
    }
  }

  resolveWebviewView(view) {
    this.view = view;
    const client = this.attachWebview(view.webview, () => view.visible);
    view.onDidDispose(() => { this.view = undefined; this.detachClient(client); });
    view.onDidChangeVisibility(() => this.onVisibilityChange());
  }

  openInWindow(detach = true) {
    const panel = vscode.window.createWebviewPanel(
      "localContinue.panelEditor",
      "续聊助手",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.context.extensionUri] },
    );
    try { panel.iconPath = vscode.Uri.file(path.join(this.context.extensionPath, "media", "icon.svg")); } catch { /* icon optional */ }
    const client = this.attachWebview(panel.webview, () => panel.visible);
    panel.onDidChangeViewState(() => this.onVisibilityChange());
    panel.onDidDispose(() => this.detachClient(client));
    if (detach) {
      setTimeout(() => {
        Promise.resolve(vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow"))
          .then(() => {}, () => this.event("已在编辑器区打开面板；如需独立浮动窗口，右键该标签页→「移入新窗口」。"));
      }, 120);
    }
    return panel;
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  setupWatcher() {
    if (this.watcher) return;
    let stateDir;
    try {
      stateDir = ensureRuntime(this.context).stateDir;
    } catch {
      return;
    }
    try {
      this.watcher = fs.watch(stateDir, { recursive: true }, (eventType, filename) => this.onWatchEvent(filename));
      this.watcher.on("error", () => this.disposeWatcher());
    } catch {
      this.watcher = undefined;
    }
  }

  onWatchEvent(filename) {
    if (filename && /presence\.json$/.test(String(filename))) return;
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = undefined;
      if (this.anyVisible()) this.postStatus({ forcePatch: false });
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
    if (!this.anyVisible()) return;
    const sessions = status.sessions || [];
    const hasOnline = sessions.some((session) => session.connected);
    const hasLive = sessions.some((session) => session.activity === "working" || session.activity === "stalled");
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
    } else if (message.type === "pickProject") {
      const dir = await pickProjectFolder(paths);
      if (dir) {
        const item = setSessionProject(paths, message.sessionId, dir);
        this.postStatus({ forcePatch: false });
        this.event(`已把会话「${item.name || item.id}」限定到项目目录：${compactForUi(dir, 80)}`);
      }
    } else if (message.type === "clearProject") {
      const item = setSessionProject(paths, message.sessionId, "");
      this.postStatus({ forcePatch: false });
      this.event(`已取消会话「${item.name || item.id}」的项目目录限定。`);
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
      if (!payload.user_input.trim() && payload.file_paths.length === 0 && payload.image_paths.length === 0 && (payload.folder_paths || []).length === 0) throw new Error("指令、文件、文件夹和图片不能同时为空。");
      const items = dispatchPayload(paths, payload, message.targetMode, message.sessionId);
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
    } else if (message.type === "pickFolders") {
      this.reply({ type: "filesPicked", paths: await pickFolders(), kind: "folder" });
    } else if (message.type === "pickActiveEditor") {
      this.reply({ type: "filesPicked", paths: [pickActiveEditor()] });
    } else if (message.type === "pickWorkspaceFolder") {
      this.reply({ type: "filesPicked", paths: [paths.workspaceRoot], kind: "folder" });
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
    } else if (message.type === "testWebhook") {
      const url = String(message.url || "").trim();
      if (!url) {
        this.event("请先填写 Webhook URL 再测试。");
        return true;
      }
      const body = {
        event: "test",
        session_id: "test",
        session_name: "Webhook 测试",
        status: "done",
        summary: "这是一条来自续聊助手的 Webhook 测试消息。",
        transport: "panel",
        at: new Date().toISOString(),
      };
      const ok = await shared.postWebhook(url, body, { timeoutMs: 8000 });
      this.event(ok
        ? `Webhook 测试成功：${compactForUi(url, 80)} 已返回 2xx/3xx。`
        : `Webhook 测试失败：无法送达 ${compactForUi(url, 80)}（请检查 URL、网络或服务是否可达）。`);
      return true;
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
    } else if (message.type === "openWindow") {
      this.openInWindow(true);
      return true;
    }
    return false;
  }

  postStatus(options = {}) {
    if (this.clients.size === 0) return;
    const status = getBridgeStatus(this.context, options);
    this.reply({ type: "status", status });
    this.notifyAttention(status);
    this.scheduleNext(status);
  }

  notifyAttention(status) {
    if (!status) return;
    const sessions = status.sessions || [];
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
    for (const client of this.clients) {
      try { client.webview.postMessage(message); } catch { /* webview already gone */ }
    }
  }

  event(text) {
    this.reply({ type: "event", text: compactForUi(text), at: new Date().toLocaleTimeString() });
  }

  html(webview) {
    return panelHtml(this.context, webview);
  }
}

module.exports = {
  PanelProvider,
  getBridgeStatus,
};
