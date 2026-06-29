(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const state = {
    draft: { file_paths: [], image_paths: [] },
    settings: {},
    sessions: [],
    selectedSessionId: "",
    globalQueue: [],
    events: [],
    thumbs: {},
    thumbReq: {},
    lastSchedulingMode: undefined,
    lastRenderSig: "",
  };

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

  function sessionStateLabel(session) {
    if (session.connected) {
      if (session.queueLength > 0) return "已连接，待消费";
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

    const onlineText = `在线会话 ${status.onlineCount || 0}/${status.maxConcurrentSessions || state.sessions.length || 0}`;
    const onlineClass = `status-pill ${(status.onlineCount || 0) > 0 ? "running" : ""}`;
    setTextIfChanged($("onlinePill"), onlineText);
    setClassIfChanged($("onlinePill"), onlineClass);
    setTextIfChanged($("queuePill"), `待消费 ${status.totalQueueLength || 0}`);
    const patchLabelTxt = patchLabel(status.patch);
    const patchClass = status.patch && status.patch.installed ? "meta-chip meta-chip-ready" : "meta-chip";
    setTextIfChanged($("patchState"), patchLabelTxt);
    setClassIfChanged($("patchState"), patchClass);
    setTextIfChanged($("workspace"), status.workspaceRoot || status.detail || "等待打开项目");
    setTextIfChanged($("statusText"), status.statusText || "暂无在线会话，请复制启动指令到 Cursor 对话。");
    const patch = status.patch || {};
    const retryNoteText = patch.remote
      ? "Remote SSH 下此功能不作用于服务器，请在本机 Cursor 窗口安装。"
      : patch.installed && patch.native
        ? `已写入：P1 跳过付费墙 ${patch.native.p1 ? "✓" : "✗"} · P2 无限重试 ${patch.native.p2 ? "✓" : "✗"} · P3 50ms 间隔 ${patch.native.p3 ? "✓" : "✗"}。若没看到图标，请完全退出并重启 Cursor（不是重载窗口）。`
        : "点「注入图标 / 修复」写入本机 Cursor 官方聊天框；装好后需完全重启 Cursor。不作用于 SSH 服务器。";
    setTextIfChanged($("retryNote"), retryNoteText);

    const selected = selectedSession();
    setTextIfChanged($("selectedSessionText"), selected ? `当前会话：${selected.name}` : "当前会话：未选择");
    // Only sync the composer target from the default scheduling mode when that
    // default actually changes, so an auto-refresh never clobbers a manual pick.
    if (state.lastSchedulingMode !== state.settings.schedulingMode) {
      $("targetMode").value = state.settings.schedulingMode || "direct";
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
      s.lastResultStatus || "",
      s.lastResultAtMs || 0,
      s.connected && s.keepaliveDeadlineMs ? Math.floor(s.keepaliveDeadlineMs / 1000) : 0,
      s.overrides ? `${s.overrides.keepaliveSeconds || ""}|${s.overrides.waitTimeoutSeconds || ""}|${s.overrides.pollSeconds || ""}` : "",
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
    const html = state.sessions.map((session) => sessionCardHtml(session)).join("");
    if (list.innerHTML !== html) list.innerHTML = html;
  }

  function sessionCardHtml(session) {
    const sig = [
      session.id, session.name, session.state, session.connected ? 1 : 0,
      session.queueLength || 0, session.lastResultStatus || "", session.lastResultAtMs || 0,
      session.id === state.selectedSessionId ? 1 : 0,
      session.overrides ? 1 : 0,
    ].join("\u0001");
    const cached = _sessionCardCache.get(session.id);
    if (cached && cached.sig === sig) return cached.html;
    const html = `
      <button class="session-card ${session.id === state.selectedSessionId ? "selected" : ""}${attentionClass(session)}" data-session-id="${escapeHtml(session.id)}">
        <span class="${sessionDotClass(session)}"></span>
        <span class="session-main">
          <span class="session-name">${escapeHtml(session.name || session.id)}${session.overrides ? ' <span class="session-override" title="使用自定义参数">⚙</span>' : ""}</span>
          <span class="session-meta">${escapeHtml(sessionStateLabel(session))}</span>
          ${resultBadge(session)}
        </span>
        <span class="session-queue">队列 ${session.queueLength || 0}</span>
      </button>`;
    _sessionCardCache.set(session.id, { sig, html });
    return html;
  }

  function syncSettingsInputs() {
    $("setMaxSessions").value = state.settings.maxConcurrentSessions ?? 4;
    $("setSchedulingMode").value = state.settings.schedulingMode ?? "direct";
    $("setRuntime").value = state.settings.runtime ?? "auto";
    $("setQueueLimit").value = state.settings.perSessionQueueLimit ?? 3;
    $("setGlobalQueueLimit").value = state.settings.globalQueueLimit ?? 20;
    $("setKeepalive").value = state.settings.keepaliveSeconds ?? 300;
    $("setOfflineAfter").value = state.settings.offlineAfterSeconds ?? 15;
    $("setTimeout").value = state.settings.waitTimeoutSeconds ?? 0;
    $("setPoll").value = state.settings.pollSeconds ?? 0.2;
    $("setHistoryLimit").value = state.settings.historyLimit ?? 200;
    $("setImageLimit").value = state.settings.imageLimit ?? 50;
    $("setImageMaxDimension").value = state.settings.imageMaxDimension ?? 2000;
    $("setNotifyOnAttention").checked = state.settings.notifyOnAttention !== false;
    $("setInteractiveKeepalive").checked = state.settings.interactiveKeepalive === true;
  }

  function renderAttachments() {
    const rows = [
      ...state.draft.file_paths.map((filePath) => ({ kind: "文件", path: filePath, bucket: "file_paths" })),
      ...state.draft.image_paths.map((filePath) => ({ kind: "图片", path: filePath, bucket: "image_paths" })),
    ];
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

  function addPaths(paths) {
    for (const filePath of paths || []) {
      const isImage = /\.(png|jpe?g|gif|bmp|webp)$/i.test(String(filePath));
      const target = isImage ? state.draft.image_paths : state.draft.file_paths;
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
    let tagsHtml = "";
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
            <span class="queued-tag">${escapeHtml(scope === "global" ? "空闲优先" : sessionId)}</span>
            <span class="queued-tag">${escapeHtml(entry.source || "panel")}</span>
            ${tagsHtml}
          </div>
        </div>
        <div class="queued-actions">
          <button class="mini-button" data-move-queued="${id}" data-dir="up" data-session-id="${sid}" data-scope="${sc}" title="上移">↑</button>
          <button class="mini-button" data-move-queued="${id}" data-dir="down" data-session-id="${sid}" data-scope="${sc}" title="下移">↓</button>
          <button class="mini-button queued-remove" data-remove-queued="${id}" data-session-id="${sid}" data-scope="${sc}">移除</button>
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
      parts.push(`<div class="queued-section-title">空闲优先队列</div>${state.globalQueue.map((entry) => queueItemHtml(entry, "", "global")).join("")}`);
    }
    for (const session of state.sessions) {
      if (session.queuedResponses && session.queuedResponses.length) {
        parts.push(`<div class="queued-section-title">${escapeHtml(session.name || session.id)}</div>${session.queuedResponses.map((entry) => queueItemHtml(entry, session.id, "session")).join("")}`);
      }
    }
    return parts.length ? parts.join("") : '<div class="meta-hint">暂无待消费消息。</div>';
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
    const inlineSig = `${state.globalQueue.length}|${selectedQueue.length}|${selected?.id || ""}`;
    if (state._lastInlineQueueSig === inlineSig && $("queued-root").innerHTML) return;
    state._lastInlineQueueSig = inlineSig;
    $("queued-root").innerHTML = `
      <section class="queued-section">
        <div class="queued-section-head">
          <div class="queued-section-title">待消费队列：全局 ${state.globalQueue.length} / 当前 ${selectedQueue.length}</div>
          <button class="mini-button" id="inlineQueueOpen">展开</button>
        </div>
        <div class="queued-list">
          ${state.globalQueue.slice(0, 2).map((entry) => queueItemHtml(entry, "", "global")).join("")}
          ${selectedQueue.slice(0, 2).map((entry) => queueItemHtml(entry, selected.id, "session")).join("")}
        </div>
      </section>
    `;
    const button = $("inlineQueueOpen");
    if (button) button.addEventListener("click", () => { openModal("queueDialog"); renderQueue(); });
  }

  function renderEvents() {
    const latest = state.events.slice(0, 2);
    const eventsSig = latest.map((e) => `${e.at}|${e.text}`).join("\u0001");
    if (eventsSig !== state._lastEventsSig) {
      state._lastEventsSig = eventsSig;
      $("events").innerHTML = latest.length
        ? latest.map((entry) => `<div class="event-line">[${escapeHtml(entry.at)}] ${escapeHtml(entry.text)}</div>`).join("")
        : '<div class="event-line">保活说明：等待超过保活间隔后，Agent 会收到 KEEPALIVE_NOOP（可能附带数学题或常识题）并重新运行 wait。</div>';
    }
    if (!$("eventDialog").classList.contains("hidden")) {
      const historySig = state.events.length;
      if (historySig !== state._lastHistorySig) {
        state._lastHistorySig = historySig;
        $("eventHistoryList").innerHTML = state.events.length
          ? state.events.map((entry) => `<div class="history-entry"><div class="history-time">${escapeHtml(entry.at)}</div><div class="history-text">${escapeHtml(entry.text)}</div></div>`).join("")
          : '<div class="meta-hint">暂无执行记录。</div>';
      }
    }
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

  function submit() {
    const payload = {
      status: "continue",
      user_input: $("instruction").value,
      selected_choice: undefined,
      file_paths: state.draft.file_paths,
      image_paths: state.draft.image_paths,
      suggested_tools: [],
    };
    send("send", {
      payload,
      targetMode: $("targetMode").value,
      sessionId: state.selectedSessionId,
    });
    $("instruction").value = "";
    state.draft = { file_paths: [], image_paths: [] };
    renderAttachments();
  }

  function saveSettings() {
    send("updateExtensionSettings", {
      settings: {
        maxConcurrentSessions: Number($("setMaxSessions").value || 4),
        schedulingMode: $("setSchedulingMode").value || "direct",
        runtime: $("setRuntime").value || "auto",
        perSessionQueueLimit: Number($("setQueueLimit").value || 3),
        globalQueueLimit: Number($("setGlobalQueueLimit").value || 20),
        keepaliveSeconds: Number($("setKeepalive").value || 300),
        offlineAfterSeconds: Number($("setOfflineAfter").value || 15),
        waitTimeoutSeconds: Number($("setTimeout").value || 0),
        pollSeconds: Number($("setPoll").value || 0.2),
        historyLimit: Number($("setHistoryLimit").value || 200),
        imageLimit: Number($("setImageLimit").value || 50),
        imageMaxDimension: Number($("setImageMaxDimension").value || 0),
        notifyOnAttention: $("setNotifyOnAttention").checked,
        interactiveKeepalive: $("setInteractiveKeepalive").checked,
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

  function renderBridgeStatus() {
    const el = $("bridgeStatus");
    if (!el) return;
    const s = state.bridgeStatus || {};
    const text = s.listening
      ? `Bridge :${s.port} ${s.connected ? "已连接" : "空闲"}`
      : "Bridge 未启动";
    setTextIfChanged(el, text);
    el.className = `meta-chip ${s.listening ? "meta-chip-ready" : ""}`;
  }

  function bindEvents() {
    $("newSession").addEventListener("click", () => send("createSession"));
    $("copyInstruction").addEventListener("click", () => send("copyAgentInstruction", { sessionId: state.selectedSessionId }));
    $("settingsBtn").addEventListener("click", () => { syncSettingsInputs(); openModal("settingsDialog"); });
    $("moreBtn").addEventListener("click", () => openModal("moreDialog"));
    $("send").addEventListener("click", submit);
    $("installRule").addEventListener("click", () => send("installRule"));
    $("startWait").addEventListener("click", () => send("startWait", { sessionId: state.selectedSessionId }));
    $("runDoctor").addEventListener("click", () => send("startDoctor"));
    $("renameSession").addEventListener("click", () => send("renameSessionPrompt", { sessionId: state.selectedSessionId }));
    $("sessionSettingsBtn").addEventListener("click", openSessionSettings);
    $("saveSessionSettings").addEventListener("click", saveSessionSettings);
    $("clearSessionSettings").addEventListener("click", clearSessionSettings);
    $("deleteCurrentSession").addEventListener("click", () => send("deleteSession", { sessionId: state.selectedSessionId }));
    $("stopLoop").addEventListener("click", () => send("stop", { sessionId: state.selectedSessionId }));
    $("clearSelectedQueue").addEventListener("click", () => send("clearQueue", { scope: "session", sessionId: state.selectedSessionId }));
    $("clearGlobalQueue").addEventListener("click", () => send("clearQueue", { scope: "global" }));
    $("eventHistoryBtn").addEventListener("click", () => { renderEvents(); openModal("eventDialog"); });
    $("showEventsBtn").addEventListener("click", () => { renderEvents(); openModal("eventDialog"); });
    $("showTimelineBtn").addEventListener("click", () => { renderTimeline([]); send("requestResultTimeline"); openModal("timelineDialog"); });
    $("showQueueBtn").addEventListener("click", () => { openModal("queueDialog"); renderQueue(); });
    $("installPatch").addEventListener("click", () => send("installRetryPatch"));
    $("uninstallPatch").addEventListener("click", () => send("uninstallRetryPatch"));
    $("saveSettings").addEventListener("click", saveSettings);
    $("pickFiles").addEventListener("click", () => send("pickFiles"));
    $("pickEditor").addEventListener("click", () => send("pickActiveEditor"));
    $("pickWorkspace").addEventListener("click", () => send("pickWorkspaceFolder"));
    $("sessionList").addEventListener("click", (event) => {
      const card = event.target && event.target.closest ? event.target.closest("[data-session-id]") : null;
      if (!card) return;
      state.selectedSessionId = card.dataset.sessionId;
      renderSessions();
      renderQueue();
      const selected = selectedSession();
      $("selectedSessionText").textContent = selected ? `当前会话：${selected.name}` : "当前会话：未选择";
    });
    document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.closeModal)));
    document.querySelectorAll(".modal-layer").forEach((layer) => layer.addEventListener("click", (event) => {
      if (event.target === layer) closeModal(layer.id);
    }));
    $("instruction").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) submit();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") ["moreDialog", "settingsDialog", "eventDialog", "queueDialog", "timelineDialog", "sessionSettingsDialog"].forEach(closeModal);
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
    // Workspace tools
    const wsSummaryBtn = $("workspaceSummaryBtn");
    if (wsSummaryBtn) wsSummaryBtn.addEventListener("click", () => send("workspaceSummary"));
    const wsSearchBtn = $("workspaceSearchBtn");
    if (wsSearchBtn) wsSearchBtn.addEventListener("click", () => {
      const query = $("workspaceSearchInput")?.value?.trim();
      if (query) send("workspaceSearch", { query, maxResults: 50 });
    });
    // Bridge server
    const startBridgeBtn = $("startBridgeBtn");
    if (startBridgeBtn) startBridgeBtn.addEventListener("click", () => send("startBridge"));
    const stopBridgeBtn = $("stopBridgeBtn");
    if (stopBridgeBtn) stopBridgeBtn.addEventListener("click", () => send("stopBridge"));
    const refreshBridgeBtn = $("refreshBridgeBtn");
    if (refreshBridgeBtn) refreshBridgeBtn.addEventListener("click", () => send("getBridgeStatus"));
  }

  window.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type === "filesPicked") addPaths(data.paths || []);
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
    if (data.type === "extensionSettingsSaved") {
      state.settings = data.settings || state.settings || {};
      syncSettingsInputs();
    }
    if (data.type === "sessionCreated" && data.session) {
      state.selectedSessionId = data.session.id;
    }
    if (data.type === "status") renderStatus(data.status || {});
    if (data.type === "event") {
      state.events.unshift({ at: data.at, text: compactText(data.text, 260) });
      if (state.events.length > 100) state.events.length = 100;
      renderEvents();
    }
    if (data.type === "workspaceFiles") {
      state.workspaceFiles = data.files || [];
    }
    if (data.type === "workspaceFileContent") {
      state.workspaceFileContent = data;
    }
    if (data.type === "workspaceSearchResults") {
      state.workspaceSearchResults = data;
    }
    if (data.type === "workspaceSummary") {
      state.workspaceSummary = data.summary || "";
    }
    if (data.type === "bridgeStatus") {
      state.bridgeStatus = data.status || {};
      renderBridgeStatus();
    }
  });

  bindEvents();
  renderEvents();
})();
