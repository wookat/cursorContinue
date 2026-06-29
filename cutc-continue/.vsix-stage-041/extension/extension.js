const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const CONNECTED_WINDOW_MS = 5000;
const PATCH_START = "/* CUTC_CONTINUE_RETRY_PATCH_START */";
const PATCH_END = "/* CUTC_CONTINUE_RETRY_PATCH_END */";

function nowMs() {
  return Date.now();
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function normalizeQueue(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.messages)) return data.messages;
  return [];
}

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("请先打开一个项目目录。");
  }
  return folders[0].uri.fsPath;
}

function getPaths(context) {
  const workspaceRoot = getWorkspaceRoot();
  const runtimeDir = path.join(context.extensionPath, "runtime");
  const stateDir = path.join(workspaceRoot, ".cursor", "cutc-state");
  return {
    workspaceRoot,
    runtimeDir,
    instruction: path.join(runtimeDir, "instruction.py"),
    template: path.join(runtimeDir, "cutc_rules_template.mdc"),
    stateDir,
    queue: path.join(stateDir, "queue.json"),
    status: path.join(stateDir, "status.json"),
    rule: path.join(workspaceRoot, ".cursor", "rules", "cutc_rules.mdc"),
    retryHelper: path.join(context.extensionPath, "media", "official-retry-helper.js"),
  };
}

function ensureRuntime(context) {
  const paths = getPaths(context);
  if (!fs.existsSync(paths.instruction)) {
    throw new Error(`找不到 instruction.py：${paths.instruction}`);
  }
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return paths;
}

function pythonCommand() {
  return "py";
}

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function installRule(context) {
  const paths = ensureRuntime(context);
  const template = fs.readFileSync(paths.template, "utf8");
  const content = template
    .replaceAll("{{PYTHON_COMMAND}}", pythonCommand())
    .replaceAll("{{INSTRUCTION_PATH}}", paths.instruction)
    .replaceAll("{{STATE_DIR}}", paths.stateDir);
  fs.mkdirSync(path.dirname(paths.rule), { recursive: true });
  fs.writeFileSync(paths.rule, content, "utf8");
  return paths.rule;
}

function startWaitTerminal(context) {
  const paths = ensureRuntime(context);
  const terminal = vscode.window.createTerminal({
    name: "CUTC 等待连接",
    cwd: paths.workspaceRoot,
  });
  terminal.show(true);
  terminal.sendText(`${pythonCommand()} ${quoteArg(paths.instruction)} --state-dir ${quoteArg(paths.stateDir)}`);
}

function enqueueInstruction(context, message, source = "cursor-extension") {
  const paths = ensureRuntime(context);
  const queue = normalizeQueue(readJson(paths.queue, []));
  const item = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    message,
    source,
    created_at: new Date().toISOString(),
    created_at_ms: nowMs(),
  };
  queue.push(item);
  writeJsonAtomic(paths.queue, queue);
  return item;
}

function clearQueue(context) {
  const paths = ensureRuntime(context);
  writeJsonAtomic(paths.queue, []);
}

function removeQueued(context, id) {
  const paths = ensureRuntime(context);
  const queue = normalizeQueue(readJson(paths.queue, []));
  const next = queue.filter((item) => item && item.id !== id);
  writeJsonAtomic(paths.queue, next);
  return queue.length - next.length;
}

function getBridgeStatus(context) {
  let paths;
  try {
    paths = getPaths(context);
  } catch (error) {
    return {
      connected: false,
      state: "未打开项目",
      queueLength: 0,
      detail: error.message,
    };
  }

  const status = readJson(paths.status, {});
  const queue = normalizeQueue(readJson(paths.queue, []));
  const heartbeatMs = Number(status.heartbeat_ms || 0);
  const heartbeatAgeMs = heartbeatMs ? nowMs() - heartbeatMs : Infinity;
  const connected = status.state === "waiting" && heartbeatAgeMs <= CONNECTED_WINDOW_MS;
  const patch = getRetryPatchStatus();
  return {
    workspaceRoot: paths.workspaceRoot,
    stateDir: paths.stateDir,
    connected,
    heartbeatAgeMs,
    state: status.state || "未启动",
    sessionId: status.session_id || "",
    queueLength: queue.length,
    queuedResponses: queue.map((item) => ({
      id: item.id || "",
      payload: {
        status: "continue",
        user_input: String(item.message || ""),
        selected_choice: undefined,
        file_paths: [],
        image_paths: [],
        suggested_tools: [],
      },
      created_at: item.created_at || "",
      source: item.source || "",
    })),
    lastAckId: status.last_ack_id || "",
    lastAckAt: status.last_ack_at || "",
    lastMessagePreview: status.last_message_preview || "",
    patch,
  };
}

