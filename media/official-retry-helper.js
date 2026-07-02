// Local Continue Assistant retry helper.
// This script runs inside the local Cursor workbench after the optional patch is installed.
// It watches the official chat UI for visible send-failure warnings and retries conservatively.
;(function () {
  "use strict";
  if (window.__lcaRetryCleanup) window.__lcaRetryCleanup();

  // The extension injects window.__lcaRetryConfig (see patchBlock) so the retry
  // budget is user-configurable. The native P2 is a high-capacity circuit breaker
  // (5000 retries/wave at 50ms, then one GC-friendly completion); this DOM helper
  // is the outer layer that resets globalThis.__lcaNR to instantly restart each
  // wave. maxRetries bounds the DOM helper's outer loop (how many native waves it
  // will restart), not the native layer itself. autoHide keeps transient errors
  // out of view, and purgeHiddenNodes caps DOM memory by removing old hidden
  // error nodes beyond a 50-entry limit.
  const __lcaCfg = (typeof window !== "undefined" && window.__lcaRetryConfig) || {};
  const __lcaMaxRetries = Number(__lcaCfg.maxRetries);

  const CFG = {
    MAX_RETRIES: __lcaMaxRetries > 0 ? __lcaMaxRetries : 200,
    CHECK_THROTTLE_MS: 300,
    POLL_MS: 1200,
    WARNING_GONE_WAIT_MS: 5000,
    SETTLE_MS: 3000,
    SEND_BUTTON_WAIT_MS: 800,
    HIT_DECAY_MS: 3000,
  };

  // Auto-hide the transient failure UI (the composer warning popup and the
  // "Rate limit exceeded" / "You have an unpaid invoice" error bubbles) so the
  // user never sees them while the retry runs in the background. Defaults on; the
  // extension can disable it via window.__lcaRetryConfig.autoHide = false.
  let autoHide = __lcaCfg.autoHide !== false;
  // Phrases that identify the throwaway error bubbles we hide. Kept specific so we
  // never hide a normal conversation message that merely mentions "rate limit".
  const HIDE_PATTERNS = /you've reached the rate limit|reached the rate limit|rate limit exceeded|please wait a bit before trying again|you have an unpaid invoice|unpaid invoice/i;
  // Nodes we hid directly (vs. via the stylesheet), so cleanup can restore them.
  // Capped at 50 to avoid unbounded array growth during long retry sessions.
  const HIDDEN_NODES_MAX = 50;
  const hiddenNodes = [];

  let enabled = true;
  let mode = "IDLE"; // IDLE | HITTING | RETRYING | PAUSED
  let hitCount = 0;
  let totalHits = 0;
  let retryCount = 0;
  let totalRetries = 0;        // cumulative retries across all waves
  let recoverCount = 0;        // waves that recovered after >=1 retry
  let lastRecoverRetries = 0;  // retries the last successful recovery took
  let successFlashUntil = 0;   // show a "✓N" success badge until this time
  let lastHitTime = 0;
  let decayTimer = null;
  let domObserver = null;
  let observeRoot = null;
  let pollTimer = null;
  let checkTimer = null;
  let DEBUG = false;

  const originalFetch = window.fetch;
  const q = (selector, root) => (root || document).querySelector(selector);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = (...args) => { if (DEBUG) console.log("[LCA Retry]", ...args); };

  // --- Active-session sync (① show number on the icon / ② panel auto-select) ---
  // The extension bakes window.__lcaChannel = { base, span, token } into the
  // patch (see patchBlock). We scan the active conversation for the pasted
  // "当前会话 ID：agent-X" line to (①) show the session number on the injected
  // icon and (②) POST it to the loopback channel so the panel selects that
  // session when you switch conversations. Both are best-effort: if the channel
  // is unreachable (e.g. renderer CSP blocks the fetch), ① still works.
  const CH = (typeof window !== "undefined" && window.__lcaChannel) || {};
  const CH_BASE = Number(CH.base) > 0 ? Number(CH.base) : 48090;
  const CH_SPAN = Number(CH.span) > 0 ? Number(CH.span) : 30;
  const CH_TOKEN = CH.token || "";
  const SESSION_RE = /当前会话\s*ID\s*[:：]\s*(agent-[A-Za-z0-9_-]+)/;
  const SESSION_SCAN_MS = 800;
  let chPort = 0;              // cached owner port for the active session
  let lastPushedSession = ""; // last agent id we synced to the panel
  let lastSessionScan = 0;

  function retryGapMs(count) {
    if (count <= 5) return 500;
    if (count <= 20) return 1000;
    if (count <= 50) return 2000;
    return 3000;
  }

  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      const result = originalFetch.apply(this, args);
      result.then((response) => {
        if (response && response.status === 402) onHit402();
      }).catch(() => {});
      return result;
    };
  }

  function onHit402() {
    totalHits += 1;
    hitCount += 1;
    lastHitTime = Date.now();
    if (enabled && mode === "IDLE") mode = "HITTING";
    updateAllButtons();

    if (decayTimer) clearTimeout(decayTimer);
    decayTimer = setTimeout(() => {
      if (mode === "HITTING") {
        hitCount = 0;
        mode = enabled ? "IDLE" : "PAUSED";
        updateAllButtons();
      }
    }, CFG.HIT_DECAY_MS);
  }

  function findFailureBubble() {
    const popup = q(".composer-warning-popup");
    if (popup) {
      const bubble = popup.closest('[data-message-role="human"]');
      if (bubble) return bubble;
    }
    const all = document.querySelectorAll(".composer-sticky-human-message");
    return all.length ? all[all.length - 1] : null;
  }

  function waitFor(selector, { root, timeout = 5000 } = {}) {
    const scope = root || document.body;
    return new Promise((resolve) => {
      const hit = scope.querySelector(selector);
      if (hit) { resolve(hit); return; }
      let done = false;
      let observer = null;
      let timer = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      };
      observer = new MutationObserver(() => {
        const element = scope.querySelector(selector);
        if (element) finish(element);
      });
      observer.observe(scope, { childList: true, subtree: true, attributes: true });
      timer = setTimeout(() => finish(null), timeout);
    });
  }

  function waitForGone(selector, { root, timeout = 5000 } = {}) {
    const scope = root || document.body;
    return new Promise((resolve) => {
      if (!scope.querySelector(selector)) { resolve(true); return; }
      let done = false;
      let observer = null;
      let timer = null;
      const finish = (gone) => {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        clearTimeout(timer);
        resolve(gone);
      };
      observer = new MutationObserver(() => {
        if (!scope.querySelector(selector)) finish(true);
      });
      observer.observe(scope, { childList: true, subtree: true, attributes: true });
      timer = setTimeout(() => finish(false), timeout);
    });
  }

  async function retryOnce() {
    const bubble = findFailureBubble();
    if (!bubble) return false;
    (bubble.querySelector(".composer-human-message") || bubble).click();

    const sendButton = await new Promise((resolve) => {
      const find = () => {
        const current = findFailureBubble();
        return current ? current.querySelector(".send-with-mode .anysphere-icon-button") : null;
      };
      const immediate = find();
      if (immediate) { resolve(immediate); return; }
      let done = false;
      let observer = null;
      let timer = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      };
      observer = new MutationObserver(() => {
        const element = find();
        if (element) finish(element);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      timer = setTimeout(() => finish(null), CFG.SEND_BUTTON_WAIT_MS);
    });

    if (sendButton) {
      sendButton.click();
      return true;
    }

    const editor = bubble.querySelector('.aislash-editor-input[contenteditable="true"]');
    if (editor) {
      editor.focus();
      editor.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }));
      return true;
    }
    return false;
  }

  async function retryWave() {
    if (!enabled || mode === "RETRYING") return;
    mode = "RETRYING";
    retryCount = 0;
    // Reset the native (request-layer) circuit-breaker counter so the click below
    // starts a FRESH native wave. The native P2 retries up to 5000 times then
    // returns false once (letting the request complete and GC run); this DOM wave
    // is the outer layer that instantly restarts it. Without the reset, an
    // exhausted native counter would make the next request give up immediately.
    try { globalThis.__lcaNR = { n: 0, t: Date.now() }; } catch (e) {}
    updateAllButtons();
    log("retry wave started");

    while (enabled && mode === "RETRYING" && retryCount < CFG.MAX_RETRIES) {
      if (!q(".composer-warning-popup")) break;
      retryCount += 1;
      totalRetries += 1;
      updateAllButtons();

      const sent = await retryOnce();
      if (!sent) {
        await sleep(retryGapMs(retryCount));
        continue;
      }

      const gone = await waitForGone(".composer-warning-popup", { timeout: CFG.WARNING_GONE_WAIT_MS });
      if (!enabled || mode !== "RETRYING") return;
      if (!gone) {
        await sleep(retryGapMs(retryCount));
        continue;
      }

      const reappeared = await waitFor(".composer-warning-popup", { timeout: CFG.SETTLE_MS });
      if (!reappeared) break;
      await sleep(retryGapMs(retryCount));
    }

    // Recovered = we did at least one retry and the failure warning is now gone.
    const recovered = retryCount > 0 && !q(".composer-warning-popup");
    if (recovered) {
      lastRecoverRetries = retryCount;
      recoverCount += 1;
      successFlashUntil = Date.now() + SUCCESS_FLASH_MS;
    }
    mode = enabled ? "IDLE" : "PAUSED";
    updateAllButtons();
    // Clear the success flash after it expires.
    if (recovered) setTimeout(updateAllButtons, SUCCESS_FLASH_MS + 80);
    log("retry wave ended", retryCount, recovered ? "(recovered)" : "");
  }

  // Inject (or remove) a stylesheet that visually collapses the composer warning
  // popup. We hide it via CSS instead of removing the node so querySelector still
  // finds it — the retry loop relies on the popup's presence/absence to know when
  // a wave is in flight vs. recovered. Cursor still adds/removes the node itself,
  // so success detection is unaffected.
  function ensureHideStyle() {
    let el = document.getElementById("lca-hide-style");
    if (!autoHide) {
      if (el) el.remove();
      return;
    }
    if (el) return;
    el = document.createElement("style");
    el.id = "lca-hide-style";
    el.textContent = ".composer-warning-popup{opacity:0!important;pointer-events:none!important;max-height:0!important;height:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important;overflow:hidden!important;}";
    (document.head || document.documentElement).appendChild(el);
  }

  // Hide the "Rate limit exceeded" / "unpaid invoice" error bubbles. These render
  // as normal chat content (not the composer popup), so we match them by their
  // very specific error text and hide the closest message bubble. The retry loop
  // is what actually resends; this just keeps the throwaway error out of view.
  // When the hiddenNodes array exceeds HIDDEN_NODES_MAX, the oldest entries are
  // physically removed from the DOM (not just display:none) to reclaim memory.
  function hideErrorBubbles() {
    if (!autoHide) return;
    const scope = q(".conversations") || q(".pane-body") || document.body;
    if (!scope) return;
    const candidates = scope.querySelectorAll('[data-message-index], [data-message-role], [class*="error"], [class*="Error"]');
    candidates.forEach((el) => {
      if (el.dataset && el.dataset.lcaHidden === "1") return;
      const text = el.textContent || "";
      if (text.length > 1200 || !HIDE_PATTERNS.test(text)) return;
      const bubble = el.closest('[data-message-index]') || el.closest('[data-message-role]') || el;
      if (bubble.dataset && bubble.dataset.lcaHidden === "1") return;
      bubble.dataset.lcaHidden = "1";
      bubble.style.setProperty("display", "none", "important");
      hiddenNodes.push(bubble);
      log("hid error bubble");
    });
    purgeHiddenNodes();
  }

  // Remove the oldest hidden nodes from the DOM entirely (not just display:none)
  // when the tracking array exceeds the cap. This reclaims both DOM tree memory
  // and the JS references we hold, preventing unbounded growth during long retry
  // sessions. Nodes beyond the cap are already invisible, so removing them has no
  // visual effect.
  function purgeHiddenNodes() {
    while (hiddenNodes.length > HIDDEN_NODES_MAX) {
      const node = hiddenNodes.shift();
      try { node.remove(); } catch (e) { /* already gone */ }
    }
  }

  function autoDismissRevertDialog() {
    const dialog = q(".pretty-dialog-modal");
    if (!dialog) return;
    dialog.querySelectorAll(".anysphere-secondary-button, .pretty-dialog-button").forEach((button) => {
      if (/Don['’]t revert/.test(button.textContent || "")) {
        button.click();
      }
    });
  }

  function observeRootForComposer() {
    const areas = document.querySelectorAll(".button-container.composer-button-area");
    const area = areas.length ? areas[areas.length - 1] : null;
    if (area) {
      return area.closest(".pane-body") || area.closest(".pane") || area.closest(".split-view-view") || document.body;
    }
    return document.body;
  }

  function ensureObserver() {
    const root = observeRootForComposer();
    if (domObserver && root === observeRoot) return;
    if (domObserver) domObserver.disconnect();
    observeRoot = root;
    domObserver = new MutationObserver(scheduleCheck);
    domObserver.observe(root, { childList: true, subtree: true });
  }

  function scheduleCheck() {
    if (checkTimer) return;
    checkTimer = setTimeout(() => {
      checkTimer = null;
      doChecks();
    }, CFG.CHECK_THROTTLE_MS);
  }

  function doChecks() {
    injectButtons();
    maybeSessionScan();
    ensureHideStyle();
    hideErrorBubbles();
    if (enabled && mode !== "RETRYING" && q(".composer-warning-popup")) {
      retryWave();
    }
  }

  function pollTick() {
    ensureObserver();
    autoDismissRevertDialog();
    doChecks();
  }

  // Icons are described as data, not SVG markup strings, so they can be built with
  // createElementNS (a W3C DOM API that is NOT a Trusted Types sink and renders
  // reliably inside the workbench). The earlier DOMParser/innerHTML approaches were
  // blocked/garbled by the workbench Trusted Types policy and produced an empty dot.
  const SUCCESS_FLASH_MS = 4000;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICON_REFRESH = {
    attrs: { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", "stroke-width": "2.6", "stroke-linecap": "round", "stroke-linejoin": "round" },
    children: [
      { tag: "polyline", attrs: { points: "23 4 23 10 17 10" } },
      { tag: "polyline", attrs: { points: "1 20 1 14 7 14" } },
      { tag: "path", attrs: { d: "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" } },
    ],
    fallback: "\u21bb",
  };
  const ICON_PAUSE = {
    attrs: { viewBox: "0 0 24 24", width: "12", height: "12", fill: "currentColor" },
    children: [
      { tag: "rect", attrs: { x: "6", y: "5", width: "4", height: "14", rx: "1" } },
      { tag: "rect", attrs: { x: "14", y: "5", width: "4", height: "14", rx: "1" } },
    ],
    fallback: "II",
  };
  const ICON_ALERT = {
    attrs: { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", "stroke-width": "2.4", "stroke-linecap": "round", "stroke-linejoin": "round" },
    children: [
      { tag: "path", attrs: { d: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" } },
      { tag: "line", attrs: { x1: "12", y1: "9", x2: "12", y2: "13" } },
      { tag: "line", attrs: { x1: "12", y1: "17", x2: "12.01", y2: "17" } },
    ],
    fallback: "!",
  };
  const ICON_CHECK = {
    attrs: { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", "stroke-width": "3", "stroke-linecap": "round", "stroke-linejoin": "round" },
    children: [
      { tag: "polyline", attrs: { points: "20 6 9 17 4 12" } },
    ],
    fallback: "\u2713",
  };

  function ensureRetryStyles() {
    if (document.getElementById("lca-retry-style")) return;
    const style = document.createElement("style");
    style.id = "lca-retry-style";
    style.textContent = [
      "@keyframes lca-spin { to { transform: rotate(360deg); } }",
      ".lca-retry-btn .lca-ico { display: inline-flex; align-items: center; justify-content: center; }",
      ".lca-retry-btn.lca-spinning .lca-ico { animation: lca-spin 0.8s linear infinite; transform-origin: 50% 50%; }",
      ".lca-retry-btn .lca-num { font-size: 9px; font-weight: 800; line-height: 1; }",
      ".lca-sess { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 20px; padding: 0 6px; margin-left: 2px; box-sizing: border-box; border-radius: 999px; font-size: 10px; font-weight: 800; line-height: 1; color: #e5e7eb; background: rgba(148, 163, 184, 0.28); cursor: pointer; user-select: none; flex-shrink: 0; transition: background 140ms ease; }",
      ".lca-sess:hover { background: rgba(148, 163, 184, 0.45); }",
      ".lca-sess::before { content: '#'; opacity: 0.6; margin-right: 1px; }",
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  function injectButton(area) {
    if (area.querySelector(".lca-retry-btn")) return;
    ensureRetryStyles();
    const button = document.createElement("div");
    button.className = "lca-retry-btn";
    Object.assign(button.style, {
      marginLeft: "2px",
      minWidth: "20px",
      height: "20px",
      padding: "0 5px",
      boxSizing: "border-box",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "3px",
      borderRadius: "999px",
      cursor: "pointer",
      color: "#fff",
      background: "#10b981",
      boxShadow: "0 1px 2px rgba(0, 0, 0, 0.22)",
      flexShrink: "0",
      userSelect: "none",
      transition: "background 140ms ease, filter 140ms ease",
    });
    // Build children with the DOM API instead of innerHTML: the Cursor workbench
    // enforces Trusted Types (`require-trusted-types-for 'script'`), so assigning a
    // raw string to innerHTML throws and the button would never be appended.
    const icoSpan = document.createElement("span");
    icoSpan.className = "lca-ico";
    const numSpan = document.createElement("span");
    numSpan.className = "lca-num";
    numSpan.style.display = "none";
    button.appendChild(icoSpan);
    button.appendChild(numSpan);
    button.onmouseenter = () => { button.style.filter = "brightness(1.12)"; };
    button.onmouseleave = () => { button.style.filter = "none"; };
    button.onclick = (e) => {
      if (e.shiftKey) { DEBUG = !DEBUG; console.log("[LCA Retry] DEBUG=" + DEBUG); return; }
      enabled = !enabled;
      mode = enabled ? "IDLE" : "PAUSED";
      updateAllButtons();
    };
    button.oncontextmenu = (e) => {
      e.preventDefault();
      DEBUG = !DEBUG;
      console.log("[LCA Retry] DEBUG=" + DEBUG);
      console.table(window.__lcaRetryStats ? window.__lcaRetryStats() : {});
    };
    area.appendChild(button);
    updateButton(button);
  }

  // Build an <svg> from an icon spec using createElementNS. This avoids innerHTML
  // (Trusted Types) and DOMParser/importNode (which rendered blank in the workbench).
  function buildIconNode(spec) {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const key in spec.attrs) svg.setAttribute(key, spec.attrs[key]);
    for (const child of spec.children) {
      const el = document.createElementNS(SVG_NS, child.tag);
      for (const key in child.attrs) el.setAttribute(key, child.attrs[key]);
      svg.appendChild(el);
    }
    return svg;
  }

  // Replace the icon node. On any failure fall back to a text glyph so the button is
  // never an empty circle.
  function setIcon(ico, spec) {
    while (ico.firstChild) ico.removeChild(ico.firstChild);
    try {
      ico.appendChild(buildIconNode(spec));
    } catch (error) {
      ico.textContent = spec && spec.fallback ? spec.fallback : "\u00b7";
    }
  }

  function updateButton(button) {
    if (!button) return;
    const ico = button.querySelector(".lca-ico");
    const num = button.querySelector(".lca-num");
    let color;
    let iconType;
    let iconSpec;
    let spinning = false;
    let badge = "";
    if (!enabled || mode === "PAUSED") {
      color = "#94a3b8";
      iconType = "pause";
      iconSpec = ICON_PAUSE;
      button.title = "续聊助手重试：已暂停，点击启用";
    } else if (mode === "RETRYING") {
      color = "#3b82f6";
      iconType = "refresh";
      iconSpec = ICON_REFRESH;
      spinning = true;
      badge = String(retryCount);
      button.title = `续聊助手重试中：${retryCount}/${CFG.MAX_RETRIES}`;
    } else if (mode === "HITTING") {
      color = "#ef4444";
      iconType = "alert";
      iconSpec = ICON_ALERT;
      badge = String(hitCount);
      button.title = `检测到 402：本轮 ${hitCount} 次，累计 ${totalHits} 次`;
    } else if (Date.now() < successFlashUntil) {
      color = "#10b981";
      iconType = "check";
      iconSpec = ICON_CHECK;
      badge = String(lastRecoverRetries);
      button.title = `重试 ${lastRecoverRetries} 次后成功 · 累计成功 ${recoverCount} 次 / 累计重试 ${totalRetries} 次`;
    } else {
      color = "#10b981";
      iconType = "refresh";
      iconSpec = ICON_REFRESH;
      button.title = `续聊助手重试：空闲。累计 402 ${totalHits} 次 · 重试 ${recoverCount} 波 / 共 ${totalRetries} 次` + (lastRecoverRetries ? ` · 上次 ${lastRecoverRetries} 次成功` : "") + "。点击暂停。";
    }
    button.style.background = color;
    // Only rebuild the icon markup when the icon actually changes, so the spin
    // animation never restarts on idle<->retrying transitions or polling.
    if (ico && ico.dataset.icon !== iconType) {
      setIcon(ico, iconSpec);
      ico.dataset.icon = iconType;
    }
    button.classList.toggle("lca-spinning", spinning);
    if (num) {
      if (badge) {
        num.textContent = badge;
        num.style.display = "";
      } else {
        num.textContent = "";
        num.style.display = "none";
      }
    }
  }

  function updateAllButtons() {
    document.querySelectorAll(".lca-retry-btn").forEach(updateButton);
  }

  function injectButtons() {
    document.querySelectorAll(".button-container.composer-button-area").forEach(injectButton);
  }

  // Loopback fetch with a short timeout so a wrong/closed port never hangs the
  // scan. Uses the original (unwrapped) fetch to avoid our 402 interceptor.
  function chFetch(port, pathname, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);
    const options = Object.assign({ signal: controller.signal, cache: "no-store" }, opts || {});
    return originalFetch(`http://127.0.0.1:${port}${pathname}`, options).finally(() => clearTimeout(timer));
  }

  // Find the channel port whose window owns this session. Each Cursor window
  // binds its own port in [base, base+span); we probe the range and pick the one
  // that reports ownership, caching it for next time.
  async function findOwnerPort(agentId) {
    const owns = async (port) => {
      try {
        const res = await chFetch(port, `/lca/ping?session=${encodeURIComponent(agentId)}`);
        if (!res || !res.ok) return false;
        const data = await res.json().catch(() => null);
        return Boolean(data && data.app === "local-continue" && data.owns);
      } catch (e) { return false; }
    };
    if (chPort && await owns(chPort)) return chPort;
    for (let port = CH_BASE; port < CH_BASE + CH_SPAN; port++) {
      if (port === chPort) continue;
      if (await owns(port)) { chPort = port; return port; }
    }
    chPort = 0;
    return 0;
  }

  // ② Tell the panel which session the active conversation belongs to, so it
  // auto-selects it. Only fires when the active session actually changes.
  async function pushActiveSession(agentId) {
    if (!agentId || agentId === lastPushedSession) return;
    let port = 0;
    try { port = await findOwnerPort(agentId); } catch (e) { port = 0; }
    if (!port) return; // channel unavailable — ① (icon number) still works
    try {
      const res = await chFetch(port, "/lca/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, token: CH_TOKEN }),
      });
      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.matched) { lastPushedSession = agentId; log("synced active session", agentId); }
      }
    } catch (e) { /* best effort */ }
  }

  function sessionScopeFor(area) {
    return area.closest(".pane-body") || area.closest(".pane") || area.closest(".split-view-view") || document.body;
  }

  // Pull the pasted "当前会话 ID：agent-X" out of a conversation. Scans human
  // message bubbles (textContent, no reflow) and fast-skips non-matching ones.
  function detectSessionIdIn(scope) {
    if (!scope) return "";
    const nodes = scope.querySelectorAll('.composer-human-message, [data-message-index], [data-message-role="human"]');
    for (const node of nodes) {
      const text = node.textContent || "";
      if (text.indexOf("当前会话") === -1) continue;
      const match = text.match(SESSION_RE);
      if (match) return match[1];
    }
    return "";
  }

  // agent-4-mr0fw2oa -> "4"; falls back to the first few id chars.
  function sessionShortLabel(agentId) {
    const num = /^agent-(\d+)/.exec(agentId);
    if (num) return num[1];
    const rest = /^agent-([A-Za-z0-9]+)/.exec(agentId);
    return rest ? rest[1].slice(0, 4) : agentId;
  }

  function ensureSessionChip(area) {
    let chip = area.querySelector(".lca-sess");
    if (chip) return chip;
    ensureRetryStyles();
    chip = document.createElement("div");
    chip.className = "lca-sess";
    // Clicking the chip re-pushes the session so the user can force the panel to
    // follow this conversation even if the auto-sync didn't fire.
    chip.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = chip.dataset.agentId || "";
      if (id) { lastPushedSession = ""; pushActiveSession(id); }
    };
    const retry = area.querySelector(".lca-retry-btn");
    if (retry) area.insertBefore(chip, retry); else area.appendChild(chip);
    return chip;
  }

  // ① Show the session number on the injected icon for each composer, and return
  // the id of the active (visible) conversation for ② auto-select. Only continue
  // conversations (those with the pasted session id) get a chip; others don't.
  function updateSessionChips() {
    let active = "";
    document.querySelectorAll(".button-container.composer-button-area").forEach((area) => {
      const id = detectSessionIdIn(sessionScopeFor(area));
      let chip = area.querySelector(".lca-sess");
      if (id) {
        if (!chip) chip = ensureSessionChip(area);
        chip.dataset.agentId = id;
        const label = sessionShortLabel(id);
        if (chip.textContent !== label) chip.textContent = label;
        chip.title = `续聊助手会话：${id}（点击在面板选中）`;
        if (area.offsetParent !== null) active = id;
      } else if (chip) {
        chip.remove();
      }
    });
    return active;
  }

  function maybeSessionScan() {
    const now = Date.now();
    if (now - lastSessionScan < SESSION_SCAN_MS) return;
    lastSessionScan = now;
    let active = "";
    try { active = updateSessionChips(); } catch (e) { /* DOM shape changed */ }
    if (active) pushActiveSession(active);
  }

  function bootstrap() {
    if (!document.body) {
      setTimeout(bootstrap, 100);
      return;
    }
    injectButtons();
    maybeSessionScan();
    ensureHideStyle();
    ensureObserver();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollTick, CFG.POLL_MS);
    console.log("[LCA Retry] ready (autoHide=" + autoHide + ")");
  }

  window.__lcaRetryMode = () => mode;
  window.__lcaRetryStats = () => ({
    enabled,
    mode,
    hitCount,
    totalHits,
    retryCount,
    totalRetries,
    recoverCount,
    lastRecoverRetries,
    maxRetries: CFG.MAX_RETRIES,
    autoHide,
    hidden: hiddenNodes.length,
    lastHitTime: lastHitTime ? new Date(lastHitTime).toLocaleString() : "",
  });
  window.__lcaRetrySetAutoHide = (on) => {
    autoHide = !!on;
    ensureHideStyle();
    if (autoHide) {
      hideErrorBubbles();
    } else {
      // Restore everything we hid directly so the user can see past errors again.
      while (hiddenNodes.length) {
        const node = hiddenNodes.pop();
        try { node.style.removeProperty("display"); if (node.dataset) delete node.dataset.lcaHidden; } catch (e) {}
      }
    }
    console.log("[LCA Retry] autoHide=" + autoHide);
  };
  window.__lcaRetryDebug = (on) => { DEBUG = !!on; console.log("[LCA Retry] DEBUG=" + DEBUG); };
  window.__lcaRetrySetEnabled = (on) => {
    enabled = !!on;
    mode = enabled ? "IDLE" : "PAUSED";
    updateAllButtons();
  };
  window.__lcaRetryCleanup = () => {
    mode = "IDLE";
    if (domObserver) { domObserver.disconnect(); domObserver = null; observeRoot = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
    if (decayTimer) { clearTimeout(decayTimer); decayTimer = null; }
    document.querySelectorAll(".lca-retry-btn").forEach((element) => element.remove());
    document.querySelectorAll(".lca-sess").forEach((element) => element.remove());
    const hideStyle = document.getElementById("lca-hide-style");
    if (hideStyle) hideStyle.remove();
    while (hiddenNodes.length) {
      const node = hiddenNodes.pop();
      try { node.style.removeProperty("display"); if (node.dataset) delete node.dataset.lcaHidden; } catch (e) {}
    }
    window.fetch = originalFetch;
    window.__lcaRetryCleanup = null;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
