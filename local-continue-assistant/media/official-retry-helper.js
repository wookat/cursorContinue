// Local Continue Assistant retry helper.
// This script runs inside the local Cursor workbench after the optional patch is installed.
// It watches the official chat UI for visible send-failure warnings and retries conservatively.
;(function () {
  "use strict";
  if (window.__lcaRetryCleanup) window.__lcaRetryCleanup();

  const CFG = {
    MAX_RETRIES: 200,
    CHECK_THROTTLE_MS: 300,
    POLL_MS: 1200,
    WARNING_GONE_WAIT_MS: 5000,
    SETTLE_MS: 3000,
    SEND_BUTTON_WAIT_MS: 800,
    HIT_DECAY_MS: 3000,
  };

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

  function bootstrap() {
    if (!document.body) {
      setTimeout(bootstrap, 100);
      return;
    }
    injectButtons();
    ensureObserver();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollTick, CFG.POLL_MS);
    console.log("[LCA Retry] ready");
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
    lastHitTime: lastHitTime ? new Date(lastHitTime).toLocaleString() : "",
  });
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
    window.fetch = originalFetch;
    window.__lcaRetryCleanup = null;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