function findCursorAppRoot() {
  const candidates = [];
  if (process.execPath) {
    candidates.push(path.join(path.dirname(process.execPath), "resources", "app"));
  }
  candidates.push("D:\\Program Files\\cursor\\resources\\app");
  candidates.push("C:\\Users\\yotal\\AppData\\Local\\Programs\\cursor\\resources\\app");
  candidates.push(path.join(process.env.LOCALAPPDATA || "", "Programs", "cursor", "resources", "app"));
  return candidates.find((candidate) => candidate && fs.existsSync(path.join(candidate, "out", "vs", "workbench", "workbench.desktop.main.js"))) || null;
}

function workbenchPath() {
  const appRoot = findCursorAppRoot();
  return appRoot ? path.join(appRoot, "out", "vs", "workbench", "workbench.desktop.main.js") : null;
}

function getRetryPatchStatus() {
  const target = workbenchPath();
  if (!target) return { found: false, installed: false, target: "" };
  try {
    const content = fs.readFileSync(target, "utf8");
    return {
      found: true,
      installed: content.includes(PATCH_START),
      target,
    };
  } catch (error) {
    return { found: true, installed: false, target, error: error.message };
  }
}

function patchBlock(context) {
  const helper = fs.readFileSync(getPaths(context).retryHelper, "utf8");
  return `\n;${PATCH_START}\n${helper}\n${PATCH_END}\n`;
}

