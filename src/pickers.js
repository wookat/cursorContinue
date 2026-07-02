"use strict";

// Thin wrappers around vscode.window.showOpenDialog / activeTextEditor.

const vscode = require("vscode");
const fs = require("fs");

async function pickFiles() {
  const uris = await vscode.window.showOpenDialog({
    title: "选择要引用的文件",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    openLabel: "引用文件",
  });
  return (uris || []).map((uri) => uri.fsPath);
}

async function pickFolders() {
  const uris = await vscode.window.showOpenDialog({
    title: "选择要引用的文件夹",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: "引用文件夹",
  });
  return (uris || []).map((uri) => uri.fsPath);
}

async function pickAttachmentPaths() {
  const uris = await vscode.window.showOpenDialog({
    title: "选择要引用的文件或文件夹",
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: "引用",
  });
  const result = { filePaths: [], folderPaths: [] };
  for (const uri of uris || []) {
    const fsPath = uri.fsPath;
    try {
      if (fs.statSync(fsPath).isDirectory()) result.folderPaths.push(fsPath);
      else result.filePaths.push(fsPath);
    } catch {
      result.filePaths.push(fsPath);
    }
  }
  return result;
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
  pickAttachmentPaths,
  pickProjectFolder,
  pickActiveEditor,
};
