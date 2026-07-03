# 续聊助手

续聊助手是一个面向 Cursor 的多会话续聊插件。它把 Cursor 官方 Agent 对话和项目内的本地队列连接起来，让你可以在一个面板里管理多个 Agent 会话、继续发送指令、引用文件/文件夹、粘贴图片、转接上下文，并在会话中断或上下文过长时把未完成工作交给另一个会话继续。

推荐使用 MCP 模式：插件提供 `wait_for_instruction` 工具，Cursor 会原生等待工具返回，不容易出现 shell 长命令被模型放到后台后提前结束的问题。shell wait 仍保留为兜底方案。

## 适合场景

- 你在 Cursor 里同时开多个 Agent 对话，希望它们按队列持续领取任务。
- 官方聊天上下文太长或对话断流，需要把任务转接给新的会话。
- 你希望在面板里集中发送任务，而不是反复复制粘贴到不同聊天框。
- 你需要给 Agent 附带文件、文件夹树、当前编辑器内容、工作区范围或图片。
- 你想降低 Cursor 官方聊天框临时失败、限流弹窗对工作流的影响。

## 当前版本

- 插件版本：`1.4.2`
- 发布包：`dist/local-continue-assistant-1.4.2.vsix`
- 默认传输：MCP
- 兜底传输：shell wait

## 核心概念

### 插件会话

插件会话是本地队列里的一个工作槽，例如 `agent-1`、`agent-2`。每个 Cursor 官方 Agent 对话应绑定一个独立插件会话。不要让多个官方对话共用同一个 `agent-X`，否则会争用同一队列和等待锁。

### Cursor 官方会话 ID

Cursor 官方 conversation/composer ID 是 Cursor 自己的对话标识。它不是 `agent-X`。续聊助手会尽量捕获并显示它，用于会话转接和读取官方历史上下文。

获取路径有两种：

- shell waiter 可从 Cursor Agent 终端环境变量 `CURSOR_CONVERSATION_ID` 自动捕获。
- MCP 模式下无法从窗口级 MCP server 直接拿到每个 pane 的环境变量，因此在显式读取详情或转接时，会通过 Cursor 本地 `state.vscdb` 反查包含当前 `agent-X` 启动提示的官方对话。

### 队列

续聊助手维护两类队列：

- `sessions/<session-id>/queue.json`：发给指定会话。
- `global_queue.json`：空闲会话都可以领取，适合“空闲优先”调度。

### wait 循环

Agent 启动后会调用 MCP 工具 `wait_for_instruction`，或执行 shell wait 命令。它会阻塞等待下一条队列任务，拿到任务后交给 Agent 执行；执行完成后，Agent 应再次进入 wait。

## 功能概览

- 多会话：一个面板管理多个 Cursor 官方 Agent 对话。
- 多队列：支持当前会话、空闲优先、全部在线、轮询分配。
- MCP 传输：原生阻塞等待，推荐使用。
- shell 兜底：无需 MCP 时也可通过 Node.js 脚本等待队列。
- 会话状态：显示在线、执行中、可能中断、队列长度、最近结果。
- presence 信标：Agent 干活期间也能判断终端是否仍存活。
- 会话转接：把原会话未完成任务交给目标会话继续，并尽量带上官方 conversation ID 和官方历史摘要。
- 文件上下文：引用文件、文件夹、当前编辑器、工作区。
- 图片粘贴：粘贴图片后自动保存并作为附件发给 Agent。
- 项目目录限定：把某个会话限制在工作区内的某个子项目。
- 独立窗口：面板可移入独立 Cursor 窗口，多窗口共享同一状态。
- 官方聊天框重试补丁：本机 Cursor 聊天框发送失败时自动重试，并显示当前对话所属会话序号。

## 安装

### 从 VSIX 安装

1. 在 Cursor 中打开扩展视图。
2. 选择从 VSIX 安装。
3. 选择：

```text
dist/local-continue-assistant-1.4.2.vsix
```

4. 完全重启 Cursor。
5. 打开任意项目目录。
6. 打开底部面板里的 `续聊助手`。

### 从源码打包

```bash
npm install
npm run package
```

打包产物会生成到 `dist/`：

