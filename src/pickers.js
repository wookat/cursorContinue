"use strict";

// ---------------------------------------------------------------------------
// pickers — VS Code file/folder picker dialogs and active-editor helper.
// Thin wrappers around vscode.window.showOpenDialog / activeTextEditor.
// ---------------------------------------------------------------------------

const vscode = require("vscode");

async function pickFiles() {
  const uris = await vscode.window.showOpenDialog({ title: "选择要引用的文件或文件夹", canSelectFiles: true, canSelectFolders: true, canSelectMany: true });
  return (uris || []).map((uri) => uri.fsPath);
}

async function pickFolders() {
  // Kept for backward compatibility — now delegates to pickFiles since the
  // merged picker already allows folder selection.
  return pickFiles();
}

async function pickProjectFolder(paths) {
  const uris = await vscode.window.showOpenDialog({
    title: "选择该会话负责的项目目录",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: paths.workspaceRoot ? vscode.Uri.file(paths.workspaceRoot) : undefined,
    openLabel: "设为项目目录",
  });
  return uris && uris[0] ? uris[0].fsPath : undefined;
}

function pickActiveEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error("当前没有打开的编辑器文件。");
  return editor.document.uri.fsPath;
}

module.exports = {
  pickFiles,
  pickFolders,
  pickProjectFolder,
  pickActiveEditor,
};