function installRetryPatch(context) {
  const target = workbenchPath();
  if (!target) throw new Error("没有找到 Cursor workbench.desktop.main.js。");
  const content = fs.readFileSync(target, "utf8");
  const backup = `${target}.cutc-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(target, backup);
  if (content.includes(PATCH_START)) {
    const start = content.indexOf(`;${PATCH_START}`);
    const end = content.indexOf(PATCH_END, start);
    if (start < 0 || end < 0) throw new Error("补丁标记不完整，已停止更新。");
    const next = content.slice(0, start) + patchBlock(context) + content.slice(end + PATCH_END.length);
    fs.writeFileSync(target, next, "utf8");
    return { target, backup, changed: true, updated: true };
  }
  fs.writeFileSync(target, content + patchBlock(context), "utf8");
  return { target, backup, changed: true };
}

function uninstallRetryPatch() {
  const target = workbenchPath();
  if (!target) throw new Error("没有找到 Cursor workbench.desktop.main.js。");
  const content = fs.readFileSync(target, "utf8");
  if (!content.includes(PATCH_START)) return { target, changed: false };
  const start = content.indexOf(`;${PATCH_START}`);
  const end = content.indexOf(PATCH_END, start);
  if (start < 0 || end < 0) throw new Error("补丁标记不完整，已停止卸载。");
  const next = content.slice(0, start) + content.slice(end + PATCH_END.length);
  fs.writeFileSync(target, next, "utf8");
  return { target, changed: true };
}

async function promptAndSend(context) {
  const value = await vscode.window.showInputBox({
    title: "发送 CUTC 指令",
    prompt: "发送给正在等待的 Cursor Agent",
    placeHolder: "继续检查代码...",
    ignoreFocusOut: true,
  });
  if (value === undefined) return;
  const item = enqueueInstruction(context, value);
  vscode.window.showInformationMessage(`CUTC 已入队：${item.id}`);
}

class PanelProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.timer = undefined;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = this.html();
    view.onDidDispose(() => {
      if (this.timer) clearInterval(this.timer);
    });
    this.timer = setInterval(() => this.postStatus(), 1000);
    this.postStatus();

    view.webview.onDidReceiveMessage(async (message) => {
      try {
        if (message.type === "installRule") {
          const rule = installRule(this.context);
          this.event(`已安装项目规则：${rule}`);
        }
        if (message.type === "startWait") {
          startWaitTerminal(this.context);
          this.event("已启动等待终端。连接成功后状态会变为“已连接”。");
        }
        if (message.type === "send") {
          if (!message.text || !message.text.trim()) throw new Error("指令不能为空。");
          const item = enqueueInstruction(this.context, message.text);
          this.event(`已发送并入队：${item.id}`);
        }
        if (message.type === "stop") {
          const item = enqueueInstruction(this.context, "stop", "cursor-extension-stop");
          this.event(`已发送停止指令：${item.id}`);
        }
        if (message.type === "clearQueue") {
          clearQueue(this.context);
          this.event("已清空等待队列。");
        }
        if (message.type === "removeQueued") {
          const removed = removeQueued(this.context, String(message.id || ""));
          this.event(removed > 0 ? "已移除排队消息。" : "没有找到要移除的排队消息。");
        }
        if (message.type === "installRetryPatch") {
          const result = installRetryPatch(this.context);
          this.event(result.changed ? `已安装重试助手，需要重启 Cursor：${result.target}` : "重试助手已经安装。");
        }
        if (message.type === "uninstallRetryPatch") {
          const result = uninstallRetryPatch();
          this.event(result.changed ? `已卸载重试助手，需要重启 Cursor：${result.target}` : "重试助手未安装。");
        }
        this.postStatus();
      } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        this.event(`错误：${detail}`);
        vscode.window.showErrorMessage(`CUTC：${detail}`);
      }
    });
  }

  postStatus() {
    if (!this.view) return;
    this.view.webview.postMessage({ type: "status", status: getBridgeStatus(this.context) });
  }

  event(text) {
    if (!this.view) return;
    this.view.webview.postMessage({ type: "event", text, at: new Date().toLocaleTimeString() });
  }

  html() {
    const nonce = String(Date.now());
    const cssUri = this.view.webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", "panel.css")));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div id="app">
  <div class="shell">
    <section class="panel topbar">
      <div class="brand">
        <div class="brand-mark">CC</div>
        <div class="brand-copy">
          <div class="title-row">
            <div class="title">持续对话助手</div>
            <span id="connected" class="status-pill">未连接</span>
            <span id="patchState" class="meta-chip">重试助手：未知</span>
          </div>
          <div id="workspace" class="subtitle">等待打开项目</div>
        </div>
      </div>
      <div class="header-actions">
        <button class="mini-button" id="install">同步配置</button>
        <button class="mini-button primary" id="start">启动等待</button>
        <button class="mini-button" id="installPatch">安装补丁</button>
        <button class="mini-button danger" id="uninstallPatch">卸载补丁</button>
      </div>
    </section>

    <section class="panel status-strip">
      <div class="status-row">
        <span id="agentState" class="meta-chip">服务未启动</span>
        <span id="queueLength" class="meta-chip">已排队 0</span>
        <span id="lastAck" class="meta-chip">最近确认：无</span>
        <span class="status-row-spacer"></span>
        <div class="status-inline-actions">
          <button class="mini-button" id="clear">清空队列</button>
          <button class="mini-button danger" id="stop">结束循环</button>
        </div>
      </div>
      <div id="events" class="meta-hint">连接判断：Agent 正在运行 instruction.py 且 heartbeat 在 5 秒内更新。</div>
    </section>

    <section class="panel chat-panel compact">
      <div class="composer">
        <div class="composer-head">
          <div>
            <div id="composer-title" class="composer-title">等待输入</div>
            <div id="composer-summary" class="composer-summary">输入下一条指令，Ctrl+Enter 发送。未连接时会先排队。</div>
          </div>
        </div>
        <div class="input-shell">
          <textarea id="instruction" placeholder="输入下一条给 Agent 的指令，或输入文件/图片的绝对路径..."></textarea>
        </div>
        <div class="composer-footer">
          <div id="composer-hint" class="hint">发送后，Agent 下次运行 bridge 时会按队列顺序消费。</div>
          <div class="status-inline-actions">
            <button class="mini-button" id="enqueue">排队</button>
            <button class="mini-button primary" id="send">发送 / 继续</button>
          </div>
        </div>
        <div id="queued-root"></div>
      </div>
    </section>
  </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const textarea = document.getElementById("instruction");
    const events = document.getElementById("events");
    const queuedRoot = document.getElementById("queued-root");
    const send = (type, extra = {}) => vscode.postMessage({ type, ...extra });
    const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    function renderQueue(entries) {
      if (!entries || entries.length === 0) {
        queuedRoot.innerHTML = "";
        return;
      }
      queuedRoot.innerHTML = '<section class="queued-section"><div class="queued-section-head"><div class="queued-section-title">排队消息</div><div class="queued-section-meta">共 ' + entries.length + ' 条</div></div><div class="queued-list">' +
        entries.map((entry) => {
          const payload = entry.payload || {};
          const preview = payload.user_input || "空白队列消息";
          return '<div class="queued-item"><div class="queued-copy"><div class="queued-text">' + escapeHtml(preview) + '</div><div class="queued-meta-row"><span class="queued-tag">' + escapeHtml(entry.source || "panel") + '</span></div></div><button class="mini-button queued-remove" data-remove-queued="' + escapeHtml(entry.id) + '">移除</button></div>';
        }).join("") + '</div></section>';
    }
    document.getElementById("send").addEventListener("click", () => { send("send", { text: textarea.value }); textarea.value = ""; });
    document.getElementById("enqueue").addEventListener("click", () => { send("send", { text: textarea.value }); textarea.value = ""; });
    document.getElementById("start").addEventListener("click", () => send("startWait"));
    document.getElementById("install").addEventListener("click", () => send("installRule"));
    document.getElementById("stop").addEventListener("click", () => send("stop"));
    document.getElementById("clear").addEventListener("click", () => send("clearQueue"));
    document.getElementById("installPatch").addEventListener("click", () => send("installRetryPatch"));
    document.getElementById("uninstallPatch").addEventListener("click", () => send("uninstallRetryPatch"));
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        send("send", { text: textarea.value });
        textarea.value = "";
      }
    });
    queuedRoot.addEventListener("click", (event) => {
      const target = event.target && event.target.closest ? event.target.closest("[data-remove-queued]") : null;
      if (target) send("removeQueued", { id: target.dataset.removeQueued || "" });
    });
    window.addEventListener("message", event => {
      if (event.data.type === "status") {
        const s = event.data.status;
        const connected = document.getElementById("connected");
        connected.textContent = s.connected ? "已连接" : (s.state === "未打开项目" ? "未打开项目" : "等待连接");
        connected.className = "status-pill " + (s.connected ? "running" : "");
        document.getElementById("workspace").textContent = s.workspaceRoot || s.detail || "等待打开项目";
        document.getElementById("agentState").textContent = "状态：" + (s.state || "未启动");
        document.getElementById("queueLength").textContent = "已排队 " + String(s.queueLength || 0);
        document.getElementById("lastAck").textContent = s.lastAckId ? ("最近确认：" + s.lastAckId.slice(0, 8)) : "最近确认：无";
        const patch = document.getElementById("patchState");
        if (!s.patch || !s.patch.found) {
          patch.textContent = "重试助手：未找到 Cursor";
          patch.className = "meta-chip";
        } else {
          patch.textContent = s.patch.installed ? "重试助手：已安装" : "重试助手：未安装";
          patch.className = s.patch.installed ? "meta-chip meta-chip-ready" : "meta-chip";
        }
        renderQueue(s.queuedResponses || []);
      }
      if (event.data.type === "event") {
        events.textContent = "[" + event.data.at + "] " + event.data.text + "\\n" + events.textContent;
      }
    });
  </script>
</body>
</html>`;
  }
}