```text
dist/local-continue-assistant-<version>.vsix
```

## 快速开始：推荐 MCP 模式

### 1. 打开面板

打开 Cursor 项目后，在底部面板找到 `续聊助手`。如果看不到，可以从命令面板运行：

```text
续聊助手：打开面板
```

### 2. 安装 MCP 配置

点击面板顶部的 `MCP` 或在更多菜单里选择安装 MCP 配置。插件会向当前项目写入或合并：

```text
.cursor/mcp.json
```

安装后需要完全重启 Cursor，让 Cursor 重新加载 MCP server。

### 3. 创建或选择会话

默认会有 `会话 1`。也可以点击 `+` 新建更多会话。每个会话卡片对应一个插件 session，例如 `agent-1`。

### 4. 复制启动指令

点击 `复制指令`。如果项目已安装 MCP，复制出来的是 MCP 启动提示；否则会给 shell wait 启动提示。

把这段启动提示发送到 Cursor 官方 Agent 聊天框。

### 5. 等待 Agent 进入循环

Agent 会调用 `wait_for_instruction`，面板中对应会话会显示为在线或等待状态。此后你就可以在面板输入框里给它发任务。

### 6. 发送第一条任务

在面板底部输入任务，例如：

```text
检查当前项目的 README 和 package.json，指出安装说明是否准确。
```

选择发送目标：

- `当前会话`：只发给选中的会话。
- `待分配队列`：发到全局队列，让空闲会话领取。
- `全部在线`：发给所有在线会话。
- `轮询分配`：按顺序分配给未满队列的会话。

点击 `发送` 或按 `Ctrl+Enter`。

### 7. Agent 完成后继续 wait

Agent 执行完任务后，应再次调用 `wait_for_instruction` 等待下一条任务。插件会在每轮指令里追加循环提醒，避免 Agent 做完一轮就停止。

## 使用教程

### 教程一：单会话续聊

1. 打开项目。
2. 打开 `续聊助手` 面板。
3. 点击 `MCP` 安装配置。
4. 完全重启 Cursor。
5. 点击 `复制指令`。
6. 将指令发送给 Cursor 官方 Agent。
7. 等面板显示会话在线。
8. 在面板输入任务并发送到 `当前会话`。

适合一个 Agent 持续处理同一个项目任务。

### 教程二：多会话并行

1. 点击 `+` 创建多个会话，例如 `会话 1` 到 `会话 6`。
2. 分别给不同 Cursor 官方聊天框复制不同会话的启动指令。
3. 每个官方聊天框进入 wait 后，面板会显示多个在线会话。
4. 把任务发送到 `待分配队列` 或使用 `轮询分配`。

建议：

- 每个官方聊天框只使用自己的启动指令。
- 不要把 `agent-1` 的启动指令复制给多个官方聊天框。
- 多会话越多，越应该使用 MCP 模式，减少 shell 超时和后台化问题。

### 教程三：引用文件和文件夹

发送任务前可以添加上下文：

- `引用文件`：选择一个或多个文件。
- `引用文件夹`：选择文件夹后，插件会渲染封顶目录树。
- `当前编辑器`：附带当前打开文件。
- `工作区`：附带工作区目录树。
- 粘贴图片：直接在面板里粘贴截图。

示例任务：

```text
根据我引用的文件夹结构，找出配置入口和启动流程，并给出重构建议。
```

文件夹渲染会跳过 `.git`、`node_modules` 等重目录，并限制深度和条数，避免上下文过大。

### 教程四：限定会话到某个子项目

适合一个工作区里包含多个项目的情况。

1. 在会话卡片右侧点击 `...`。
2. 选择 `设置项目目录...`。
3. 选择工作区内的某个子目录。
4. 之后该会话收到的每条任务都会自动带上项目范围提示。

卡片上会显示项目目录芯片。需要取消时，打开同一菜单选择取消项目目录限定。

### 教程五：会话转接

当原会话上下文太长、对话断流或已经不适合继续时，可以转接给另一个会话。

1. 准备一个目标会话，最好是在线且空闲。
2. 在源会话卡片右侧点击 `...`。
3. 选择 `会话转接...`。
4. 检查来源会话和目标会话。
5. 填写转接原因，例如：

