"use strict";

// ---------------------------------------------------------------------------
// retry-patch — installs/uninstalls the Cursor workbench retry patch:
//   - DOM helper injection (PATCH_START/PATCH_END markers)
//   - Native P1/P2/P3 patches to workbench.desktop.main.js
//   - Elevated write on Windows (UAC)
//   - Backup pruning
//   - Auto-reinstall detection after Cursor updates
//
// Depends on vscode, fs-utils (readFileTail, safeUnlink), paths (getPaths),
// settings (readSettings), local-channel (CHANNEL_PORT_*, getChannelToken),
// and shared (nowMs).
// ---------------------------------------------------------------------------

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const { nowMs } = require("../runtime/shared.js");
const { readFileTail, safeUnlink } = require("./fs-utils.js");
const { getPaths } = require("./paths.js");
const { readSettings } = require("./settings.js");
const { CHANNEL_PORT_BASE, CHANNEL_PORT_SPAN, getChannelToken } = require("./local-channel.js");

const PATCH_START = "/* CUTC_CONTINUE_RETRY_PATCH_START */";
const PATCH_END = "/* CUTC_CONTINUE_RETRY_PATCH_END */";
const RETRY_WANTED_KEY = "localContinue.retryPatchWanted";
const RETRY_NATIVE_KEY = "localContinue.retryPatchNative";
const PATCH_AUTO_DISABLED_KEY = "localContinue.nativePatchAutoDisabled";
let retryPatchCache = { at: 0, value: null };

function findCursorAppRoot() {
  const candidates = [];
  if (process.execPath) candidates.push(path.join(path.dirname(process.execPath), "resources", "app"));
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "cursor", "resources", "app"));
  if (process.env.PROGRAMFILES) candidates.push(path.join(process.env.PROGRAMFILES, "cursor", "resources", "app"));
  if (process.env["PROGRAMFILES(X86)"]) candidates.push(path.join(process.env["PROGRAMFILES(X86)"], "cursor", "resources", "app"));
  return candidates.find((candidate) => candidate && fs.existsSync(path.join(candidate, "out", "vs", "workbench", "workbench.desktop.main.js"))) || null;
}

function workbenchPath() {
  const appRoot = findCursorAppRoot();
  return appRoot ? path.join(appRoot, "out", "vs", "workbench", "workbench.desktop.main.js") : null;
}

const RETRY_PATCH_CACHE_MS = 300000;

function detectExternalPatches(target) {
  const conflicts = [];
  if (!target) return conflicts;
  const appRoot = path.resolve(path.dirname(target), "..", "..", "..");
  const workbenchHtml = path.join(appRoot, "out", "vs", "code", "electron-sandbox", "workbench", "workbench.html");
  const cthHook = path.join(appRoot, "out", "vs", "code", "electron-sandbox", "workbench", "cth-autochat-hook.js");
  try {
    const html = fs.existsSync(workbenchHtml) ? fs.readFileSync(workbenchHtml, "utf8") : "";
    if (html.includes("CTH_AUTOCHAT_HOOK_BEGIN") || html.includes("cth-autochat-hook.js") || fs.existsSync(cthHook)) {
      conflicts.push({
        id: "cth-autochat",
        name: "CTH AutoChat",
        detail: "Detected CTH AutoChat workbench hook; it may also retry official chat failures.",
      });
    }
  } catch {
    // Best effort only. A failed conflict scan should never block patch status.
  }
  return conflicts;
}

function getRetryPatchStatus({ force = false } = {}) {
  if (vscode.env.remoteName) return { found: false, installed: false, target: "", remote: true, note: "此功能只作用于本机 Cursor，不作用于远程服务器。" };
  if (!force && retryPatchCache.value && nowMs() - retryPatchCache.at < RETRY_PATCH_CACHE_MS) return retryPatchCache.value;
  const target = workbenchPath();
  let value;
  if (!target) value = { found: false, installed: false, target: "" };
  else {
    try {
      const tail = readFileTail(target, 524288);
      value = { found: true, installed: tail.includes(PATCH_START), target, conflicts: detectExternalPatches(target) };
    } catch (error) {
      value = { found: true, installed: false, target, error: error.message, conflicts: detectExternalPatches(target) };
    }
  }
  retryPatchCache = { at: nowMs(), value };
  return value;
}

// Returns the cheap patch status, plus the P1/P2/P3 detail (from globalState) when
// the patch is installed. Clones so the cached status object is never mutated.
function patchStatusWithNative(context, force) {
  const patch = { ...getRetryPatchStatus({ force }) };
  if (patch.installed && context && context.globalState) {
    const native = context.globalState.get(RETRY_NATIVE_KEY);
    if (native) patch.native = native;
  }
  return patch;
}

