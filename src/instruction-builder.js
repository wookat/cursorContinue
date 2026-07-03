"use strict";

// ---------------------------------------------------------------------------
// instruction-builder — generates the shell/MCP start instructions that the
// user pastes into a Cursor conversation, installs MCP config, installs
// project rules, and opens wait/doctor terminals.
//
// Depends on vscode (clipboard, terminal), paths, settings, sessions,
// session-status, and fs-utils.
// ---------------------------------------------------------------------------

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const { readJson } = require("./fs-utils.js");
const {
  ensureRuntime, runtimeWaitCommand, runtimeDoctorCommand, resolveRuntime,
} = require("./paths.js");
const { readSettings } = require("./settings.js");
const { effectiveSessionSettings } = require("./sessions.js");
const { resolveInstructionSession } = require("./session-status.js");

function titleInstruction(sessionId) {
  return `可以把 Cursor 右侧官方会话标题设置成一句短标题（建议 8-18 个中文字符），只用于你在 Cursor 内辨认本次任务；本地面板标题由面板编号/本地重命名控制，不读取 Cursor 标题。当前 session_id="${sessionId}"。`;
}

function buildAgentInstruction(context, sessionId) {
  const paths = ensureRuntime(context);
  const settings = readSettings(paths);
  const resolved = resolveInstructionSession(paths, settings, sessionId);
  const id = resolved.id;
  const waitCmd = runtimeWaitCommand(paths, effectiveSessionSettings(paths, settings, id), id);
  const text = `请从现在开始使用"续聊助手"的 shell bridge 循环工作。

当前会话 ID：${id}

具体要求：
1. 正常完成当前这轮任务，并设置本会话标题：${titleInstruction(id)}
2. 每轮任务结束后，不要调用 input()，也不要让我在终端手动输入。
3. 第一次进入等待时，请在当前项目终端运行下面这条命令：

\`\`\`powershell
${waitCmd}
\`\`\`

4. 之后每完成一轮任务、重新进入等待时，请在同一条命令后面加上 --report，把刚做完的事用一句话反馈给面板（状态用 done/need_input/error）：

\`\`\`powershell
${waitCmd} --report "一句话说明刚完成或遇到的情况" --report-status done
\`\`\`

   如果需要我做决定或补充信息，用 --report-status need_input；如果失败，用 error。面板会高亮该会话并提醒我。

**重要 · 前台阻塞，别提前收工**：wait 是会一直阻塞的命令，可能几秒到几分钟。运行后你必须**停在本轮**、等它自己返回结果（KEEPALIVE_NOOP / 一条指令 / SESSION_BUSY / stop / timeout）才算这一轮结束。
   - 只看到 \`[续聊助手] 等待中… Ns\` 转圈**不代表完成**，那只是心跳。**绝不要**因为看到转圈就回复"已进入等待循环 / 后台已在运行"之类然后结束本轮——那样循环会空转死掉。
   - 如果你的工具把命令放到后台并提前把控制权还给你（你只看到转圈、没有上面任一结果），它**还在运行**：请继续等待 / 重新查看**同一个后台命令**的输出（await/轮询同一条命令）直到它打印出结果，**不要另起一条新的 wait**（会 SESSION_BUSY）。
   - 请尽量用**前台 / 阻塞**方式运行，并把超时设到你的工具支持的**最长值**（如 timeout=0 或很大的值）。
5. 如果输出以 KEEPALIVE_NOOP 开头，表示当前没有新的用户指令。不要修改项目，请立即重新运行 wait 命令（可不带 --report），让本对话保持活跃。
6. 如果输出普通文本、文件上下文或图片上下文，请执行收到的指令；执行完成后回到第 3/4 步继续等待。图片上下文会给出本地图片文件路径，请用读取文件工具打开查看。
7. 如果收到 stop，结束这个会话循环。
8. 如果输出以 SESSION_BUSY 开头（或包含 another instruction waiter is already active），说明本 session-id 已被另一个对话占用。不要重复运行 wait、也不要去结束其它进程；请用 --report-status need_input 反馈，并提醒我为本对话改用唯一的 session-id（或在面板新建会话后重开本循环），然后停止本轮等待。`;
  return { id, text, created: resolved.created };
}

async function copyAgentInstruction(context, sessionId) {
  const built = buildAgentInstruction(context, sessionId);
  await vscode.env.clipboard.writeText(built.text);
  return built;
}