```text
上下文已满，需要新会话继续完成剩余修改。
```

6. 检查自动预填的续聊上下文。
7. 点击转接。

转接指令会尽量包含：

- 原 Cursor 官方 conversation/composer ID。
- 原会话最近指令和最近结果。
- 可从 Cursor SQLite 读取到的官方历史摘要。
- 你补充的转接原因和续聊上下文。

示例转接内容：

```text
会话转接：请接管原会话「修复 MCP 循环」未完成的任务。
原 Cursor 官方 conversation ID：abc123...
转接原因：上下文已满，需要继续优化 README 和发布流程。

== 原会话完整历史（40 条消息，修复 MCP 循环）==
Cursor 官方 conversation ID：abc123...

[用户] ...
[AI] ...

请基于以上内容继续完成该任务；完成后照常进入 wait 等待循环。
```

### 教程六：安装官方聊天框重试补丁

重试补丁只作用于本机 Cursor 官方聊天框，不作用于 Remote SSH 服务器。

1. 打开更多菜单。
2. 点击 `注入图标 / 修复`。
3. 按提示完成安装。
4. 完全退出并重启 Cursor。

安装后：

- 官方聊天框发送失败时会自动重试。
- 注入图标旁会显示当前对话对应的会话序号，例如 `#3`。
- 切换官方聊天 pane 时，插件面板会尽量自动选中对应会话。

如果本机回环通道被渲染进程 CSP 拦截，自动选中可能失效，但序号显示仍可工作。

### 教程七：打开独立窗口

点击顶部的独立窗口按钮，或运行命令：

```text
续聊助手：在独立窗口打开面板
```

插件会在编辑器区打开一个 WebviewPanel，并尝试移入新 Cursor 窗口。多个面板窗口共享同一份队列和状态。

## MCP 模式说明

MCP server 位于：

```text
runtime/mcp-server.js
```

主要工具：

- `wait_for_instruction`：等待并领取下一条任务。
- `report_result`：上报执行结果。
- `get_status`：读取当前会话/队列状态。

MCP 模式的优势：

- Cursor 原生等待工具返回。
- 不容易被模型当作后台 shell 命令。
- 多会话共用同一套本地队列。
- 1.4.2 起，全局队列 watcher/cache 在 MCP server 内共享，多个 session 不会重复 stat/read `global_queue.json`。

## shell 兜底模式

如果未安装 MCP，复制启动指令会生成类似命令：

```powershell
node ".../runtime/instruction.js" wait --state-dir ".../.cursor/local-continue-state" --session-id "agent-1" --keepalive 300 --timeout 0 --poll 0.2
```

shell 模式会通过心跳输出避免 Cursor Shell 工具误判超时。如果 Cursor 返回 `Waited briefly` 或 `Will resume when background shell exits`，这不一定表示失败，规则模板会要求 Agent 继续等待或重新进入 wait。

## 会话状态说明

状态文件位于：

```text
.cursor/local-continue-state/sessions/<session-id>/status.json
```

常见状态：

- 在线/空闲：waiter 正在等待任务。
- 待消费：会话在线且队列里有任务。
- 执行中：Agent 已领取任务，presence 信标仍活跃。
- 已中断：信标失效或终端/对话关闭。
- 离线：没有新鲜 heartbeat。

## Remote SSH

在 Remote SSH 场景下，应在远程 Cursor 窗口安装并启用插件。状态目录保存在远程项目内：

```text
.cursor/local-continue-state/
```

注意：

- MCP 配置写入远程项目的 `.cursor/mcp.json`。
- shell wait 会在远程项目终端执行。
- 官方聊天框重试补丁只修改本机 Cursor 安装目录，不属于远程服务器能力。
- 如果要使用本机官方聊天框补丁，请在本机 Cursor 环境安装。

## 常见问题

### 为什么会话显示离线？

可能原因：

- Agent 没有进入 wait。
- Cursor 对话或终端已关闭。
- MCP 配置安装后没有完全重启 Cursor。
- 当前会话被另一个官方聊天框错误复用了同一个 `agent-X`。

处理方式：