// --- Native Patch P1/P2/P3 -------------------------------------------------
const NATIVE_P2_FROM = "getSmokeTestEndlessRetries(){if(this.environmentService.smokeTestNalEndlessRetries)return()=>!0}";
const NATIVE_P2_WAVE_LIMIT = 5000;
const NATIVE_P2_TO = "getSmokeTestEndlessRetries(){return()=>{var g=globalThis,s=g.__lcaNR||(g.__lcaNR={n:0,t:0}),t=Date.now();if(t-s.t>2500)s.n=0;s.t=t;return++s.n<=" + NATIVE_P2_WAVE_LIMIT + "}}";
const NATIVE_P2_TO_LEGACY_INFINITE = "getSmokeTestEndlessRetries(){return()=>!0}";
const NATIVE_P2_TO_BOUNDED = "getSmokeTestEndlessRetries(){return()=>{var g=globalThis,s=g.__lcaNR||(g.__lcaNR={n:0,t:0}),t=Date.now(),c=g.__lcaRetryConfig||{},m=c.maxRetries>0?c.maxRetries:200;if(t-s.t>2500)s.n=0;s.t=t;return++s.n<=m}}";
const NATIVE_P3_FROM = "getSmokeTestRetryDelayMs(){return this.environmentService.smokeTestNalRetryDelayMs}";
const NATIVE_P3_TO = "getSmokeTestRetryDelayMs(){return 50}";
const NATIVE_P3_TO_BACKOFF = "getSmokeTestRetryDelayMs(){var g=globalThis,n=(g.__lcaNR&&g.__lcaNR.n)||0;return n<=2?500:n<=8?1500:n<=20?4000:8000}";
const NATIVE_P1_ORIG = /(\w+) instanceof (\w+)\|\|\1 instanceof (\w+)\|\|\1 instanceof (\w+)\?\{action:"throw",error:\1\}/;
const NATIVE_P1_ORIG_G = /(\w+) instanceof (\w+)\|\|\1 instanceof (\w+)\|\|\1 instanceof (\w+)\?\{action:"throw",error:\1\}/g;
const NATIVE_P1_PATCHED = /(\w+) instanceof (\w+)\|\|!(\w+)&&\1 instanceof (\w+)\|\|\1 instanceof (\w+)\?\{action:"throw",error:\1\}/;
const NATIVE_P1_ENDLESS = /!(\w+)&&\w+>=\w+\?\{action:"throw"/;

function applyNativePatch(content) {
  const notes = [];
  let changed = false;
  let p1 = NATIVE_P1_PATCHED.test(content);
  let p2 = content.includes(NATIVE_P2_TO);
  let p3 = content.includes(NATIVE_P3_TO);
  if (p1) {
    notes.push("P1 已是最新");
  } else {
    const matches = content.match(NATIVE_P1_ORIG_G);
    if (!matches || matches.length === 0) {
      notes.push("P1 未找到匹配（Cursor 版本变化？）");
    } else if (matches.length > 1) {
      notes.push(`P1 匹配到 ${matches.length} 处，有歧义，跳过`);
    } else {
      const ev = NATIVE_P1_ENDLESS.exec(content);
      const endlessVar = ev ? ev[1] : "o";
      const next = content.replace(NATIVE_P1_ORIG, `$1 instanceof $2||!${endlessVar}&&$1 instanceof $3||$1 instanceof $4?{action:"throw",error:$1}`);
      if (next !== content) {
        content = next;
        changed = true;
        p1 = true;
        notes.push("P1 已应用：跳过付费墙 throw");
      } else {
        notes.push("P1 替换失败");
      }
    }
  }
  if (p2) {
    notes.push("P2 已是最新");
  } else if (content.includes(NATIVE_P2_TO_LEGACY_INFINITE)) {
    content = content.replace(NATIVE_P2_TO_LEGACY_INFINITE, NATIVE_P2_TO);
    changed = true;
    p2 = true;
    notes.push("P2 已升级：无限重试 → 高容量断路器（5000次/波，防OOM）");
  } else if (content.includes(NATIVE_P2_TO_BOUNDED)) {
    content = content.replace(NATIVE_P2_TO_BOUNDED, NATIVE_P2_TO);
    changed = true;
    p2 = true;
    notes.push("P2 已升级：有界(200) → 高容量断路器（5000次/波，防OOM）");
  } else if (content.includes(NATIVE_P2_FROM)) {
    content = content.replace(NATIVE_P2_FROM, NATIVE_P2_TO);
    changed = true;
    p2 = true;
    notes.push("P2 已应用：高容量断路器（5000次/波，~4分钟后GC一次）");
  } else {
    notes.push("P2 未找到匹配");
  }
  if (p3) {
    notes.push("P3 已是最新");
  } else if (content.includes(NATIVE_P3_TO_BACKOFF)) {
    content = content.replace(NATIVE_P3_TO_BACKOFF, NATIVE_P3_TO);
    changed = true;
    p3 = true;
    notes.push("P3 已改回：退避 → 50ms（错误改由 DOM 自动隐藏）");
  } else if (content.includes(NATIVE_P3_FROM)) {
    content = content.replace(NATIVE_P3_FROM, NATIVE_P3_TO);
    changed = true;
    p3 = true;
    notes.push("P3 已应用：50ms 快速重试");
  } else {
    notes.push("P3 未找到匹配");
  }
  return { content, changed, p1, p2, p3, notes };
}

function removeNativePatch(content) {
  let changed = false;
  if (content.includes(NATIVE_P2_TO)) {
    content = content.replace(NATIVE_P2_TO, NATIVE_P2_FROM);
    changed = true;
  }
  if (content.includes(NATIVE_P2_TO_LEGACY_INFINITE)) {
    content = content.replace(NATIVE_P2_TO_LEGACY_INFINITE, NATIVE_P2_FROM);
    changed = true;
  }
  if (content.includes(NATIVE_P2_TO_BOUNDED)) {
    content = content.replace(NATIVE_P2_TO_BOUNDED, NATIVE_P2_FROM);
    changed = true;
  }
  if (content.includes(NATIVE_P3_TO)) {
    content = content.replace(NATIVE_P3_TO, NATIVE_P3_FROM);
    changed = true;
  }
  if (content.includes(NATIVE_P3_TO_BACKOFF)) {
    content = content.replace(NATIVE_P3_TO_BACKOFF, NATIVE_P3_FROM);
    changed = true;
  }
  const next = content.replace(NATIVE_P1_PATCHED, '$1 instanceof $2||$1 instanceof $4||$1 instanceof $5?{action:"throw",error:$1}');
  if (next !== content) {
    content = next;
    changed = true;
  }
  return { content, changed };
}

const LEGACY_INJECTION_RE = /\n*\/\/\s*==CC_AUTO_DISMISS==[\s\S]*?\}\)\(\);/g;