// Write/merge the MCP server entry into the project's .cursor/mcp.json so Cursor
// launches the 续聊助手 MCP server. Uses the host's own node-capable binary
// (process.execPath + ELECTRON_RUN_AS_NODE=1) so it works without `node` on PATH,
// locally and over Remote-SSH alike. Existing servers in the file are preserved.
function installMcpConfig(context) {
  const paths = ensureRuntime(context);
  if (!fs.existsSync(paths.mcpServerJs)) throw new Error(`找不到 MCP 服务器脚本：${paths.mcpServerJs}`);
  const config = readJson(paths.mcpConfig, {});
  const root = config && typeof config === "object" ? config : {};
  if (!root.mcpServers || typeof root.mcpServers !== "object") root.mcpServers = {};
  root.mcpServers["local-continue"] = {
    command: process.execPath,
    args: [paths.mcpServerJs, "--state-dir", paths.stateDir],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  fs.mkdirSync(path.dirname(paths.mcpConfig), { recursive: true });
  fs.writeFileSync(paths.mcpConfig, JSON.stringify(root, null, 2), "utf8");
  return { target: paths.mcpConfig };
}

function buildMcpInstruction(context, sessionId) {
  const paths = ensureRuntime(context);
  const settings = readSettings(paths);
  const resolved = resolveInstructionSession(paths, settings, sessionId);
  const id = resolved.id;
  const text = `请从现在开始使用"续聊助手"的 MCP bridge 循环工作。

当前会话 ID：${id}

具体要求：
1. 正常完成当前这轮任务，并设置本会话标题：${titleInstruction(id)}
2. 每轮任务结束后，调用 MCP 工具 \`wait_for_instruction\`（参数 session_id="${id}"，可附带 report 用一句话反馈刚做完的事、report_status 用 done/need_input/error）来等待下一条指令。这是 MCP 工具调用，会被 Cursor 原生阻塞等待；本模式不要运行 shell wait 命令。
3. 按 \`wait_for_instruction\` 的返回值处理（工具还会返回结构化字段 \`kind\` 和 \`next_action\`，优先据此判断）：
   - \`kind=instruction\`（普通文本，含文件/图片上下文）→ 当作用户指令执行；执行完回到第 2 步**再次调用** \`wait_for_instruction\`。
   - \`kind=keepalive\`（以 \`KEEPALIVE_NOOP\` 开头）→ 当前没有新指令，**不要修改项目、不要结束本轮**，立即**再次调用** \`wait_for_instruction\`。
   - \`kind=cancelled\` / \`kind=error\` → 不是致命错误，请**再次调用** \`wait_for_instruction\` 重试，不要结束本轮。
   - \`kind=session_busy\`（以 \`SESSION_BUSY\` 开头）→ 本 session_id 被另一个对话占用，请改用唯一 session_id 或在面板新建会话后重开，不要反复重试。
   - \`kind=stop\` → 结束本会话循环。
   - 经验法则：只要 \`next_action=call_wait_for_instruction\`，就继续调用。
4. 不要调用 input()，也不要让我在终端手动输入；所有新指令都来自面板。
5. **绝不要因为"已调用工具 / 已进入等待 / 任务已完成"就提前结束本轮**：无论你是刚执行完一条指令、还是自认为任务已彻底做完，都必须**立即再次调用** \`wait_for_instruction\`。是否结束由我的 \`stop\` 决定，不由你决定——只有收到 \`stop\` 才结束循环。
6. 不要执行或生成 shell 版启动命令；只有用户明确要求 shell 模式时才使用终端命令。
7. 图片上下文会给出本地图片文件路径，请用读取文件工具打开查看。`;
  return { id, text, created: resolved.created };
}

async function copyMcpInstruction(context, sessionId) {
  const built = buildMcpInstruction(context, sessionId);
  await vscode.env.clipboard.writeText(built.text);
  return built;
}

// True when this project's .cursor/mcp.json already registers our MCP server.
function mcpConfigStatus(paths) {
  try {
    const cfg = readJson(paths.mcpConfig, null);
    const entry = cfg && cfg.mcpServers && cfg.mcpServers["local-continue"];
    if (!entry) {
      return { installed: false, current: false, stale: false, target: paths.mcpConfig, reason: "missing" };
    }
    const args = Array.isArray(entry.args) ? entry.args : [];
    const stateIdx = args.indexOf("--state-dir");
    const serverArg = args.find((arg) => String(arg).replace(/\\/g, "/").endsWith("/runtime/mcp-server.js")) || "";
    const stateArg = stateIdx >= 0 ? args[stateIdx + 1] || "" : "";
    const norm = (value) => {
      try { return path.resolve(String(value || "")).toLowerCase(); }
      catch { return String(value || "").toLowerCase(); }
    };
    const serverMatches = norm(serverArg) === norm(paths.mcpServerJs);
    const stateMatches = norm(stateArg) === norm(paths.stateDir);
    const current = Boolean(serverMatches && stateMatches);
    return {
      installed: true,
      current,
      stale: !current,
      target: paths.mcpConfig,
      server: serverArg,
      stateDir: stateArg,
      expectedServer: paths.mcpServerJs,
      expectedStateDir: paths.stateDir,
      reason: !serverMatches ? "server-path" : !stateMatches ? "state-dir" : "",
    };
  } catch {
    return { installed: false, current: false, stale: false, target: paths.mcpConfig, reason: "unreadable" };
  }
}

function mcpInstalled(paths) {
  return mcpConfigStatus(paths).installed;
}

// The "smart" copy used by the top bar: hand back the MCP start instruction once
// the MCP server is installed in this project, otherwise the shell one. This way
// the single primary button always yields a command that works right now -- no
// transport choice for the user, and it auto-upgrades to MCP after install+restart.
async function copySmartInstruction(context, sessionId) {
  const paths = ensureRuntime(context);
  if (mcpInstalled(paths)) {
    const built = await copyMcpInstruction(context, sessionId);
    return { ...built, mode: "mcp" };
  }
  const built = await copyAgentInstruction(context, sessionId);
  return { ...built, mode: "shell" };
}

function startWaitTerminal(context, sessionId) {
  const paths = ensureRuntime(context);
  const settings = readSettings(paths);
  const resolved = resolveInstructionSession(paths, settings, sessionId);
  const id = resolved.id;
  const terminal = vscode.window.createTerminal({ name: `续聊助手 ${id}`, cwd: paths.workspaceRoot });
  terminal.show(true);
  terminal.sendText(runtimeWaitCommand(paths, effectiveSessionSettings(paths, settings, id), id));
  return resolved;
}

function startDoctorTerminal(context) {
  const paths = ensureRuntime(context);
  const settings = readSettings(paths);
  const terminal = vscode.window.createTerminal({ name: "续聊助手 doctor", cwd: paths.workspaceRoot });
  terminal.show(true);
  terminal.sendText(runtimeDoctorCommand(paths, settings));
}

function installRule(context) {
  const paths = ensureRuntime(context);
  const template = fs.readFileSync(paths.template, "utf8");
  const settings = readSettings(paths);
  const runtime = resolveRuntime(paths, settings);
  const content = template
    // Function replacements so values containing $ (e.g. $&, $1 in a path) are
    // inserted literally instead of being treated as replacement patterns.
    .replaceAll("{{PYTHON_COMMAND}}", () => runtime.bin)
    .replaceAll("{{RUNTIME_COMMAND}}", () => runtime.bin)
    .replaceAll("{{INSTRUCTION_PATH}}", () => runtime.script)
    .replaceAll("{{RUNTIME_SCRIPT}}", () => runtime.script)
    .replaceAll("{{STATE_DIR}}", () => paths.stateDir)
    .replaceAll("{{KEEPALIVE_SECONDS}}", String(settings.keepaliveSeconds))
    .replaceAll("{{WAIT_TIMEOUT_SECONDS}}", String(settings.waitTimeoutSeconds))
    .replaceAll("{{POLL_SECONDS}}", String(settings.pollSeconds));
  fs.mkdirSync(path.dirname(paths.rule), { recursive: true });
  fs.writeFileSync(paths.rule, content, "utf8");
  return paths.rule;
}

module.exports = {
  buildAgentInstruction,
  copyAgentInstruction,
  installMcpConfig,
  buildMcpInstruction,
  copyMcpInstruction,
  mcpConfigStatus,
  mcpInstalled,
  copySmartInstruction,
  startWaitTerminal,
  startDoctorTerminal,
  installRule,
};