function activate(context) {
  const provider = new PanelProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cutcContinue.panel", provider),
    vscode.commands.registerCommand("cutcContinue.open", () => vscode.commands.executeCommand("workbench.view.extension.cutc-continue-bottom-panel")),
    vscode.commands.registerCommand("cutcContinue.installRule", () => {
      const rule = installRule(context);
      vscode.window.showInformationMessage(`CUTC 项目规则已安装：${rule}`);
    }),
    vscode.commands.registerCommand("cutcContinue.startWait", () => startWaitTerminal(context)),
    vscode.commands.registerCommand("cutcContinue.sendInstruction", () => promptAndSend(context)),
    vscode.commands.registerCommand("cutcContinue.stop", () => {
      const item = enqueueInstruction(context, "stop", "cursor-extension-stop");
      vscode.window.showInformationMessage(`CUTC 已发送停止：${item.id}`);
    }),
    vscode.commands.registerCommand("cutcContinue.installRetryPatch", () => {
      const result = installRetryPatch(context);
      vscode.window.showInformationMessage(result.changed ? "CUTC 重试助手已安装，重启 Cursor 后生效。" : "CUTC 重试助手已经安装。");
    }),
    vscode.commands.registerCommand("cutcContinue.uninstallRetryPatch", () => {
      const result = uninstallRetryPatch();
      vscode.window.showInformationMessage(result.changed ? "CUTC 重试助手已卸载，重启 Cursor 后生效。" : "CUTC 重试助手未安装。");
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