function stripLegacyInjections(content) {
  const next = content.replace(LEGACY_INJECTION_RE, "");
  return { content: next, changed: next !== content };
}

function patchBlock(context) {
  const paths = getPaths(context);
  const helper = fs.readFileSync(paths.retryHelper, "utf8");
  let maxRetries = 200;
  try { maxRetries = readSettings(paths).retryMaxRetries; } catch { /* keep default */ }
  const config = `window.__lcaRetryConfig=${JSON.stringify({ maxRetries, autoHide: true })};`;
  const channel = `window.__lcaChannel=${JSON.stringify({ base: CHANNEL_PORT_BASE, span: CHANNEL_PORT_SPAN, token: getChannelToken(context) })};`;
  return `\n;${PATCH_START}\n${config}\n${channel}\n${helper}\n${PATCH_END}\n`;
}

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function elevatedApplyWindows(targetPath, newContentPath, backupPath) {
  const steps = ["$ErrorActionPreference='Stop'"];
  if (backupPath) steps.push(`Copy-Item -LiteralPath ${psSingleQuote(targetPath)} -Destination ${psSingleQuote(backupPath)} -Force`);
  steps.push(`Copy-Item -LiteralPath ${psSingleQuote(newContentPath)} -Destination ${psSingleQuote(targetPath)} -Force`);
  const scriptPath = path.join(os.tmpdir(), `cutc-elevate-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(scriptPath, steps.join("\n"), "utf8");
  try {
    const launcher = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${psSingleQuote(scriptPath)})`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", launcher], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || "").trim() || `提权进程退出码 ${result.status}（可能取消了 UAC 授权）。`);
  } finally {
    safeUnlink(scriptPath);
  }
}

