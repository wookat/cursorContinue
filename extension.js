"use strict";

// ---------------------------------------------------------------------------
// extension.js — VS Code 扩展入口。
//
// 全部逻辑已拆分到 src/ 下各高内聚模块：
//   paths → settings → sessions → queue → session-status → history →
//   image-utils → instruction-builder → pickers → retry-patch →
//   panel-html → panel-provider
//
// 本文件仅负责注册命令和启动 PanelProvider。
// ---------------------------------------------------------------------------

const vscode = require("vscode");

const { ensureRuntime } = require("./src/paths.js");
const { enqueueToSession } = require("./src/queue.js");
const { dispatchPayload, getAllSessions } = require("./src/session-status.js");
const {
  copyAgentInstruction, startWaitTerminal, startDoctorTerminal, installRule,
} = require("./src/instruction-builder.js");
const {
  installRetryPatch, uninstallRetryPatch, maybeAutoReinstallPatch,
} = require("./src/retry-patch.js");
const { PanelProvider } = require("./src/panel-provider.js");

// Show a QuickPick of existing sessions so command-palette commands don't
// always hard-code "agent-1". Falls back to "agent-1" when there are no
// sessions or the user dismisses the picker.
async function pickSessionId(context) {
  let paths;
  try { paths = ensureRuntime(context); } catch { return "agent-1"; }
  const sessions = getAllSessions(paths);
  if (!sessions.length) return "agent-1";
  const items = sessions.map((s) => ({ label: s.name || s.id, description: s.id, id: s.id }));
  const picked = await vscode.window.showQuickPick(items, { title: "选择会话", placeHolder: "选择要操作的会话" });
  return picked ? picked.id : undefined; // undefined = user cancelled
}

function activate(context) {
  const provider = new PanelProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("localContinue.panel", provider),
    vscode.commands.registerCommand("localContinue.open", () => vscode.commands.executeCommand("workbench.view.extension.local-continue-bottom-panel")),
    vscode.commands.registerCommand("localContinue.openWindow", () => provider.openInWindow(true)),
    vscode.commands.registerCommand("localContinue.installRule", () => vscode.window.showInformationMessage(`项目规则已同步：${installRule(context)}`)),
    vscode.commands.registerCommand("localContinue.copyAgentInstruction", async () => {
      const sessionId = await pickSessionId(context);
      if (!sessionId) return;
      const built = await copyAgentInstruction(context, sessionId);
      vscode.window.showInformationMessage(`续聊助手启动指令已复制（会话 ${built.id}）。`);
    }),
    vscode.commands.registerCommand("localContinue.startWait", async () => {
      const sessionId = await pickSessionId(context);
      if (!sessionId) return;
      startWaitTerminal(context, sessionId);
    }),
    vscode.commands.registerCommand("localContinue.runDoctor", () => startDoctorTerminal(context)),
    vscode.commands.registerCommand("localContinue.sendInstruction", async () => {
      const sessionId = await pickSessionId(context);
      if (!sessionId) return;
      const value = await vscode.window.showInputBox({ title: `发送续聊指令（会话 ${sessionId}）`, ignoreFocusOut: true });
      if (value !== undefined) dispatchPayload(ensureRuntime(context), value, "direct", sessionId);
    }),
    vscode.commands.registerCommand("localContinue.stop", async () => {
      const sessionId = await pickSessionId(context);
      if (!sessionId) return;
      enqueueToSession(ensureRuntime(context), sessionId, { status: "stop", user_input: "stop" }, "command-stop");
    }),
    vscode.commands.registerCommand("localContinue.installRetryPatch", () => vscode.window.showInformationMessage(installRetryPatch(context).changed ? "重试助手已安装，重启 Cursor 后生效。" : "重试助手已经安装。")),
    vscode.commands.registerCommand("localContinue.uninstallRetryPatch", () => vscode.window.showInformationMessage(uninstallRetryPatch(context).changed ? "重试助手已卸载，重启 Cursor 后生效。" : "重试助手未安装。"))
  );
  maybeAutoReinstallPatch(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
