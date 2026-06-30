# 续聊助手

这是一个 Cursor 续聊插件。它使用项目内的本地队列和 `instruction.js wait`（或 `instruction.py wait`）桥接 Cursor 官方 Agent 对话，让你可以在插件面板里继续发送指令、引用文件、粘贴图片，并管理多个并行 Agent 会话。

## 0.7.0 主要能力

- 多会话：每个 Cursor 官方 Agent 对话使用一个独立 `session-id`。
- 多队列：支持 `sessions/<session-id>/queue.json` 和 `global_queue.json`。
- 保活：等待超过保活间隔时返回 `KEEPALIVE_NOOP`，提醒 Agent 重新进入 wait，不让对话长时间无输出而中断。
- **交互式保活**：开启后，`KEEPALIVE_NOOP` 会附带数学题或常识题（如"3+5=?"），让 Agent 保持活跃而不只是空转。
- **转圈心跳**：等待期间每秒在 stdout 输出转圈动画和计时（`\r` 覆盖同一行），让 Shell 工具看到进程活跃，避免误判超时。
- **HTTP Bridge 模式**：可选的实时通信模式，通过 `--bridge-port` 和 `--bridge-secret` 参数启动，延迟比文件轮询更低。
- 调度：支持当前会话、空闲优先、全部在线广播、轮询分配。
- 连接状态：通过每个会话的 heartbeat 判断"已连接 / 离线 / 已消费 / 保活返回"。
- 队列治理：支持单会话队列上限、空闲优先队列上限、查看、移除、清空。
- 中文 UI：设置弹窗、更多操作、执行记录、队列弹窗都在独立弹窗中显示。
- 附件：支持引用文件、当前编辑器、工作区目录和粘贴图片。
- 可选本机重试补丁：用于 Cursor 本机官方聊天框发送失败时的自动重试，不作用于 SSH 服务器。
- 双运行时：`instruction.js`（Node.js，默认）和 `instruction.py`（Python，备选），Agent 可任选其一。
- fs.watch 事件驱动：队列文件变化即时通知，无需依赖轮询；自适应退避策略在空闲时降低唤醒频率。
- 性能优化：stat 签名缓存、DOM diff 渲染、CSS containment、正则预编译、紧凑 JSON 序列化等。
- **强规则模板**：`alwaysApply: true`，包含 Shell 超时行为说明、Cursor 超时信号识别（`Waited briefly` / `Will resume`）、禁止短语、系统目录保护等硬性指令。

## 项目结构

```text
cursorContinue/
├── extension.js              # 插件主代码
├── package.json              # 插件配置
├── package-lock.json         # 依赖锁定
├── media/                    # 插件 UI 资源
│   ├── icon.svg
│   ├── panel.css
│   ├── panel.js
│   └── official-retry-helper.js
├── runtime/                  # Agent 运行时脚本
│   ├── instruction.js
│   ├── instruction.py
│   └── cutc_rules_template.mdc
├── dist/                     # 生成的发布包（不提交 git）
├── reference/                # 参考插件包（不提交 git）
├── LICENSE.txt
├── README.md
└── .gitignore
```

## 安装

从 `dist/` 目录安装最新发布包，或自行打包（见下文）：

1. 在 Cursor 安装 `dist/local-continue-assistant-0.7.0.vsix`。
2. 打开任意项目目录。
3. 打开 `续聊助手` 面板。
4. 点击 `新建会话`，或直接使用默认的 `会话 1`。
5. 点击 `复制当前会话启动指令`，把复制内容发到 Cursor 官方 Agent 对话里。
6. Agent 会按指令在项目终端执行（默认使用 Node.js 运行时）：

```powershell
node ".../runtime/instruction.js" wait --state-dir ".../.cursor/local-continue-state" --session-id "agent-1" --keepalive 300 --timeout 0 --poll 0.2
```

如果偏好 Python，也可使用：

```powershell
py ".../runtime/instruction.py" wait --state-dir ".../.cursor/local-continue-state" --session-id "agent-1" --keepalive 300 --timeout 0 --poll 0.2
```