function writeWorkbench(targetPath, content, backupPath) {
  try {
    if (backupPath) fs.copyFileSync(targetPath, backupPath);
    fs.writeFileSync(targetPath, content, "utf8");
  } catch (error) {
    if (process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES")) {
      const tmp = path.join(os.tmpdir(), `cutc-workbench-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
      fs.writeFileSync(tmp, content, "utf8");
      try {
        elevatedApplyWindows(targetPath, tmp, backupPath);
      } finally {
        safeUnlink(tmp);
      }
      return { elevated: true };
    }
    throw error;
  }
  return { elevated: false };
}

function pruneWorkbenchBackups(targetPath, keep = 3) {
  try {
    const dir = path.dirname(targetPath);
    const prefix = `${path.basename(targetPath)}.local-continue-backup-`;
    const backups = fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(dir, name))
      .sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - keep))) safeUnlink(old);
  } catch {
    // Best effort: an extra leftover backup is harmless.
  }
}

function installRetryPatch(context) {
  if (vscode.env.remoteName) throw new Error("重试助手只修改本机 Cursor。请在本机窗口安装。");
  const target = workbenchPath();
  if (!target) throw new Error("没有找到 Cursor workbench.desktop.main.js。");
  const original = fs.readFileSync(target, "utf8");
  const backup = `${target}.local-continue-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const legacy = stripLegacyInjections(original);
  const native = applyNativePatch(legacy.content);
  let content = native.content;
  if (content.includes(PATCH_START)) {
    const start = content.indexOf(`;${PATCH_START}`);
    const end = content.indexOf(PATCH_END, start);
    if (start < 0 || end < 0) throw new Error("补丁标记不完整，已停止更新。");
    content = content.slice(0, start) + patchBlock(context) + content.slice(end + PATCH_END.length);
  } else {
    content = content + patchBlock(context);
  }
  const write = writeWorkbench(target, content, backup);
  pruneWorkbenchBackups(target);
  retryPatchCache = { at: 0, value: null };
  const nativeInfo = { p1: native.p1, p2: native.p2, p3: native.p3, notes: native.notes };
  if (context && context.globalState) {
    context.globalState.update(RETRY_WANTED_KEY, true);
    context.globalState.update(RETRY_NATIVE_KEY, nativeInfo);
  }
  return { target, backup, changed: true, elevated: write.elevated, legacyCleaned: legacy.changed, native: nativeInfo, nativeChanged: native.changed };
}

function uninstallRetryPatch(context) {
  if (vscode.env.remoteName) throw new Error("重试助手只修改本机 Cursor。请在本机窗口卸载。");
  const target = workbenchPath();
  if (!target) throw new Error("没有找到 Cursor workbench.desktop.main.js。");
  let content = fs.readFileSync(target, "utf8");
  let changed = false;
  if (content.includes(PATCH_START)) {
    const start = content.indexOf(`;${PATCH_START}`);
    const end = content.indexOf(PATCH_END, start);
    if (start < 0 || end < 0) throw new Error("补丁标记不完整，已停止卸载。");
    content = content.slice(0, start) + content.slice(end + PATCH_END.length);
    changed = true;
  }
  const reverted = removeNativePatch(content);
  if (reverted.changed) {
    content = reverted.content;
    changed = true;
  }
  const legacy = stripLegacyInjections(content);
  if (legacy.changed) {
    content = legacy.content;
    changed = true;
  }
  if (changed) writeWorkbench(target, content);
  retryPatchCache = { at: 0, value: null };
  if (context && context.globalState) {
    context.globalState.update(RETRY_WANTED_KEY, false);
    context.globalState.update(RETRY_NATIVE_KEY, null);
  }
  return { target, changed };
}

function maybeAutoReinstallPatch(context) {
  if (vscode.env.remoteName) return;
  if (!context.globalState.get(RETRY_WANTED_KEY)) return;
  if (context.globalState.get(PATCH_AUTO_DISABLED_KEY)) return;
  let status;
  try {
    status = getRetryPatchStatus({ force: true });
  } catch {
    return;
  }
  if (!status.found || status.installed) return;
  try {
    const result = installRetryPatch(context);
    if (result.changed && !result.elevated) {
      vscode.window.showInformationMessage(
        "续聊助手：自动重试补丁已自动重新安装，完全重启 Cursor 后生效。",
        "重新加载",
        "稍后",
      ).then((choice) => {
        if (choice === "重新加载") vscode.commands.executeCommand("workbench.action.reloadWindow");
      });
      return;
    }
  } catch (error) {
    // Silent install failed (likely needs elevation) — fall through to prompt.
  }
  vscode.window.showWarningMessage(
    "续聊助手：检测到官方聊天框重试补丁已失效（可能因 Cursor 更新被覆盖），是否重新安装？",
    "立即安装",
    "不再提示",
  ).then((choice) => {
    if (choice === "立即安装") {
      try {
        const result = installRetryPatch(context);
        vscode.window.showInformationMessage(`续聊助手：补丁已重装${result.elevated ? "（已提权）" : ""}，重启 Cursor 生效。`);
      } catch (error) {
        vscode.window.showErrorMessage(`续聊助手：补丁重装失败：${error && error.message ? error.message : error}`);
      }
    } else if (choice === "不再提示") {
      context.globalState.update(PATCH_AUTO_DISABLED_KEY, true);
    }
  });
}

module.exports = {
  PATCH_START,
  PATCH_END,
  RETRY_WANTED_KEY,
  RETRY_NATIVE_KEY,
  getRetryPatchStatus,
  patchStatusWithNative,
  installRetryPatch,
  uninstallRetryPatch,
  maybeAutoReinstallPatch,
};
