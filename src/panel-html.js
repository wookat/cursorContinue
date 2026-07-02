"use strict";

// ---------------------------------------------------------------------------
// panel-html — generates the webview HTML for the panel. Extracted from
// PanelProvider.html() so the template can be maintained independently.
// ---------------------------------------------------------------------------

const vscode = require("vscode");
const path = require("path");
const crypto = require("crypto");

function panelHtml(context, webview) {
  // Cryptographically random nonce so the CSP script-src rule cannot be
  // guessed even if an attacker knows when the panel was loaded.
  const nonce = crypto.randomBytes(16).toString("base64");
  const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, "media", "panel.css")));
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, "media", "panel.js")));
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
          <div class="brand-mark"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 7h10M4 12h16M4 17h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="m17 7 3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
          <div class="brand-copy">
            <div class="title-row">
              <div class="title">续聊助手</div>
              <span id="onlinePill" class="status-pill">0/0</span>
              <span id="queuePill" class="meta-chip">待消费 0</span>
            </div>
            <div id="workspace" class="subtitle">等待打开项目</div>
          </div>
        </div>
        <div class="header-actions">
          <button class="mini-button" id="newSession" title="新建会话">＋</button>
          <button class="mini-button" id="installMcpTop" title="把 MCP 服务器写入 .cursor/mcp.json（首次用 MCP 模式需要，装好后完全重启 Cursor）">MCP</button>
          <button class="mini-button primary" id="copyInstruction" title="复制启动指令并发给 Cursor 对话。装了 MCP 就给 MCP 指令，否则给 shell 指令。">复制指令</button>
          <button class="mini-button" id="openWindowTop" title="在独立窗口打开面板">⧉</button>
          <button class="mini-button" id="settingsBtn" title="设置">⚙</button>
          <button class="mini-button" id="moreBtn" title="更多操作">⋯</button>
        </div>
      </section>

      <section class="panel status-strip slim-status">
        <div class="status-row">
          <span id="statusText" class="meta-chip">等待会话连接</span>
          <span id="selectedSessionText" class="meta-chip">当前会话：未选择</span>
          <span class="status-row-spacer"></span>
          <button class="mini-button" id="eventHistoryBtn">记录</button>
        </div>
        <div id="events" class="meta-hint"></div>
      </section>

      <section class="panel chat-panel compact">
        <div class="composer">
          <div class="session-head">
            <div>
              <div class="composer-title">会话列表</div>
              <div class="composer-summary">点击选择会话；右键卡片或点 <b>⋯</b> 打开操作菜单（转接 / 重命名 / 参数 / 删除等）。</div>
            </div>
          </div>
          <div id="sessionList" class="session-list"></div>
          <div class="composer-head">
            <div>
              <div class="composer-title">下一条指令</div>
              <div class="composer-summary">选择目标后入队，Agent 下次运行 bridge 时消费。</div>
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
            <div class="hint">Ctrl+Enter 发送 · 粘贴图片自动上传</div>
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
            <div class="advanced-title">视图 / 窗口</div>
            <div class="advanced-note">在编辑器区打开一个独立的面板实例并自动移入新窗口（拖到第二屏尤其顺手）。底部面板与所有独立窗口共享同一份文件队列状态、实时同步，天然支持多窗口多 Agent 管理。若自动移窗不被支持，会退化为编辑器标签页，右键→「移入新窗口」即可。</div>
            <button class="mini-button primary" id="openWindowBtn">⧉ 在独立窗口打开</button>
          </section>
          <section class="advanced-section">
            <div class="advanced-title">项目 / 桥接</div>
            <div class="advanced-note">会话相关操作（转接 / 重命名 / 参数 / 启动终端 / 停止 / 删除 / 清空该会话队列）已移到每个会话卡片：点卡片右侧 <b>⋯</b> 或 <b>右键卡片</b>。</div>
            <button class="mini-button" id="installRule">同步项目规则</button>
            <button class="mini-button" id="runDoctor">运行 doctor 自检</button>
          </section>
          <section class="advanced-section">
            <div class="advanced-title">队列</div>
            <button class="mini-button" id="showQueueBtn">查看队列</button>
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
        <div class="advanced-title" style="margin-top:6px;">完成通知 · Webhook</div>
        <label class="setting-row"><span>Webhook URL（留空＝关闭）</span><input id="setWebhookUrl" type="text" placeholder="https://… 自建服务 / Slack / 飞书 / 钉钉 机器人地址"></label>
        <label class="setting-row"><span>仅在需要关注(need_input/error)时触发</span><input id="setWebhookOnlyAttention" type="checkbox"></label>
        <div class="setting-row"><span>测试连通性</span><button class="mini-button" id="testWebhookBtn">发送测试消息</button></div>
        <div class="meta-hint">每当某会话完成一轮并进入等待循环（MCP/shell 上报结果）时，向该 URL 发送 JSON：<code>{event, session_id, session_name, status, summary, workspace, at}</code>。任何可接收 POST 的地址均可。</div>
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

    <div id="sessionMenu" class="context-menu hidden" role="menu" aria-label="会话操作"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

module.exports = {
  panelHtml,
};