7. 面板显示在线后，你就可以在插件输入框里发送下一条指令。

## 多会话用法

- 一个 Cursor 官方 Agent 对话对应一个插件会话。
- 不要让多个 Agent 对话共用同一个 `session-id`。
- `当前会话`：只发给选中的会话。
- `空闲优先`：写入全局队列，任意会话下一次 wait 都可以消费。
- `全部在线`：发给所有在线会话。
- `轮询分配`：按会话顺序分配到未满队列的会话。

## 连接判断

会话 wait 运行时会持续写入：

```text
.cursor/local-continue-state/sessions/<session-id>/status.json
```

当 `state=waiting` 且 `heartbeat_ms` 未超过设置里的"会话离线判定秒数"，面板显示该会话在线。消费消息后，状态会写入 `last_ack_id` 和 `last_message_preview`，面板据此显示上一条是否已消费。

## 设置说明

- 最大并发会话数：限制可以创建多少个会话。
- 默认调度策略：控制发送框默认投递到哪里。
- 单会话队列上限：限制每个会话积压的消息数量。
- 空闲优先队列上限：限制全局队列积压的消息数量。
- 保活间隔秒数：多久没有新消息时返回 `KEEPALIVE_NOOP`。
- **保活时发送数学题/常识题**：开启后保活消息附带交互题，让 Agent 保持活跃。
- 会话离线判定秒数：heartbeat 多久没更新就显示离线。
- 等待超时秒数：`0` 表示不因等待超时退出，只靠保活返回。
- 队列轮询间隔秒数：`instruction.js wait` 检查队列的间隔（有 fs.watch 时仅作安全网）。
- 保留执行记录条数 / 粘贴图片张数：限制本地状态目录体积。

## Shell 超时处理

Cursor Shell 工具可能在脚本实际完成前就返回超时（如 `Waited briefly`、`Will resume when background shell exits`）。这是正常行为，不是脚本失败。规则模板中已包含详细说明，Agent 看到这些信号后会静默重新运行 wait 命令。

脚本运行时会显示转圈心跳动画（每秒刷新），让 Shell 工具看到进程活跃：

```
[续聊助手] 会话 agent-1 已进入等待状态，正在轮询队列…
⠹ [续聊助手] 等待中… 6s
```

## Remote SSH

如果用 Cursor Remote SSH 连接服务器，应在远程窗口安装并启用该插件。规则、队列、图片和状态都会保存在远程项目的：

```text
.cursor/local-continue-state/
```

复制启动指令给远程 Cursor Agent 后，Agent 会在服务器项目终端执行 `instruction.js wait`（或 `instruction.py wait`）。本机官方聊天框重试补丁只修改本机 Cursor 安装目录，不属于远程服务器能力。

## 开发与打包

```bash
npm install
npm run package
```

打包后的 `.vsix` 会生成在项目根目录，可移入 `dist/` 目录保存。`reference/` 目录存放参考插件包供分析用，两者均不提交 git。

## 更新日志

### 0.7.0

- 新增转圈心跳：等待期间每秒在 stdout 输出转圈动画和计时，避免 Shell 工具误判超时
- 新增交互式保活：`KEEPALIVE_NOOP` 可附带数学题/常识题
- 新增 HTTP Bridge 模式：通过 `--bridge-port`/`--bridge-secret` 参数实现实时通信
- 新增 `interactiveKeepalive` 设置项（面板设置弹窗可切换）
- 增强规则模板：`alwaysApply: true`，加入 Cursor 超时信号识别、Shell 超时行为说明、禁止短语
- 修复 `startBridge`/`stopBridge` 命令复用已有 PanelProvider 实例
- 同步 Python 版本支持交互式保活和 Bridge 模式

### 0.6.0

- 新增 HTTP Bridge 服务（面板可启停）
- 新增工作区摘要命令
- 新增会话重命名和会话级参数覆盖
- 优化 fs.watch 事件驱动和自适应轮询退避

### 0.5.2

- 初始版本：多会话、多队列、保活、调度、附件、重试补丁、双运行时