1. 重新复制该会话启动指令。
2. 发到对应官方 Agent 对话。
3. 等它调用 `wait_for_instruction`。

### 为什么目标会话没有拿到转接上下文？

检查：

- 目标会话是否在线或至少有队列空间。
- 源会话是否捕获到了 Cursor 官方 conversation ID。
- 当前环境是否能读取 Cursor 的 `state.vscdb`。

即使读取不到官方历史，转接也会携带最近指令、最近结果和你手动补充的上下文。

### 为什么官方 conversation ID 和 agent-X 不一样？

`agent-X` 是插件本地会话 ID，用于队列路由。Cursor 官方 conversation/composer ID 是 Cursor 内部对话 ID，用于定位官方聊天历史。转接上下文优先使用官方 ID。

### 为什么 README 里的 VSIX 不提交到 git？

项目 `.gitignore` 忽略了 `dist/` 和 `*.vsix`。发布包保留在本地，源码、版本号和 README 提交到 git。

## 配置说明

常用设置可在面板设置里修改：

- 最大并发会话数。
- 默认调度策略。
- 保活间隔秒数。
- 关注状态通知。

高级设置保存在：

```text
.cursor/local-continue-state/settings.json
```

包括队列上限、离线判定、执行超时、轮询间隔、历史记录上限、图片上限等。

## 项目结构

```text
CursorContinue/
├── extension.js
├── package.json
├── package-lock.json
├── README.md
├── LICENSE
├── media/
│   ├── extension-icon.png
│   ├── icon.svg
│   ├── panel.css
│   ├── panel.js
│   └── official-retry-helper.js
├── src/
│   ├── cursor-history.js
│   ├── fs-utils.js
│   ├── history.js
│   ├── image-utils.js
│   ├── instruction-builder.js
│   ├── local-channel.js
│   ├── panel-html.js
│   ├── panel-provider.js
│   ├── paths.js
│   ├── pickers.js
│   ├── queue.js
│   ├── retry-patch.js
│   ├── session-status.js
│   ├── sessions.js
│   └── settings.js
├── runtime/
│   ├── cutc_rules_template.mdc
│   ├── instruction.js
│   ├── mcp-server.js
│   └── shared.js
├── dist/
└── reference/
```

模块分层：

```text
runtime/shared.js
  -> src/fs-utils.js
  -> src/paths.js / src/settings.js / src/sessions.js / src/queue.js
  -> src/session-status.js / src/history.js / src/image-utils.js / src/pickers.js
  -> src/instruction-builder.js / src/retry-patch.js / src/cursor-history.js
  -> src/panel-html.js / src/panel-provider.js
  -> extension.js
```

## 开发

安装依赖：

```bash
npm install
```

语法检查示例：

```bash
node --check runtime/mcp-server.js
node --check media/panel.js
node --check src/panel-provider.js
```

打包：

```bash
npm run package
```

生成的 VSIX 位于 `dist/`。

## 发布流程

1. 更新 `package.json` 和 `package-lock.json` 版本号。
2. 更新 README 的当前版本、安装包名和更新日志。
3. 运行关键 JS 的 `node --check`。
4. 运行 `npm run package`。
5. 安装生成的 VSIX 做 smoke test。
6. 提交源码和文档。
7. 推送到远端。

Marketplace 发布需要 VSCE publisher token，本仓库默认只生成本地 VSIX。

## 更新日志

完整版本历史已移到 [CHANGELOG.md](CHANGELOG.md)。README 只保留当前版本要点。

### 1.4.2

多会话性能与官方上下文转接增强：

- MCP server 内新增全局队列共享 watcher/cache，多个 session 复用一次 `global_queue.json` stat/read 唤醒；实际领取仍在锁内完成，避免抢消息。
- 官方聊天框 helper 使用 pane 级 `WeakMap` 缓存 `{ agentId, title }`，并通过 `/lca/active` 把标题同步给插件侧。
- 启动指令使用 `会话 N` 作为官方聊天标题种子，减少 “MCP bridge conversation” 这类自动命名。
- 转接流程强化 Cursor 官方 conversation/composer ID 展示和注入，便于目标会话按官方 ID 定位原上下文。
