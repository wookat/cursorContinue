// ===== CC Hook v6.0 — Native Patch 状态指示器 + 兜底守护 =====
// v5: DOM 级自动重试（sendTop 点击失败气泡重发）
// v6: 核心重试由 Native Patch (P1/P2/P3) 在内核层处理，CC Hook 降级为：
//     1. 状态指示器：拦截 fetch 检测 402 → 按钮显示"撞击中"(红) / "空闲"(绿)
//     2. 兜底守护：万一 patch 失效（Cursor 更新覆盖），回退到 DOM 级重试
//     3. Don't revert 对话框自动处理
// 控制台：__ccMode() / __ccDebug(true) / __ccStats()
;(function () {
  'use strict';
  if (window.__ccCleanup) window.__ccCleanup();

  const CFG = {
    // 状态指示器
    INDICATOR_DECAY_MS: 3000,  // 最后一次 402 后多久回到"空闲"
    CHECK_THROTTLE_MS: 250,
    POLL_MS: 1000,

    // 兜底守护（patch 失效时启动）
    FALLBACK_MAX: 1000,
    FALLBACK_RETRY_GAP_MS: 500,
    FALLBACK_DEBOUNCE_MS: 50,
    FALLBACK_GONE_WAIT_MS: 5000,
    FALLBACK_SETTLE_MS: 3000,
    FALLBACK_SEND_WAIT_MS: 800,
  };

  // 状态：'IDLE' | 'HITTING' | 'FALLBACK_RETRYING'
  let mode = 'IDLE';
  let hitCount = 0;          // 当前波次 402 计数
  let totalHits = 0;         // 累计 402 次数
  let lastHitTime = 0;       // 最后一次 402 时间戳
  let fallbackCount = 0;     // 兜底重试计数
  let decayTimer = null;
  let domObserver = null;
  let observeRoot = null;
  let pollTimer = null;
  let checkTimer = null;
  let DEBUG = false;

  const Q = (s, root) => (root || document).querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dbg = (...a) => { if (DEBUG) console.log('[CC]', ...a); };

  // ========== FETCH 拦截：检测 402 响应 ==========
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const p = originalFetch.apply(this, args);
      p.then(function (response) {
        if (response && response.status === 402) {
          try { onHit402(); } catch (_) {}
        }
      }).catch(function () {});
      return p;
    };
  }

  function onHit402() {
    hitCount++;
    totalHits++;
    lastHitTime = Date.now();
    dbg('402 detected #' + totalHits);

    if (mode === 'IDLE') {
      mode = 'HITTING';
      updateAllBtns();
    }

    // 重置衰减计时器
    if (decayTimer) clearTimeout(decayTimer);
    decayTimer = setTimeout(() => {
      if (mode === 'HITTING') {
        mode = 'IDLE';
        hitCount = 0;
        updateAllBtns();
        dbg('衰减 → 空闲（累计 ' + totalHits + ' 次 402）');
      }
    }, CFG.INDICATOR_DECAY_MS);
  }

  // ========== 兜底守护：patch 失效时的 DOM 级重试 ==========
  function findStickyBubble() {
    const popup = Q('.composer-warning-popup');
    if (popup) {
      const bubble = popup.closest('[data-message-role="human"]');
      if (bubble) return bubble;
    }
    const all = document.querySelectorAll('.composer-sticky-human-message');
    return all.length ? all[all.length - 1] : null;
  }

  function waitFor(selector, { root, timeout = 5000 } = {}) {
    const scope = root || document.body;
    return new Promise((resolve) => {
      const hit = scope.querySelector(selector);
      if (hit) { resolve(hit); return; }
      let done = false, ob = null, tid = null;
      const finish = (v) => { if (done) return; done = true; if (ob) ob.disconnect(); clearTimeout(tid); resolve(v); };
      ob = new MutationObserver(() => { const el = scope.querySelector(selector); if (el) finish(el); });
      ob.observe(scope, { childList: true, subtree: true, attributes: true });
      tid = setTimeout(() => finish(null), timeout);
    });
  }

  function waitForGone(selector, { root, timeout = 5000 } = {}) {
    const scope = root || document.body;
    return new Promise((resolve) => {
      if (!scope.querySelector(selector)) { resolve(true); return; }
      let done = false, ob = null, tid = null;
      const finish = (g) => { if (done) return; done = true; if (ob) ob.disconnect(); clearTimeout(tid); resolve(g); };
      ob = new MutationObserver(() => { if (!scope.querySelector(selector)) finish(true); });
      ob.observe(scope, { childList: true, subtree: true, attributes: true });
      tid = setTimeout(() => finish(false), timeout);
    });
  }

  async function sendTop() {
    const bubble = findStickyBubble();
    if (!bubble) { dbg('找不到失败气泡'); return false; }

    (bubble.querySelector('.composer-human-message') || bubble).click();

    const sendBtn = await new Promise((resolve) => {
      const tryFind = () => {
        const b = findStickyBubble();
        return b ? b.querySelector('.send-with-mode .anysphere-icon-button') : null;
      };
      const hit = tryFind();
      if (hit) { resolve(hit); return; }
      let done = false, ob = null, tid = null;
      const finish = (v) => { if (done) return; done = true; if (ob) ob.disconnect(); clearTimeout(tid); resolve(v); };
      ob = new MutationObserver(() => { const el = tryFind(); if (el) finish(el); });
      ob.observe(document.body, { childList: true, subtree: true });
      tid = setTimeout(() => finish(null), CFG.FALLBACK_SEND_WAIT_MS);
    });

    if (sendBtn) { sendBtn.click(); dbg('兜底重发 #' + fallbackCount); return true; }

    const editor = bubble.querySelector('.aislash-editor-input[contenteditable="true"]');
    if (editor) {
      editor.focus();
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
      }));
      dbg('兜底重发 Enter #' + fallbackCount);
      return true;
    }

    return false;
  }

  async function handleFallbackWave() {
    if (mode === 'FALLBACK_RETRYING') return;
    mode = 'FALLBACK_RETRYING';
    fallbackCount = 0;
    updateAllBtns();
    dbg('patch 未生效 → 启动兜底重试');

    await sleep(CFG.FALLBACK_DEBOUNCE_MS);

    while (mode === 'FALLBACK_RETRYING' && fallbackCount < CFG.FALLBACK_MAX) {
      if (!Q('.composer-warning-popup')) break;

      fallbackCount++;
      updateAllBtns();

      const sent = await sendTop();
      if (!sent) { await sleep(CFG.FALLBACK_RETRY_GAP_MS); continue; }

      const gone = await waitForGone('.composer-warning-popup', { timeout: CFG.FALLBACK_GONE_WAIT_MS });
      if (mode !== 'FALLBACK_RETRYING') return;

      if (!gone) {
        await sleep(CFG.FALLBACK_RETRY_GAP_MS);
        continue;
      }

      const reappear = await waitFor('.composer-warning-popup', { timeout: CFG.FALLBACK_SETTLE_MS });
      if (!reappear) { dbg('兜底：本波结束'); break; }
    }

    if (mode === 'FALLBACK_RETRYING') {
      mode = 'IDLE';
      updateAllBtns();
      dbg('兜底完成（重试 ' + fallbackCount + ' 次）');
    }
  }

  // ========== Don't revert 对话框自动处理 ==========
  function autoDismissRevertDialog() {
    const dialog = Q('.pretty-dialog-modal');
    if (!dialog) return;
    const secondary = dialog.querySelector('.anysphere-secondary-button');
    if (secondary && /Don[''']t revert/.test(secondary.textContent || '')) {
      secondary.click();
      dbg("自动点击 Don't revert");
      return;
    }
    dialog.querySelectorAll('.pretty-dialog-button').forEach((b) => {
      if (/Don[''']t revert/.test(b.textContent || '')) {
        b.click();
        dbg("自动点击 Don't revert（文本匹配）");
      }
    });
  }

  // ========== Observer + 轮询 ==========
  function getObserveRoot() {
    const areas = document.querySelectorAll('.button-container.composer-button-area');
    const area = areas.length ? areas[areas.length - 1] : null;
    if (area) {
      const root = area.closest('.pane-body') || area.closest('.pane') || area.closest('.split-view-view');
      if (root) return root;
    }
    return document.body;
  }

  function ensureObserver() {
    const root = getObserveRoot();
    if (domObserver && root === observeRoot) return;
    if (domObserver) domObserver.disconnect();
    observeRoot = root;
    domObserver = new MutationObserver(scheduleCheck);
    domObserver.observe(root, { childList: true, subtree: true });
  }

  function scheduleCheck() {
    if (checkTimer) return;
    checkTimer = setTimeout(() => { checkTimer = null; doChecks(); }, CFG.CHECK_THROTTLE_MS);
  }

  function doChecks() {
    scanAndInject();
    // 兜底：如果弹窗出现说明 patch 没有生效，启动 DOM 级重试
    if (mode !== 'FALLBACK_RETRYING' && Q('.composer-warning-popup')) {
      handleFallbackWave();
    }
  }

  function pollTick() {
    ensureObserver();
    autoDismissRevertDialog();
    if (mode !== 'FALLBACK_RETRYING' && Q('.composer-warning-popup')) {
      handleFallbackWave();
    }
  }

  // ========== 按钮 UI ==========
  function injectButton(area) {
    if (area.querySelector('.cc-btn')) return;
    const b = document.createElement('div');
    b.className = 'cc-btn';
    Object.assign(b.style, {
      marginLeft: '2px', width: '20px', height: '20px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      borderRadius: '50%', cursor: 'pointer',
      fontSize: '9px', fontWeight: '800', letterSpacing: '-0.5px',
      color: '#fff', background: '#27ae60',
      flexShrink: '0', userSelect: 'none',
      transition: 'background 120ms ease',
    });
    b.textContent = 'CC';
    b.title = 'CC: 空闲（Native Patch 守护中）';
    b.onclick = () => { window.__ccDebug(!DEBUG); };
    updateBtn(b);
  }

  function updateBtn(el) {
    if (!el) return;
    if (mode === 'FALLBACK_RETRYING') {
      el.style.background = '#8e44ad';
      el.textContent = String(fallbackCount);
      el.title = '兜底重试 #' + fallbackCount + '（patch 可能未生效）';
    } else if (mode === 'HITTING') {
      el.style.background = '#c0392b';
      el.textContent = String(hitCount);
      el.title = '撞击中 ×' + hitCount + '（内核重试中，累计 ' + totalHits + '）';
    } else {
      el.style.background = '#27ae60';
      el.textContent = 'CC';
      el.title = 'CC: 空闲（累计拦截 ' + totalHits + ' 次 402）';
    }
  }

  function updateAllBtns() { document.querySelectorAll('.cc-btn').forEach(updateBtn); }
  function scanAndInject() { document.querySelectorAll('.button-container.composer-button-area').forEach(injectButton); }

  // ========== 启动 / 卸载 ==========
  function bootstrap() {
    if (!document.body) { setTimeout(bootstrap, 100); return; }
    scanAndInject();
    ensureObserver();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollTick, CFG.POLL_MS);
    console.log('[CC] v6.0 状态指示器 + 兜底守护就绪');
  }

  // ========== 全局控制接口 ==========
  window.__ccMode = () => mode;
  window.__ccStats = () => ({ mode, hitCount, totalHits, fallbackCount, lastHitTime: new Date(lastHitTime).toLocaleString() });
  window.__ccDebug = (on) => { DEBUG = !!on; console.log('[CC] DEBUG=' + DEBUG); };
  window.__ccCleanup = () => {
    mode = 'IDLE';
    if (domObserver) { domObserver.disconnect(); domObserver = null; observeRoot = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
    if (decayTimer) { clearTimeout(decayTimer); decayTimer = null; }
    document.querySelectorAll('.cc-btn').forEach((el) => el.remove());
    window.fetch = originalFetch;
    window.__ccCleanup = null;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
