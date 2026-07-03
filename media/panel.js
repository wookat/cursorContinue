(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const state = {
    draft: { file_paths: [], image_paths: [], folder_paths: [] },
    settings: {},
    sessions: [],
    selectedSessionId: "",
    globalQueue: [],
    events: [],
    persistedEvents: [],
    sessionDetail: null,
    thumbs: {},
    thumbReq: {},
    lastSchedulingMode: undefined,
    targetTouched: false,
    lastRenderSig: "",
  };
  const INLINE_QUEUE_PREVIEW_LIMIT = 6;

  const $ = (id) => document.getElementById(id);
  const send = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const setTextIfChanged = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  const setClassIfChanged = (el, cls) => { if (el.className !== cls) el.className = cls; };
  const _RE_ESCAPE = /[&<>"']/g;
  const _ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escapeHtml = (value) => String(value || "").replace(_RE_ESCAPE, (ch) => _ESCAPE_MAP[ch]);

  const _RE_IMAGE_CTX = /IMAGE_CONTEXT_START:[\s\S]*?:IMAGE_CONTEXT_END/g;
  const _RE_LONG_B64 = /[A-Za-z0-9+/=]{240,}/g;
  const _RE_WS = /\s+/g;
  function compactText(value, limit = 220) {
    const text = String(value || "")
      .replace(_RE_IMAGE_CTX, "[图片数据已折叠]")
      .replace(_RE_LONG_B64, "[长二进制数据已折叠]")
      .replace(_RE_WS, " ")
      .trim();
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  }

  const IMAGE_MAX_DIMENSION_DEFAULT = 2000;

  function pickImageOutputType(sourceType) {
    return ["image/png", "image/jpeg", "image/webp"].includes(sourceType) ? sourceType : "image/png";
  }

  // Downscale very large pasted images in the webview before sending them to the
  // extension host. Keeps disk usage and the agent's image read fast. Always
  // falls back to the original data URL on any error, and only uses the scaled
  // version when it is actually smaller (so a photo never inflates into a huge PNG).
  function processPastedImageFile(file, callback) {
    const reader = new FileReader();
    reader.onerror = () => {};
    reader.onload = () => {
      const original = String(reader.result || "");
      if (!original) return;
      const maxDim = Number(state.settings.imageMaxDimension ?? IMAGE_MAX_DIMENSION_DEFAULT) || 0;
      if (maxDim <= 0) {
        callback(original);
        return;
      }
      const img = new Image();
      img.onerror = () => callback(original);
      img.onload = () => {
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        const longSide = Math.max(width, height);
        if (!longSide || longSide <= maxDim) {
          callback(original);
          return;
        }
        try {
          const scale = maxDim / longSide;
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const outType = pickImageOutputType(file.type || "image/png");
          const scaled = canvas.toDataURL(outType, outType === "image/png" ? undefined : 0.92);
          callback(scaled && scaled.length > 32 && scaled.length < original.length ? scaled : original);
        } catch (error) {
          callback(original);
        }
      };
      img.src = original;
    };
    reader.readAsDataURL(file);
  }

  function openModal(id) {
    $(id).classList.remove("hidden");
  }

  function closeModal(id) {
    $(id).classList.add("hidden");
  }

  function selectedSession() {
    return state.sessions.find((session) => session.id === state.selectedSessionId) || state.sessions[0] || null;
  }

  function transportLabel(session) {
    return session && session.transport ? String(session.transport).toUpperCase() : "未连接";
  }

  function sessionSeq(session, index) {
    if (session && Number.isFinite(Number(session.displaySeq))) return Number(session.displaySeq);
    const match = /^agent-(\d+)/.exec(String((session && session.id) || ""));
    return match ? Number(match[1]) : index + 1;
  }

  function setSelectedSessionLabel() {
    const selected = selectedSession();
    if (!selected) {
      setTextIfChanged($("selectedSessionText"), "当前会话：未选择");
      return;
    }
    const index = state.sessions.findIndex((session) => session.id === selected.id);
    setTextIfChanged($("selectedSessionText"), `当前会话 ${sessionSeq(selected, index)}：${selected.name}`);
  }

  function formatDuration(ms) {
    const s = Math.max(0, Math.round(Number(ms || 0) / 1000));
    if (s < 60) return `${s}秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}分${s % 60 ? `${s % 60}秒` : ""}`;
    const h = Math.floor(m / 60);
    return `${h}小时${m % 60 ? `${m % 60}分` : ""}`;
  }

  function sessionStateLabel(session) {
    // activity is derived live by the extension from status + elapsed time, so it
    // reflects "working"/"stalled" even while the waiter process is not running.
    if (session.activity === "working") return `执行中 · 已 ${formatDuration(session.workingAgeMs)}`;
    if (session.activity === "stalled") {
      return session.interruptReason === "terminal"
        ? "已中断 · 终端/对话已关闭"
        : `可能中断 · ${formatDuration(session.workingAgeMs)} 未返回 wait`;
    }
    if (session.activity === "queued" || (session.connected && session.queueLength > 0)) return "已连接，待消费";
    if (session.activity === "idle" || session.connected) {
      if (session.keepaliveDeadlineMs) {
        const remain = Math.round((session.keepaliveDeadlineMs - Date.now()) / 1000);
        if (remain > 0) return `已连接，空闲 · 保活 ${remain}s`;
      }
      return "已连接，空闲";
    }
    if (session.state === "received") return "上一条已消费";
    if (session.state === "keepalive") return "保活返回";
    if (session.state === "busy") return "已有等待进程";
    if (session.state === "timeout") return "已超时";
    if (session.state === "new") return "未启动";
    return "离线";
  }

  function sessionDotClass(session) {
    if (session.activity === "working") return "session-dot working";
    if (session.activity === "stalled") return "session-dot stalled";
    if (session.connected) return "session-dot online";
    if (session.state === "received" || session.state === "keepalive") return "session-dot pending";
    return "session-dot offline";
  }

  function patchLabel(patch) {
    if (!patch) return "图标注入：未知";
    if (patch.remote) return "图标注入：仅本机";
    if (!patch.found) return "图标注入：未找到 Cursor";
    if (!patch.installed) return "图标注入：未安装";
    if (patch.native) {
      const mark = (ok) => (ok ? "✓" : "✗");
      return `图标注入：已写入 P1${mark(patch.native.p1)}/P2${mark(patch.native.p2)}/P3${mark(patch.native.p3)}`;
    }
    return "图标注入：已写入";
  }

  function renderStatus(status) {
    state.settings = status.extensionSettings || state.settings || {};
    state.sessions = status.sessions || [];
    state.globalQueue = status.globalQueuedResponses || [];
    if (!state.selectedSessionId || !state.sessions.some((session) => session.id === state.selectedSessionId)) {
      state.selectedSessionId = state.sessions[0]?.id || "";
    }

    const onlineText = `${status.onlineCount || 0}/${status.maxConcurrentSessions || state.sessions.length || 0}`;
    const onlineClass = `status-pill ${(status.onlineCount || 0) > 0 ? "running" : ""}`;
    const mcpPill = $("mcpPill");
    if (mcpPill) {
      const mcpActive = Number(status.mcpActiveCount || 0);
      const shellActive = Number(status.shellActiveCount || 0);
      const mcpText = status.mcpStale
        ? "MCP stale"
        : status.mcpInstalled
        ? (mcpActive > 0 ? `MCP ${mcpActive}` : "MCP ready")
        : "MCP off";
      const mcpClass = status.mcpStale
        ? "meta-chip meta-chip-stale"
        : status.mcpInstalled
        ? `meta-chip ${mcpActive > 0 ? "meta-chip-ready" : "meta-chip-waiting"}`
        : "meta-chip meta-chip-off";
      setTextIfChanged(mcpPill, shellActive > 0 ? `${mcpText} / shell ${shellActive}` : mcpText);
      setClassIfChanged(mcpPill, mcpClass);
      mcpPill.title = status.mcpStale
        ? `MCP config is stale. Current: ${status.mcpStatus?.server || ""} Expected: ${status.mcpStatus?.expectedServer || ""}`
        : status.mcpInstalled
        ? `MCP config: ${status.mcpConfig || ""}`
        : "MCP config is not installed for this workspace.";
    }
    setTextIfChanged($("onlinePill"), onlineText);
    setClassIfChanged($("onlinePill"), onlineClass);
    const pending = status.globalQueueLength || 0;
    const assigned = Math.max(0, (status.totalQueueLength || 0) - pending);
    setTextIfChanged($("queuePill"), `待分配 ${pending} / 待消费 ${assigned}`);
    const syncPill = $("syncPill");
    if (syncPill) {
      const syncAt = status.syncedAt || new Date().toLocaleTimeString();
      setTextIfChanged(syncPill, `同步于 ${syncAt}`);
      syncPill.title = `状态来源：${status.stateDir || ""}`;
    }
    setTextIfChanged($("workspace"), status.workspaceRoot || status.detail || "等待打开项目");
    setTextIfChanged($("statusText"), status.statusText || "暂无在线会话，请复制启动指令到 Cursor 对话。");
    const patch = status.patch || {};
    const retryNoteText = patch.remote
      ? "Remote SSH 下此功能不作用于服务器，请在本机 Cursor 窗口安装。"
      : patch.installed
        ? "已写入：付费墙/402/限流 自动重试并自动隐藏错误（native 断路器 5000次/波 + DOM 自动隐藏 + 定期GC回收防OOM）。若没看到图标，请完全退出并重启 Cursor（不是重载窗口）。"
        : "点「注入图标 / 修复」写入本机 Cursor 官方聊天框；装好后需完全重启 Cursor。不作用于 SSH 服务器。";
    setTextIfChanged($("retryNote"), retryNoteText);

    const selected = selectedSession();
    setSelectedSessionLabel();
    const detail = selected
      ? `${transportLabel(selected)} · ${sessionStateLabel(selected)} · 队列 ${selected.queueLength || 0}${selected.lastResult ? ` · 最近：${compactText(selected.lastResult, 90)}` : ""}`
      : "先新建会话；没有在线 MCP 时，也可以先把任务发送到待分配队列。";
    const detailEl = $("currentSessionDetail");
    if (detailEl) setTextIfChanged(detailEl, detail);
    // Only sync the composer target from the default scheduling mode when that
    // default actually changes, so an auto-refresh never clobbers a manual pick.
    if (!state.targetTouched || state.lastSchedulingMode !== state.settings.schedulingMode) {
      const configured = state.settings.schedulingMode || "direct";
      $("targetMode").value = (status.onlineCount || 0) > 0 ? configured : "idle-first";
      state.lastSchedulingMode = state.settings.schedulingMode;
    }

    // Skip the (relatively expensive) full session/queue innerHTML rebuild when
    // nothing structural changed. The per-second heartbeat age is intentionally
    // excluded from the signature so an idle panel doesn't churn the DOM.
    const sig = renderSignature();
    if (sig !== state.lastRenderSig) {
      state.lastRenderSig = sig;
      renderSessions();
      renderQueue();
    }
    // Don't reset the settings inputs out from under the user while the dialog is open.
    if ($("settingsDialog").classList.contains("hidden")) {
      syncSettingsInputs();
    }
  }

  function renderSignature() {
    const sessions = state.sessions.map((s) => [
      s.id,
      s.name,
      s.state,
      s.connected ? 1 : 0,
      s.queueLength || 0,
      s.displaySeq || "",
      s.lastResultStatus || "",
      s.lastResultAtMs || 0,
      s.connected && s.keepaliveDeadlineMs ? Math.floor(s.keepaliveDeadlineMs / 1000) : 0,
      s.transport || "",
      s.overrides ? `${s.overrides.keepaliveSeconds || ""}|${s.overrides.waitTimeoutSeconds || ""}|${s.overrides.pollSeconds || ""}` : "",
      s.conversationShort || "",
      s.activity || "",
      s.interruptReason || "",
      (s.activity === "working" || s.activity === "stalled") ? Math.floor((s.workingAgeMs || 0) / 3000) : 0,
      (s.queuedResponses || []).map((e) => e.id).join(","),
    ].join("\u0001")).join("\u0002");
    const global = (state.globalQueue || []).map((e) => e.id).join(",");
    return [state.selectedSessionId, global, sessions].join("\u0003");
  }

  function attentionClass(session) {
    if (session.lastResultStatus === "error") return " attention attention-error";
    if (session.lastResultStatus === "need_input") return " attention attention-need";
    return "";
  }

  function formatAge(ms) {
    if (!ms) return "";
    const diff = Math.max(0, Date.now() - Number(ms));
    const seconds = Math.round(diff / 1000);
    if (seconds < 60) return `${seconds}秒前`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    return `${Math.round(hours / 24)}天前`;
  }

  function formatTimestamp(value) {
    if (!value) return "";
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      try { return new Date(n).toLocaleString(); } catch { return String(value); }
    }
    return String(value);
  }

  function resultBadge(session) {
    if (!session.lastResult) return "";
    const cls = session.lastResultStatus === "error" ? "result-error"
      : session.lastResultStatus === "need_input" ? "result-need"
      : "result-done";
    const age = formatAge(session.lastResultAtMs);
    return `<span class="session-result ${cls}" title="${escapeHtml(session.lastResult)}">▸ ${escapeHtml(compactText(session.lastResult, 70))}${age ? ` · ${age}` : ""}</span>`;
  }

  const _sessionCardCache = new Map();
  function renderSessions() {
    const list = $("sessionList");
    if (!state.sessions.length) {
      if (list.innerHTML !== '<div class="meta-hint">暂无会话。点击“新建会话”创建一个。</div>') {
        list.innerHTML = '<div class="meta-hint">暂无会话。点击“新建会话”创建一个。</div>';
      }
      _sessionCardCache.clear();
      return;
    }
    const html = state.sessions.map((session, index) => sessionCardHtml(session, index)).join("");
    if (list.innerHTML !== html) list.innerHTML = html;
  }

  function sessionCardHtml(session, index = 0) {
    const seq = sessionSeq(session, index);
    const sig = [
      session.id, session.name, session.state, session.connected ? 1 : 0,
      session.queueLength || 0, session.lastResultStatus || "", session.lastResultAtMs || 0,
      session.id === state.selectedSessionId ? 1 : 0,
      seq,
      session.transport || "",
      session.overrides ? 1 : 0,
      session.projectDir || "",
      session.conversationShort || "",
      session.activity || "",
      session.interruptReason || "",
      (session.activity === "working" || session.activity === "stalled") ? Math.floor((session.workingAgeMs || 0) / 3000) : 0,
    ].join("\u0001");
    const cached = _sessionCardCache.get(session.id);
    if (cached && cached.sig === sig) return cached.html;
    // The conversation id is auto-captured by the waiter from the agent terminal's
    // CURSOR_CONVERSATION_ID; show a short, copy-on-click chip so the user can
    // grab the exact Cursor chat id without ever typing it.
    const cidChip = session.conversationShort
      ? `<span class="session-cid" role="button" tabindex="0" data-copy-cid="${escapeHtml(session.conversationId)}" title="Cursor 官方 conversation ID：${escapeHtml(session.conversationId)}（点击复制；转接时用于读取原官方上下文）">CID ${escapeHtml(session.conversationShort)}</span>`
      : "";
    // A folder chip when the session is pinned to a project dir, so the user can
    // see at a glance that this session only works inside that one project.
    const projectChip = session.projectDir
      ? `<span class="session-project" title="项目目录：${escapeHtml(session.projectDir)}（本会话只在此目录内工作）">📁 ${escapeHtml(session.projectName || session.projectDir)}</span>`
      : "";
    const transportChip = session.transport
      ? `<span class="session-transport session-transport-${escapeHtml(session.transport)}" title="Transport: ${escapeHtml(session.transport)}">${escapeHtml(String(session.transport).toUpperCase())}</span>`
      : "";
    // Show a short title only when the name is not the default "会话 N" pattern
    // (the session-seq badge already covers that). Limit to 6 chars so prompt
    // text does not overflow the card.
    const rawTitle = session.name || "";
    const isDefaultName = /^会话\s*\d+$/.test(rawTitle.trim());
    const shortTitle = (!isDefaultName && rawTitle) ? rawTitle.slice(0, 6) : "";
    const html = `<div class="session-card ${session.id === state.selectedSessionId ? "selected" : ""}${attentionClass(session)}" role="button" tabindex="0" aria-label="会话 ${escapeHtml(session.name || session.id)}" data-session-id="${escapeHtml(session.id)}">
        <span class="${sessionDotClass(session)}"></span>
        <span class="session-main">
          <span class="session-name"><span class="session-seq">会话 ${escapeHtml(seq)}</span>${escapeHtml(shortTitle)}${session.overrides ? ' <span class="session-override" title="使用自定义参数">⚙</span>' : ""}${transportChip}${cidChip}${projectChip}</span>
          <span class="session-meta ${session.activity === "working" ? "meta-working" : session.activity === "stalled" ? "meta-stalled" : ""}">${escapeHtml(sessionStateLabel(session))}</span>
          ${resultBadge(session)}
        </span>
        <span class="session-side">
          <span class="session-queue">队列 ${session.queueLength || 0}</span>
          <button class="session-menu-btn" data-session-menu="${escapeHtml(session.id)}" aria-haspopup="menu" aria-label="会话操作" title="会话操作（也可右键卡片）">⋯</button>
        </span>
      </div>`;
    _sessionCardCache.set(session.id, { sig, html });
    return html;
  }

  function syncSettingsInputs() {
    $("setMaxSessions").value = state.settings.maxConcurrentSessions ?? 4;
    $("setPerSessionQueueLimit").value = state.settings.perSessionQueueLimit ?? 20;
    $("setGlobalQueueLimit").value = state.settings.globalQueueLimit ?? 100;
    $("setSchedulingMode").value = state.settings.schedulingMode ?? "direct";
    $("setKeepalive").value = state.settings.keepaliveSeconds ?? 300;
    $("setNotifyOnAttention").checked = state.settings.notifyOnAttention !== false;
    $("setWebhookUrl").value = state.settings.webhookUrl ?? "";
    const webhookEvents = Array.isArray(state.settings.webhookEvents) ? state.settings.webhookEvents : ["done", "need_input", "error"];
    $("setWebhookOnlyAttention").checked = !webhookEvents.includes("done");
  }

  function renderAttachments() {
    const rows = [
      ...state.draft.folder_paths.map((filePath) => ({ kind: "文件夹", path: filePath, bucket: "folder_paths" })),
      ...state.draft.file_paths.map((filePath) => ({ kind: "文件", path: filePath, bucket: "file_paths" })),
      ...state.draft.image_paths.map((filePath) => ({ kind: "图片", path: filePath, bucket: "image_paths" })),
    ];
    // Periodically prune thumbnail cache entries that no longer correspond to a
    // current image attachment, so thumbs/thumbReq can't grow unbounded over a
    // long session with many pasted images.
    if (Object.keys(state.thumbs).length > 80) {
      const live = new Set(state.draft.image_paths);
      for (const key of Object.keys(state.thumbs)) {
        if (!live.has(key)) { delete state.thumbs[key]; delete state.thumbReq[key]; }
      }
    }
    const sig = `${rows.length}|${rows.map((r) => `${r.bucket}:${r.path}`).join("\u0001")}|${Object.keys(state.thumbs).length}`;
    if (sig === state._lastAttachSig) return;
    state._lastAttachSig = sig;
    $("attachments").innerHTML = rows.length ? rows.map((row) => {
      const name = String(row.path).split(/[\\/]/).pop() || row.path;
      const thumb = row.bucket === "image_paths" && state.thumbs[row.path]
        ? `<img class="attachment-thumb" src="${state.thumbs[row.path]}" alt="">`
        : "";
      return `
      <div class="queued-tag attachment-chip">
        ${thumb}
        <span>${row.kind}</span>
        <span class="attachment-label" title="${escapeHtml(row.path)}">${escapeHtml(name)}</span>
        <button class="mini-button" data-remove-attachment="${escapeHtml(`${row.bucket}::${row.path}`)}">移除</button>
      </div>
    `;
    }).join("") : "";
  }

  // Request a thumbnail at most once per path: skip if we already have it or a
  // request is already in flight (the extension stays silent for non-thumbnailable
  // or oversized files, so without this guard we'd re-ask on every re-render).
  function requestThumb(imagePath) {
    if (!imagePath || state.thumbs[imagePath] || state.thumbReq[imagePath]) return;
    state.thumbReq[imagePath] = true;
    send("requestThumb", { path: imagePath });
  }

  function addPaths(paths, kind) {
    for (const filePath of paths || []) {
      const isFolder = kind === "folder";
      const isImage = !isFolder && /\.(png|jpe?g|gif|bmp|webp)$/i.test(String(filePath));
      const target = isFolder ? state.draft.folder_paths : isImage ? state.draft.image_paths : state.draft.file_paths;
      if (!target.includes(filePath)) {
        target.push(filePath);
        if (isImage) requestThumb(filePath);
      }
    }
    renderAttachments();
  }

  function queueItemHtml(entry, sessionId, scope) {
    const payload = entry.payload || {};
    const filePaths = payload.file_paths || [];
    const imagePaths = payload.image_paths || [];
    const folderPaths = payload.folder_paths || [];
    let tagsHtml = "";
    for (let i = 0; i < folderPaths.length; i++) tagsHtml += '<span class="queued-tag">文件夹</span>';
    for (let i = 0; i < filePaths.length; i++) tagsHtml += '<span class="queued-tag">文件</span>';
    for (let i = 0; i < imagePaths.length; i++) tagsHtml += '<span class="queued-tag">图片</span>';
    const thumbs = imagePaths
      .filter((imagePath) => state.thumbs[imagePath])
      .map((imagePath) => `<img class="attachment-thumb" src="${state.thumbs[imagePath]}" alt="">`)
      .join("");
    const id = escapeHtml(entry.id);
    const sid = escapeHtml(sessionId || "");
    const sc = escapeHtml(scope);
    return `
      <div class="queued-item">
        <div class="queued-copy">
          <div class="queued-text">${escapeHtml(compactText(payload.user_input || "仅附件消息", 160))}</div>
          ${thumbs ? `<div class="queued-thumbs">${thumbs}</div>` : ""}
          <div class="queued-meta-row">
            <span class="queued-tag">${escapeHtml(scope === "global" ? "待分配" : sessionId)}</span>
            <span class="queued-tag">${escapeHtml(entry.source || "panel")}</span>
            ${tagsHtml}
            <span class="queued-spacer"></span>
            <div class="queued-actions">
              <button class="queued-action-btn" data-move-queued="${id}" data-dir="up" data-session-id="${sid}" data-scope="${sc}" title="上移" aria-label="上移">↑</button>
              <button class="queued-action-btn" data-move-queued="${id}" data-dir="down" data-session-id="${sid}" data-scope="${sc}" title="下移" aria-label="下移">↓</button>
              <button class="queued-action-btn queued-action-remove" data-remove-queued="${id}" data-session-id="${sid}" data-scope="${sc}" title="移除" aria-label="移除">×</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function requestQueueThumbs() {
    const wanted = [];
    for (const entry of state.globalQueue || []) {
      for (const imagePath of (entry.payload && entry.payload.image_paths) || []) wanted.push(imagePath);
    }
    for (const session of state.sessions || []) {
      for (const entry of session.queuedResponses || []) {
        for (const imagePath of (entry.payload && entry.payload.image_paths) || []) wanted.push(imagePath);
      }
    }
    for (const imagePath of wanted) requestThumb(imagePath);
  }

  function allQueueItemsHtml() {
    const parts = [];
    if (state.globalQueue.length) {
      parts.push(`<div class="queued-section-title">待分配队列</div>${state.globalQueue.map((entry) => queueItemHtml(entry, "", "global")).join("")}`);
    }
    for (const session of state.sessions) {
      if (session.queuedResponses && session.queuedResponses.length) {
        parts.push(`<div class="queued-section-title">${escapeHtml(session.name || session.id)}</div>${session.queuedResponses.map((entry) => queueItemHtml(entry, session.id, "session")).join("")}`);
      }
    }
    return parts.length ? parts.join("") : '<div class="meta-hint">暂无待分配或待消费消息。</div>';
  }

  function renderQueue() {
    requestQueueThumbs();
    const queueDialogVisible = !$("queueDialog").classList.contains("hidden");
    if (queueDialogVisible) {
      const dialogHtml = allQueueItemsHtml();
      if ($("queueDialogList").innerHTML !== dialogHtml) $("queueDialogList").innerHTML = dialogHtml;
    }
    const selected = selectedSession();
    const selectedQueue = selected?.queuedResponses || [];
    if (!state.globalQueue.length && !selectedQueue.length) {
      if ($("queued-root").innerHTML) $("queued-root").innerHTML = "";
      return;
    }
    const globalPreview = state.globalQueue.slice(0, INLINE_QUEUE_PREVIEW_LIMIT);
    const sessionPreview = selectedQueue.slice(0, INLINE_QUEUE_PREVIEW_LIMIT);
    const hiddenCount = Math.max(0, state.globalQueue.length - globalPreview.length) + Math.max(0, selectedQueue.length - sessionPreview.length);
    const inlineSig = `${state.globalQueue.map((entry) => entry.id).join(",")}|${selectedQueue.map((entry) => entry.id).join(",")}|${selected?.id || ""}|${hiddenCount}`;
    if (state._lastInlineQueueSig === inlineSig && $("queued-root").innerHTML) return;
    state._lastInlineQueueSig = inlineSig;
    $("queued-root").innerHTML = `
      <section class="queued-section">
        <div class="queued-section-head">
          <div class="queued-section-title">队列：待分配 ${state.globalQueue.length} / 当前会话 ${selectedQueue.length}</div>
          <button class="mini-button" id="inlineQueueOpen">展开</button>
        </div>
        <div class="queued-list">
          ${globalPreview.map((entry) => queueItemHtml(entry, "", "global")).join("")}
          ${sessionPreview.map((entry) => queueItemHtml(entry, selected.id, "session")).join("")}
          ${hiddenCount ? `<div class="queued-more">还有 ${hiddenCount} 条未在此处显示，点“展开”查看全部。</div>` : ""}
        </div>
      </section>
    `;
    const button = $("inlineQueueOpen");
    // Replace any previous handler via onclick (not addEventListener) so repeated
    // renders don't stack duplicate listeners on the same element.
    if (button) button.onclick = () => { openModal("queueDialog"); renderQueue(); };
  }

  function renderEvents() {
    const latest = state.events.slice(0, 2);
    const eventsSig = latest.map((e) => `${e.at}|${e.text}`).join("\u0001");
    if (eventsSig !== state._lastEventsSig) {
      state._lastEventsSig = eventsSig;
      $("events").innerHTML = latest.length
        ? latest.map((entry) => `<div class="event-line">[${escapeHtml(entry.at)}] ${escapeHtml(entry.text)}</div>`).join("")
        : '<div class="event-line">保活说明：等待超过保活间隔后，Agent 会收到 KEEPALIVE_NOOP 并重新运行 wait。</div>';
    }
    renderEventHistoryIfOpen();
  }

  function persistentEventText(item) {
    if (!item || typeof item !== "object") return "";
    if (item.type === "queued_global") return `加入待分配队列：${compactText(item.payload?.user_input || item.message || "", 160)}`;
    if (item.type === "queued_session") return `加入会话队列 ${item.session_id || ""}：${compactText(item.payload?.user_input || item.message || "", 160)}`;
    if (item.type === "received") return `${item.session_id || ""} 已领取任务：${compactText(item.message_preview || "", 160)}`;
    if (item.type === "result") return `${item.session_id || ""} 上报 ${item.status || "done"}：${compactText(item.summary || item.summary_preview || "", 160)}`;
    if (item.type === "handoff") return `会话转接：${item.source || ""} → ${item.target || ""}`;
    if (item.type === "global_queue_cleared") return "已清空待分配队列";
    return `${item.type || "event"} ${compactText(JSON.stringify(item), 180)}`;
  }

  function renderEventHistoryIfOpen() {
    const dialog = $("eventDialog");
    if (!dialog || dialog.classList.contains("hidden")) return;
    const rows = [
      ...state.events.map((entry) => ({ at: entry.at, text: entry.text, live: true })),
      ...state.persistedEvents.map((item) => ({ at: item.at || item.created_at || item.received_at || "", text: persistentEventText(item), live: false })),
    ].filter((entry) => entry.text);
    const historySig = rows.map((entry) => `${entry.at}|${entry.text}`).join("\u0001");
    if (historySig === state._lastHistorySig) return;
    state._lastHistorySig = historySig;
    $("eventHistoryList").innerHTML = rows.length
      ? rows.map((entry) => `<div class="history-entry${entry.live ? " live-event" : ""}"><div class="history-time">${escapeHtml(entry.at || "")}${entry.live ? " · 面板事件" : ""}</div><div class="history-text">${escapeHtml(entry.text)}</div></div>`).join("")
      : '<div class="meta-hint">暂无执行记录。复制指令、安装 MCP、发送入队或 Agent 消费任务后都会显示在这里。</div>';
  }

  function renderTimeline(items) {
    const names = {};
    for (const session of state.sessions) names[session.id] = session.name;
    $("timelineList").innerHTML = (items && items.length)
      ? items.map((item) => {
        const cls = item.status === "error" ? "result-error" : item.status === "need_input" ? "result-need" : "result-done";
        const name = names[item.session_id] || item.session_id || "";
        const text = item.summary || item.summary_preview || "";
        return `<div class="history-entry"><div class="history-time">${escapeHtml(item.at || "")} · ${escapeHtml(name)} · <span class="${cls}">${escapeHtml(item.status || "done")}</span></div><div class="history-text">${escapeHtml(compactText(text, 400))}</div></div>`;
      }).join("")
      : '<div class="meta-hint">暂无结果记录。</div>';
  }

  function detailMessageHtml(message) {
    const role = message.type === "user" ? "用户" : message.type === "assistant" ? "AI" : "其他";
    const extras = [
      message.hasToolResults ? "工具" : "",
      message.hasCodeBlocks ? "代码" : "",
      message.hasDiffs ? "diff" : "",
    ].filter(Boolean).join(" / ");
    return `<div class="detail-message detail-${escapeHtml(message.type || "other")}">
      <div class="detail-message-head"><span>${escapeHtml(role)}</span><span>${escapeHtml(formatTimestamp(message.createdAt))}</span>${extras ? `<span>${escapeHtml(extras)}</span>` : ""}</div>
      <pre class="detail-message-text">${escapeHtml(message.text || "")}</pre>
    </div>`;
  }

  function renderSessionDetail(detail) {
    state.sessionDetail = detail || null;
    const dialog = $("sessionDetailDialog");
    if (!dialog) return;
    const session = detail?.session || {};
    const conv = detail?.conversation || null;
    const title = conv?.name || session.name || detail?.sessionId || "";
    setTextIfChanged($("sessionDetailTitle"), title ? `会话详情：${title}` : "会话详情");
    const meta = [
      detail?.sessionId ? `本地 ID：${detail.sessionId}` : "",
      detail?.conversationId ? `Cursor ID：${detail.conversationId}` : "",
      conv ? `官方消息：${conv.messageCount || conv.messages?.length || 0} 条` : "",
      session.transport ? `模式：${String(session.transport).toUpperCase()}` : "",
    ].filter(Boolean).join(" · ");
    setTextIfChanged($("sessionDetailMeta"), meta || "未找到 Cursor 官方会话，显示本地桥接记录。");

    const officialHtml = conv && conv.messages && conv.messages.length
      ? conv.messages.map(detailMessageHtml).join("")
      : '<div class="meta-hint">没有读取到 Cursor 官方完整回复。可能是 Cursor 数据库不可读、当前是远程窗口，或该会话还没有写入历史。</div>';
    const localHtml = detail?.localHistory?.length
      ? detail.localHistory.slice().reverse().map((item) => `<div class="history-entry"><div class="history-time">${escapeHtml(item.at || item.type || "")}</div><pre class="history-text detail-local-text">${escapeHtml(item.text || "")}</pre></div>`).join("")
      : '<div class="meta-hint">暂无本地桥接历史。</div>';
    $("sessionDetailBody").innerHTML = `
      <section class="detail-section">
        <div class="advanced-title">Cursor 官方对话</div>
        <div class="detail-message-list">${officialHtml}</div>
      </section>
      <section class="detail-section">
        <div class="advanced-title">本地桥接记录</div>
        <div class="event-history-list">${localHtml}</div>
      </section>
    `;
  }

  function openSessionDetail(sessionId) {
    const sid = sessionId || state.selectedSessionId;
    if (!sid) return;
    renderSessionDetail({ sessionId: sid, session: (state.sessions || []).find((s) => s.id === sid), localHistory: [] });
    openModal("sessionDetailDialog");
    send("requestSessionDetail", { sessionId: sid });
  }

  function submit() {
    const payload = {
      status: "continue",
      user_input: $("instruction").value,
      selected_choice: undefined,
      file_paths: state.draft.file_paths,
      image_paths: state.draft.image_paths,
      folder_paths: state.draft.folder_paths,
      suggested_tools: [],
    };
    send("send", {
      payload,
      targetMode: $("targetMode").value,
      sessionId: state.selectedSessionId,
    });
    state.events.unshift({ at: new Date().toLocaleTimeString(), text: $("targetMode").value === "idle-first" ? "已提交到待分配队列，等待空闲 MCP 会话领取。" : "已提交到队列，等待 Agent 下一次 wait 消费。" });
    if (state.events.length > 100) state.events.length = 100;
    renderEvents();
    $("instruction").value = "";
    state.draft = { file_paths: [], image_paths: [], folder_paths: [] };
    renderAttachments();
  }

  function saveSettings() {
    // Only the few visible fields are sent; the backend merges over existing
    // settings, so all hidden advanced fields keep their current/default values.
    send("updateExtensionSettings", {
      settings: {
        maxConcurrentSessions: Number($("setMaxSessions").value || 4),
        perSessionQueueLimit: Number($("setPerSessionQueueLimit").value || 20),
        globalQueueLimit: Number($("setGlobalQueueLimit").value || 100),
        schedulingMode: $("setSchedulingMode").value || "direct",
        keepaliveSeconds: Number($("setKeepalive").value || 300),
        notifyOnAttention: $("setNotifyOnAttention").checked,
        webhookUrl: ($("setWebhookUrl").value || "").trim(),
        webhookEvents: $("setWebhookOnlyAttention").checked ? ["need_input", "error"] : ["done", "need_input", "error"],
      },
    });
    closeModal("settingsDialog");
  }

  function openSessionSettings() {
    const session = selectedSession();
    const overrides = (session && session.overrides) || {};
    $("sessionSettingsTarget").textContent = session ? `会话：${session.name}` : "未选择会话";
    $("sessKeepalive").value = overrides.keepaliveSeconds ?? "";
    $("sessTimeout").value = overrides.waitTimeoutSeconds ?? "";
    $("sessPoll").value = overrides.pollSeconds ?? "";
    openModal("sessionSettingsDialog");
  }

  function saveSessionSettings() {
    send("updateSessionSettings", {
      sessionId: state.selectedSessionId,
      overrides: {
        keepaliveSeconds: $("sessKeepalive").value,
        waitTimeoutSeconds: $("sessTimeout").value,
        pollSeconds: $("sessPoll").value,
      },
    });
    closeModal("sessionSettingsDialog");
  }

  function clearSessionSettings() {
    send("updateSessionSettings", { sessionId: state.selectedSessionId, overrides: {} });
    closeModal("sessionSettingsDialog");
  }

  function handoffOptionLabel(session) {
    const cid = session.conversationShort ? ` · Cursor ${session.conversationShort}` : "";
    return `${session.name || session.id} · ${session.connected ? "在线" : "离线"}${cid}`;
  }

  function handoffOption(value, label, selected) {
    return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }

  function handoffContextFor(session) {
    if (!session) return "";
    const parts = [];
    if (session.conversationId) parts.push(`[原 Cursor 官方会话 ID] ${session.conversationId}`);
    if (session.lastMessagePreview) parts.push(`[原会话最近指令] ${session.lastMessagePreview}`);
    if (session.lastResult) parts.push(`[原会话最近结果] ${session.lastResult}`);
    return parts.join("\n");
  }

  function openHandoff() {
    const sessions = state.sessions || [];
    const sourceId = state.selectedSessionId || (sessions[0] && sessions[0].id) || "";
    $("handoffSource").innerHTML = sessions.map((s) => handoffOption(s.id, handoffOptionLabel(s), s.id === sourceId)).join("");
    // Prefer connected sessions as targets; fall back to any other session so the
    // handoff still queues if nothing is online yet.
    const online = sessions.filter((s) => s.connected && s.id !== sourceId);
    const pool = online.length ? online : sessions.filter((s) => s.id !== sourceId);
    $("handoffTarget").innerHTML = pool.length
      ? pool.map((s, i) => handoffOption(s.id, handoffOptionLabel(s), i === 0)).join("")
      : '<option value="">（暂无其它会话）</option>';
    $("handoffReason").value = "";
    prefillHandoffContext();
    openModal("handoffDialog");
  }

  function prefillHandoffContext() {
    const sid = $("handoffSource").value;
    const session = (state.sessions || []).find((s) => s.id === sid);
    // Start with the lightweight preview (last instruction + last result) so the
    // textarea isn't empty while we fetch the full conversation history.
    $("handoffContext").value = handoffContextFor(session);
    updateHandoffHint();
    // Request the full conversation brief from the extension host, which reads
    // Cursor's SQLite DB directly. The brief replaces the preview when it arrives.
    const cid = session && session.conversationId;
    if (cid) {
      $("handoffContext").placeholder = "正在从 Cursor 读取完整对话历史…";
      send("getConversationBrief", { composerId: cid });
    }
  }

  function updateHandoffHint() {
    const sid = $("handoffSource").value;
    const tid = $("handoffTarget").value;
    const hint = $("handoffHint");
    if (!hint) return;
    if (!tid) { hint.textContent = "没有可用的目标会话，请先新建或连接另一个会话。"; return; }
    if (sid === tid) { hint.textContent = "来源会话和目标会话不能相同。"; return; }
    const target = (state.sessions || []).find((s) => s.id === tid);
    hint.textContent = target && !target.connected
      ? "提示：目标会话当前离线，转接消息会先排队，等它进入 wait 后被消费。"
      : "目标会话在线，转接后会尽快被消费。";
  }

  function submitHandoff() {
    const sourceId = $("handoffSource").value;
    const targetId = $("handoffTarget").value;
    if (!targetId || sourceId === targetId) { updateHandoffHint(); return; }
    send("handoffSession", {
      sourceId,
      targetId,
      reason: $("handoffReason").value,
      context: $("handoffContext").value,
    });
    closeModal("handoffDialog");
  }

  // ---- Per-session action menu (⋯ button + right-click) --------------------
  // Right-click / ⋯ open the SAME menu so mouse, touch and keyboard users have
  // parity (the context menu is a redundant power-user shortcut, never the only
  // path). Every per-session action now lives here instead of the global "更多".
  let _menuSessionId = "";

  function sessionMenuModel(session) {
    const hasProject = !!(session && session.projectDir);
    const items = [
      { action: "detail", icon: "☰", label: "查看对话详情…" },
      { action: "handoff", icon: "↪", label: "会话转接…", hint: "交给其它会话" },
      { action: "rename", icon: "✎", label: "重命名会话" },
      // Pin the session to one project folder inside a multi-project workspace so
      // the agent only works there; the hint shows the current target when set.
      { action: "setProject", icon: "📁", label: hasProject ? "更改项目目录…" : "设置项目目录…", hint: hasProject ? (session.projectName || "已限定") : "限定到某个项目" },
    ];
    if (hasProject) items.push({ action: "clearProject", icon: "⊘", label: "取消项目目录限定" });
    items.push(
      { action: "params", icon: "⚙", label: "会话参数…" },
      { sep: true },
      { action: "copyInstruction", icon: "⧉", label: "复制启动指令" },
      { action: "startWait", icon: "▶", label: "启动等待终端" },
      { action: "clearQueue", icon: "⌫", label: "清空该会话队列" },
      { sep: true },
      { action: "stop", icon: "■", label: "停止循环", danger: true },
      { action: "delete", icon: "🗑", label: "删除会话", danger: true },
    );
    return items;
  }

  function renderSessionMenu(session) {
    return sessionMenuModel(session).map((it) => {
      if (it.sep) return '<div class="context-menu-sep"></div>';
      return `<button class="context-menu-item${it.danger ? " danger" : ""}" role="menuitem" tabindex="-1" data-menu-action="${it.action}">`
        + `<span class="cm-ico">${it.icon}</span><span class="cm-label">${escapeHtml(it.label)}</span>`
        + `${it.hint ? `<span class="cm-hint">${escapeHtml(it.hint)}</span>` : ""}</button>`;
    }).join("");
  }

  function selectSession(sessionId) {
    if (!sessionId || state.selectedSessionId === sessionId) return;
    state.selectedSessionId = sessionId;
    renderSessions();
    renderQueue();
    setSelectedSessionLabel();
  }

  function openSessionMenu(sessionId, x, y) {
    const session = (state.sessions || []).find((s) => s.id === sessionId);
    if (!session) return;
    _menuSessionId = sessionId;
    // Keep the composer + selected-based dialogs (handoff/params) in sync with
    // whichever session the menu was opened on.
    selectSession(sessionId);
    const menu = $("sessionMenu");
    if (!menu) return;
    menu.innerHTML = `<div class="context-menu-title">${escapeHtml(session.name || session.id)}</div>${renderSessionMenu(session)}`;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove("hidden");
    // Flip / clamp so the menu never spills outside the panel viewport.
    const rect = menu.getBoundingClientRect();
    const pad = 8;
    let left = x;
    let top = y;
    if (left + rect.width + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - rect.width - pad);
    if (top + rect.height + pad > window.innerHeight) top = Math.max(pad, y - rect.height);
    menu.style.left = `${Math.max(pad, left)}px`;
    menu.style.top = `${Math.max(pad, top)}px`;
    const first = menu.querySelector(".context-menu-item");
    if (first) first.focus();
  }

  function closeSessionMenu() {
    const menu = $("sessionMenu");
    if (menu && !menu.classList.contains("hidden")) menu.classList.add("hidden");
  }

  function runSessionMenuAction(action) {
    const sid = _menuSessionId || state.selectedSessionId;
    closeSessionMenu();
    if (!sid) return;
    switch (action) {
      case "handoff": openHandoff(); break;
      case "detail": openSessionDetail(sid); break;
      case "rename": send("renameSessionPrompt", { sessionId: sid }); break;
      case "setProject": send("pickProject", { sessionId: sid }); break;
      case "clearProject": send("clearProject", { sessionId: sid }); break;
      case "params": openSessionSettings(); break;
      case "copyInstruction": send("copyAgentInstruction", { sessionId: sid }); break;
      case "startWait": send("startWait", { sessionId: sid }); break;
      case "clearQueue": send("clearQueue", { scope: "session", sessionId: sid }); break;
      case "stop": send("stop", { sessionId: sid }); break;
      case "delete": send("deleteSession", { sessionId: sid }); break;
      default: break;
    }
  }

  function bindEvents() {
    $("newSession").addEventListener("click", () => send("createSession"));
    $("copyInstruction").addEventListener("click", () => send("copyAgentInstruction", { sessionId: state.selectedSessionId }));
    const installMcpTop = $("installMcpTop");
    if (installMcpTop) installMcpTop.addEventListener("click", () => send("installMcp"));
    const openWindowTop = $("openWindowTop");
    if (openWindowTop) openWindowTop.addEventListener("click", () => send("openWindow"));
    const copyShellBtn = $("copyShellInstructionBtn");
    if (copyShellBtn) copyShellBtn.addEventListener("click", () => send("copyShellInstruction", { sessionId: state.selectedSessionId }));
    $("settingsBtn").addEventListener("click", () => { syncSettingsInputs(); openModal("settingsDialog"); });
    $("moreBtn").addEventListener("click", () => openModal("moreDialog"));
    $("send").addEventListener("click", submit);
    $("installRule").addEventListener("click", () => send("installRule"));
    $("runDoctor").addEventListener("click", () => send("startDoctor"));
    const installMcpBtn = $("installMcpBtn");
    if (installMcpBtn) installMcpBtn.addEventListener("click", () => send("installMcp"));
    const copyMcpBtn = $("copyMcpInstructionBtn");
    if (copyMcpBtn) copyMcpBtn.addEventListener("click", () => send("copyMcpInstruction", { sessionId: state.selectedSessionId }));
    const openWindowBtn = $("openWindowBtn");
    if (openWindowBtn) openWindowBtn.addEventListener("click", () => { send("openWindow"); closeModal("moreDialog"); });
    $("saveSessionSettings").addEventListener("click", saveSessionSettings);
    $("clearSessionSettings").addEventListener("click", clearSessionSettings);
    $("doHandoff").addEventListener("click", submitHandoff);
    $("handoffSource").addEventListener("change", prefillHandoffContext);
    $("handoffTarget").addEventListener("change", updateHandoffHint);
    $("clearGlobalQueue").addEventListener("click", () => send("clearQueue", { scope: "global" }));
    const openEvents = () => {
      openModal("eventDialog");
      state._lastHistorySig = "";
      send("requestEventHistory");
      renderEvents();
    };
    $("eventHistoryBtn").addEventListener("click", openEvents);
    $("showEventsBtn").addEventListener("click", openEvents);
    $("showTimelineBtn").addEventListener("click", () => { renderTimeline([]); send("requestResultTimeline"); openModal("timelineDialog"); });
    $("showQueueBtn").addEventListener("click", () => { openModal("queueDialog"); renderQueue(); });
    $("installPatch").addEventListener("click", () => send("installRetryPatch"));
    $("uninstallPatch").addEventListener("click", () => send("uninstallRetryPatch"));
    $("saveSettings").addEventListener("click", saveSettings);
    const testWebhookBtn = $("testWebhookBtn");
    if (testWebhookBtn) testWebhookBtn.addEventListener("click", () => send("testWebhook", { url: ($("setWebhookUrl").value || "").trim() }));
    $("targetMode").addEventListener("change", () => { state.targetTouched = true; });
    $("pickFiles").addEventListener("click", () => send("pickFiles"));
    $("pickFolders").addEventListener("click", () => send("pickFolders"));
    $("pickEditor").addEventListener("click", () => send("pickActiveEditor"));
    $("pickWorkspace").addEventListener("click", () => send("pickWorkspaceFolder"));
    $("sessionList").addEventListener("click", (event) => {
      const closest = (sel) => (event.target && event.target.closest ? event.target.closest(sel) : null);
      // The ⋯ button opens the per-session action menu anchored beneath it.
      const menuBtn = closest("[data-session-menu]");
      if (menuBtn) {
        event.stopPropagation();
        const rect = menuBtn.getBoundingClientRect();
        openSessionMenu(menuBtn.dataset.sessionMenu, rect.left, rect.bottom + 4);
        return;
      }
      // A click on the conversation-id chip copies the id (via the extension's
      // clipboard) instead of selecting the card -- one-tap, no manual typing.
      const cidEl = closest("[data-copy-cid]");
      if (cidEl) {
        event.stopPropagation();
        const cid = cidEl.dataset.copyCid || "";
        if (cid) send("copyText", { text: cid });
        return;
      }
      const card = closest("[data-session-id]");
      if (!card) return;
      selectSession(card.dataset.sessionId);
    });
    document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.closeModal)));
    document.querySelectorAll(".modal-layer").forEach((layer) => layer.addEventListener("click", (event) => {
      if (event.target === layer) closeModal(layer.id);
    }));
    $("instruction").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) submit();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeSessionMenu();
        ["moreDialog", "settingsDialog", "eventDialog", "queueDialog", "timelineDialog", "sessionSettingsDialog", "handoffDialog", "sessionDetailDialog"].forEach(closeModal);
      }
    });
    window.addEventListener("paste", (event) => {
      for (const item of event.clipboardData?.items || []) {
        if (item.type && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) processPastedImageFile(file, (dataUrl) => send("pasteImage", { dataUrl }));
        }
      }
    });
    $("attachments").addEventListener("click", (event) => {
      const target = event.target && event.target.closest ? event.target.closest("[data-remove-attachment]") : null;
      if (!target) return;
      const [bucket, filePath] = target.dataset.removeAttachment.split("::");
      state.draft[bucket] = state.draft[bucket].filter((value) => value !== filePath);
      // Release the thumbnail cache entry for a removed image attachment so
      // thumbs/thumbReq don't grow unbounded over a long session.
      if (bucket === "image_paths") {
        delete state.thumbs[filePath];
        delete state.thumbReq[filePath];
      }
      renderAttachments();
    });
    document.addEventListener("click", (event) => {
      const target = event.target && event.target.closest ? event.target.closest("[data-remove-queued]") : null;
      if (!target) return;
      send("removeQueued", {
        id: target.dataset.removeQueued || "",
        sessionId: target.dataset.sessionId || state.selectedSessionId,
        scope: target.dataset.scope || "session",
      });
    });
    document.addEventListener("click", (event) => {
      const target = event.target && event.target.closest ? event.target.closest("[data-move-queued]") : null;
      if (!target) return;
      send("moveQueued", {
        id: target.dataset.moveQueued || "",
        direction: target.dataset.dir || "down",
        sessionId: target.dataset.sessionId || state.selectedSessionId,
        scope: target.dataset.scope || "session",
      });
    });

    // Right-click a session card opens the same per-session menu (a redundant
    // power-user shortcut that mirrors the visible ⋯ button).
    $("sessionList").addEventListener("contextmenu", (event) => {
      const card = event.target && event.target.closest ? event.target.closest("[data-session-id]") : null;
      if (!card) return;
      event.preventDefault();
      openSessionMenu(card.dataset.sessionId, event.clientX, event.clientY);
    });
    // Keyboard parity: Enter/Space selects, ContextMenu key / Shift+F10 opens menu.
    $("sessionList").addEventListener("keydown", (event) => {
      const card = event.target && event.target.closest ? event.target.closest("[data-session-id]") : null;
      if (!card) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectSession(card.dataset.sessionId);
      } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const rect = card.getBoundingClientRect();
        openSessionMenu(card.dataset.sessionId, rect.left + 24, rect.bottom - 8);
      }
    });
    const sessionMenu = $("sessionMenu");
    if (sessionMenu) {
      sessionMenu.addEventListener("click", (event) => {
        const item = event.target && event.target.closest ? event.target.closest("[data-menu-action]") : null;
        if (item) runSessionMenuAction(item.dataset.menuAction);
      });
      sessionMenu.addEventListener("keydown", (event) => {
        const items = Array.from(sessionMenu.querySelectorAll(".context-menu-item"));
        if (!items.length) return;
        const idx = items.indexOf(document.activeElement);
        if (event.key === "Escape") { event.preventDefault(); closeSessionMenu(); }
        else if (event.key === "ArrowDown") { event.preventDefault(); (items[idx + 1] || items[0]).focus(); }
        else if (event.key === "ArrowUp") { event.preventDefault(); (items[idx - 1] || items[items.length - 1]).focus(); }
        else if (event.key === "Home") { event.preventDefault(); items[0].focus(); }
        else if (event.key === "End") { event.preventDefault(); items[items.length - 1].focus(); }
      });
    }
    // Close the menu on any outside interaction.
    document.addEventListener("mousedown", (event) => {
      const menu = $("sessionMenu");
      if (!menu || menu.classList.contains("hidden")) return;
      const insideMenu = menu.contains(event.target);
      const onTrigger = event.target && event.target.closest ? event.target.closest("[data-session-menu]") : null;
      if (!insideMenu && !onTrigger) closeSessionMenu();
    });
    window.addEventListener("blur", closeSessionMenu);
    window.addEventListener("resize", closeSessionMenu);
    document.addEventListener("scroll", closeSessionMenu, true);
  }

  window.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type === "filesPicked") {
      if (data.filePaths || data.folderPaths) {
        addPaths(data.filePaths || []);
        addPaths(data.folderPaths || [], "folder");
      } else {
        addPaths(data.paths || [], data.kind);
      }
    }
    if (data.type === "pastedImageSaved") addPaths([data.path]);
    if (data.type === "thumb" && data.path) {
      state.thumbs[data.path] = data.dataUrl;
      if (!state._renderPending) {
        state._renderPending = true;
        queueMicrotask(() => {
          state._renderPending = false;
          renderAttachments();
          renderQueue();
        });
      }
    }
    if (data.type === "resultTimeline") renderTimeline(data.items || []);
    if (data.type === "eventHistory") {
      state.persistedEvents = data.items || [];
      state._lastHistorySig = "";
      renderEventHistoryIfOpen();
    }
    if (data.type === "sessionDetail") renderSessionDetail(data.detail || {});
    if (data.type === "conversationBrief" && data.brief) {
      // Full conversation history arrived from the extension host — replace the
      // lightweight preview in the handoff textarea with the real context.
      const ta = $("handoffContext");
      if (ta && document.getElementById("handoffDialog") && !document.getElementById("handoffDialog").classList.contains("hidden")) {
        const source = (state.sessions || []).find((s) => s.id === $("handoffSource").value);
        const cid = source && source.conversationId ? `[原 Cursor 官方会话 ID] ${source.conversationId}\n\n` : "";
        ta.value = `${cid}${data.brief}`;
        ta.placeholder = "要让目标会话继续完成的内容…";
      }
    }
    if (data.type === "extensionSettingsSaved") {
      state.settings = data.settings || state.settings || {};
      syncSettingsInputs();
    }
    if (data.type === "sessionCreated" && data.session) {
      state.selectedSessionId = data.session.id;
    }
    // The injected workbench helper reported which session the active Cursor
    // conversation belongs to (via the loopback channel). Follow it so switching
    // conversations auto-selects the matching session — no manual click, no
    // sending to the wrong session.
    if (data.type === "selectSession" && data.sessionId) {
      if (state.selectedSessionId !== data.sessionId && state.sessions.some((s) => s.id === data.sessionId)) {
        state.selectedSessionId = data.sessionId;
        renderSessions();
        renderQueue();
        setSelectedSessionLabel();
      }
    }
    if (data.type === "status") renderStatus(data.status || {});
    if (data.type === "event") {
      state.events.unshift({ at: data.at, text: compactText(data.text, 260) });
      if (state.events.length > 100) state.events.length = 100;
      renderEvents();
    }
  });

  bindEvents();
  renderEvents();
})();
