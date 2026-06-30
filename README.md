# 续聊助手

这是一个 Cursor 续聊插件。它使用项目内的本地队列，通过 MCP 工具 `wait_for_instruction`（推荐）或 shell 命令 `instruction.js wait`（兜底）桥接 Cursor 官方 Agent 对话，让你可以在插件面板里继续发送指令、引用文件、粘贴图片，并管理多个并行 Agent 会话。

## 1.0.1 主要能力

- 多会话：每个 Cursor 官方 Agent 对话使用一个独立 `session-id`。
- 多队列：支持 `sessions/<session-id>/queue.json` 和 `global_queue.json`。
- 保活：等待超过保活间隔时返回 `KEEPALIVE_NOOP`，提醒 Agent 重新进入 wait，不让对话长时间无输出而中断。
- **自适应心跳**：真实终端（TTY）下保留每秒 `\r` 覆盖式转圈动画；当 stdout 是管道（Agent 经 Shell 工具运行的场景）时改为约每 10 秒输出一行换行心跳，既证明进程活跃避免 Shell 误判超时，又把单个保活周期的捕获噪声从约 300 行降到约 30 行，并消除 `[K` 转义残留。
- **MCP 传输层（推荐）**：`runtime/mcp-server.js` 暴露 MCP 工具 `wait_for_instruction`，阻塞读取同一套队列再返回下一条指令。MCP 工具调用会被 Cursor **原生阻塞等待、不会被模型放到后台**，从根上解决 GPT-5.5 等模型"看到转圈就提前结束本轮"的问题，且同一 request 内免费。面板「更多 → MCP 模式」可一键写入 `.cursor/mcp.json` 并复制 MCP 启动指令；复用现有队列/多会话/调度/转接/状态，零额外依赖。
- 调度：支持当前会话、空闲优先、全部在线广播、轮询分配。
- **自动获取会话标识**：等待进程从 Agent 终端的 `CURSOR_CONVERSATION_ID` 等环境变量自动捕获 Cursor 会话 ID 与工作区标签写入 `status.json`，面板会话卡片上直接显示并可一键复制，无需手动粘贴 request ID，也不读取 Cursor 私有数据库。
- **自动会话标题**：会话名自动取自首条指令的要点，告别"会话 N"；手动重命名后锁定，不再被自动覆盖。
- **会话转接（fork-like）**：断流 / 上下文已满时，一键把未完成的工作交给空闲在线会话继续；自动带上原会话 ID 与预填的续聊上下文注入目标会话，无需任何手填。
- 连接状态：通过每个会话的 heartbeat 判断"已连接 / 离线 / 已消费 / 保活返回"。
- **实时执行状态 + 在线信标（beacon）**：`wait` 会透明地拉起一个与 Agent 终端共存亡的轻量 presence 信标进程，它在 Agent 干活（两次 wait 之间）也持续写心跳，并在启动它的 shell 消失（终端关闭 / 对话被打断）时自动退出。面板据此把会话显示为"执行中"（蓝色脉冲 + 已执行时长）或"已中断 · 终端/对话已关闭"（红色脉冲），中断在约一个心跳间隔内（数秒）被发现，而非误显示离线或干等时间阈值。信标缺失时回退到"执行超时判定秒数"的时间阈值推断。
- 队列治理：支持单会话队列上限、空闲优先队列上限、查看、移除、清空。
- 中文 UI：设置弹窗、更多操作、执行记录、队列弹窗都在独立弹窗中显示。
- 附件：支持引用文件、当前编辑器、工作区目录和粘贴图片。
- 可选本机重试补丁：用于 Cursor 本机官方聊天框发送失败时的自动重试，不作用于 SSH 服务器。
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
│   ├── instruction.js        # shell 兜底运行时
│   ├── mcp-server.js         # MCP 传输层（wait_for_instruction 工具，默认）
│   └── cutc_rules_template.mdc
├── dist/                     # 生成的发布包（不提交 git）
├── reference/                # 参考插件包（不提交 git）
├── LICENSE.txt
├── README.md
└── .gitignore
```

## 安装

从 `dist/` 目录安装最新发布包，或自行打包（见下文）：

1. 在 Cursor 安装 `dist/local-continue-assistant-0.7.6.vsix`。
2. 打开任意项目目录。
3. 打开 `续聊助手` 面板。
4. 点击 `新建会话`，或直接使用默认的 `会话 1`。
5. 点击 `复制当前会话启动指令`，把复制内容发到 Cursor 官方 Agent 对话里。
6. Agent 会按指令在项目终端执行（shell 兜底模式，使用 Node.js 运行时）：

```powershell
node ".../runtime/instruction.js" wait --state-dir ".../.cursor/local-continue-state" --session-id "agent-1" --keepalive 300 --timeout 0 --poll 0.2
```

> 推荐用 MCP 模式：面板「安装 MCP 配置」后完全重启 Cursor，「复制启动指令」会自动给出 MCP 启动指令（更稳，见下）。

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

复制启动指令给远程 Cursor Agent 后，Agent 会在服务器项目终端执行 `instruction.js wait`（或通过 MCP 工具 `wait_for_instruction`）。本机官方聊天框重试补丁只修改本机 Cursor 安装目录，不属于远程服务器能力。

## 开发与打包

```bash
npm install
npm run package
```

打包后的 `.vsix` 会生成在项目根目录，可移入 `dist/` 目录保存。`reference/` 目录存放参考插件包供分析用，两者均不提交 git。

## 更新日志

### 1.0.1

优化与瘦身轮（在 1.0.0 基础上）：

- **移除 HTTP Bridge**：MCP 已覆盖其"实时通信"定位，删除 `BridgeServer` 类、启停命令、面板入口，以及 `instruction.js` 的 bridge 长轮询/参数与 `instruction.py` 的 bridge 配置。
- **移除 Python 运行时**：Node 是默认、MCP 也是 Node，`instruction.py` 已沦为双份手工同步负担，予以删除；`resolveRuntime` 简化为仅 Node，去掉运行时选择设置。（保留 `instruction.js` 作为 shell 兜底，`mcp-server.js` 作为默认 MCP 传输。）
- **移除交互式保活**：删掉保活时附带的数学题/常识题机制，`KEEPALIVE_NOOP` 回归纯净。
- **MCP 不写误导的 conversation_id**：MCP 是窗口级共享进程，不再把共享/空的会话 ID 写进各会话状态。
- **面板模式标识**：顶部新增「模式：MCP / shell」芯片（`mcpInstalled`），并将"复制启动指令"做成智能按钮（装了 MCP 给 MCP 指令，否则给 shell 指令）。
- 说明：评估后**未做**两项——beacon 空闲跳写（会造成"已中断"误闪，收益微小）、extension 复用 instruction.js 类（收益偏内部、改核心风险高）。

### 1.0.0

首个稳定里程碑：以 MCP 为默认传输、shell 为兜底，整合并精简了 0.8.0 引入的 MCP 传输层、在线信标、会话转接、自动会话标识/标题、实时执行状态等能力。

- **MCP 设为默认 + shell 兜底**：顶部主操作精简为「① 安装 MCP 配置」「② 复制启动指令」。「复制启动指令」改为**智能**——项目已装 MCP（`.cursor/mcp.json` 含 local-continue）就给 MCP 启动指令，否则给 shell 指令；用户零决策，装好 MCP 并完全重启 Cursor 后自动升级到 MCP。「会话转接」「复制 MCP/shell 启动指令（显式）」收进「更多」。
- **设置大力精简**：设置弹窗只保留 4 项（最大并发会话数、默认调度策略、保活间隔秒数、关注时弹通知）；其余高级项（队列上限、离线/执行超时判定、轮询间隔、记录/图片上限、运行时、聊天框重试上限、交互保活）改用合理默认值并移出 UI，仍可在 `.cursor/local-continue-state/settings.json` 手改（后端按合并语义保存，隐藏项保留原值不被覆盖）。

### 0.8.0

- **自适应心跳（性能）**：`instruction.js` / `instruction.py` 的等待循环现在用 `isTTY`/`isatty()` 区分场景。真实终端保留每秒 `\r` 转圈；非 TTY（Agent 经 Cursor Shell 工具运行、stdout 为管道）改为约每 10 秒输出一行带 `\n` 的紧凑心跳。单个 300s 保活周期的捕获输出从约 300 行降到约 30 行（~10×），并消除了结果前泄漏的 `[K` 转义残留——Agent 每轮更省上下文，终端捕获文件也更小。
- **Bridge 与文件队列并发（性能）**：HTTP Bridge 模式下的长轮询超时从 30s 收紧到 5s，使等待循环能更快回到文件队列检查；面板写入文件队列的消息在 bridge 模式下的拾取延迟从最坏 30s 降到 ≤5s，仅以少量廉价的本机回环请求为代价（Python 版等待循环本就不轮询 bridge，无需改动）。
- **自动获取会话标识（UX）**：等待进程从 Agent 终端环境变量 `CURSOR_CONVERSATION_ID` / `CURSOR_WORKSPACE_LABEL` 自动捕获 Cursor 会话 ID 与工作区标签，写入 `status.json` 并经 `sessionSummary` 暴露给面板；会话卡片新增可一键复制的会话 ID 芯片（🔗），无需手动粘贴 request ID，也不触碰 Cursor 私有 SQLite。这是"会话转接"功能的自动化基础。
- **自动会话标题（UX）**：会话首次收到指令时自动以其要点命名（`autoTitle`），面板不再只显示"会话 N"；手动重命名会置 `nameManual` 锁定，自动标题不再覆盖。
- **会话转接 / fork-like（UX）**：顶部新增"会话转接"入口与对话框，可把断流 / 上下文已满的来源会话未完成的工作转交给空闲在线的目标会话。转接指令自动携带来源会话的已捕获 Cursor 会话 ID，并用来源会话的最近指令 / 结果自动预填续聊上下文（可编辑），全程零手填；插件不 fork Cursor 对话，而是把"接管"编排成注入目标 waiter 的指令。
- **实时会话状态（UX）**：解决"会话状态只在重新进入 wait 时才更新、Agent 执行中误显示离线、中途中断无人管"的问题。`sessionSummary` 新增 `activity`（idle/queued/working/stalled/offline）、`interruptReason`、`workingAgeMs`、`beaconAlive`；面板用蓝色脉冲点显示"执行中 · 已 N"。`scheduleNext` 在有执行中会话时把定时刷新提速到约 3s，签名加入时间桶使时长实时跳动。新增设置 `workingTimeoutSeconds`（默认 300s）。纯扩展+面板侧推断，无需改运行时即可工作。
- **MCP 传输层（根因修复，推荐）**：新增零依赖、手写 MCP（JSON-RPC over stdio）服务器 `runtime/mcp-server.js`，暴露 `wait_for_instruction`（阻塞读 per-session + global 队列，软超时 ~55min 防 Cursor ~1h 硬切，返回指令/KEEPALIVE_NOOP/SESSION_BUSY，支持 `notifications/cancelled` 取消）与 `report_result` 两个工具，复用 `instruction.js` 的队列/会话/状态机（已把 `instruction.js` 改为可 `require` 复用 + `require.main` 守卫）。因为 MCP 工具调用被 Cursor 原生阻塞等待、不会被模型后台化，从根上修复 GPT-5.5 等模型把 shell `wait` 转后台后提前收工的问题，且同 request 内免费。`extension.js` 新增「更多 → MCP 模式」：`installMcp` 合并写入 `.cursor/mcp.json`（用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`，免 PATH 依赖、本机/远程通用）、`copyMcpInstruction` 复制 MCP 循环启动指令。已端到端验证：initialize / tools/list / tools/call（队列取指令、report_result、软超时 KEEPALIVE）。
- **兼容"会把长命令转后台"的模型（如 GPT-5.5）**：现象是 Agent 运行 wait 后只看到"等待中…1s"就回复"已进入等待循环"并结束本轮——其工具把阻塞命令转入后台并提前交还控制权，模型误以为循环在跑，导致后台 wait 无人读取、保活返回无人接、循环空转死掉。根因是该 bridge 依赖前台阻塞语义（Claude 如此）。修复：在 `buildAgentInstruction` 生成的启动指令与 `cutc_rules_template.mdc` 规则模板中新增"前台阻塞"硬性指引——明确"只看到转圈≠完成、严禁看到转圈就结束本轮、命令被转后台要 await/轮询同一条命令而非另起（否则 SESSION_BUSY）、尽量前台阻塞并把超时设到最大"。需重新"同步项目规则"并重新复制启动指令生效。
- **在线信标 / presence beacon（方案 A）**：把"执行中 vs 中断"的判断从时间阈值升级为真实信号。`instruction.js` / `instruction.py` 新增 `beacon` 子命令；`wait` 交出指令前自动 `spawnBeaconIfNeeded` 拉起一个 detached 信标进程（每会话一个，自带新鲜度去重），它写 `sessions/<id>/presence.json` 心跳，并监控启动它的父 shell PID（`--watch-ppid`）——父 shell 一消失（终端关闭 / 对话中断）就在约一个心跳间隔内自退（含 12h 最长寿命兜底防孤儿）。`sessionSummary` 读 `presence.json`：信标新鲜且无 waiter = 执行中；信标失效 = 已中断（`interruptReason="terminal"`），数秒内可见。Windows 用 `OpenProcess`/`process.kill(0)` 检测进程存活，Node 与 Python 双运行时均已端到端验证（写 presence、父活续命、父死自退）。对 Agent 透明，无需改规则模板。

### 0.7.6

- **高容量断路器（防 OOM）**：P2 从「无限重试」改为「每波 5000 次（~4分钟@50ms）后返回 false 一次」，让请求正常结束、V8 回收对象图，DOM helper 瞬间重置 `globalThis.__lcaNR` 开启下一波。用户无感知（错误被自动隐藏），但 JS 堆不再单调增长
- **定期清除 DOM 累积**：已隐藏的错误节点超过 50 个时，最旧的从 DOM 彻底移除（不只是 `display:none`），回收 DOM 树和 JS 引用内存
- 保留 0.7.4 的自动隐藏错误功能
- 兼容旧安装：检测到 0.7.0/0.7.5 的无限重试或 0.7.2–0.7.4 的有界重试，均自动升级为断路器版本

### 0.7.5

- **恢复原版无限重试**：P2 改回 `()=>!0`（永远返回 true），不再有「重试一定次数后停止」的问题
- 保留 0.7.4 的自动隐藏错误功能：`.composer-warning-popup` 和「Rate limit exceeded / unpaid invoice」等错误气泡自动隐藏，用户看不到
- P3 仍为 50ms 快速重试
- 兼容旧安装：检测到 0.7.2–0.7.4 的有界 P2 会自动改回无限重试

### 0.7.4

- **错误改为自动隐藏（而非退避）**：撤销 0.7.3 的递增退避，P3 改回原版 50ms 快速重试；DOM 脚本新增「自动隐藏」：把 `.composer-warning-popup` 以及「Rate limit exceeded / You have an unpaid invoice」等错误气泡隐藏，用户看不到，重试在后台进行
- 隐藏方式：警告弹窗用 CSS 折叠（仍留在 DOM，不影响重试检测）；错误气泡按特定文本匹配后 `display:none`（只匹配非常具体的错误句，不误伤正常对话）
- 控制台可用 `__lcaRetrySetAutoHide(false)` 临时关闭并恢复被隐藏的消息；`__lcaRetryStats()` 可查看 `autoHide`/`hidden` 计数
- 保留有界 Native 重试（P2），仍不会 OOM

### 0.7.3

- **修复「Rate limit exceeded」频出**：P3 之前把请求层重试间隔死锁为 50ms（~20 次/秒），会触发并持续服务端限流。现改为按每波重试次数递增退避（0.5s → 1.5s → 4s → 8s），既自动重试又不再高频砸服务器
- 说明：0.7.0 原版用无限重试把限流/付费墙等错误永久隐藏（代价是 OOM）；有界重试修好 OOM 后这些错误会到上限后正常冒出，是预期行为
- 兼容旧安装：检测到 50ms 的 P3 会自动升级为退避版本

### 0.7.2

- **修复 0.7.1 的回归**：0.7.1 把 Native 层 P1/P2/P3 全部移除，导致「You have an unpaid invoice」等付费墙/402 错误不再自动重试（付费墙在请求层处理、不会冒出可重试的聊天框警告，DOM 脚本接管不了）
- **改为「有界 Native 重试」**：保留 P1（跳过付费墙 throw）+ P3（50ms 间隔），把 P2 从「永远返回 true（无限重试）」改成「每波最多 `retryMaxRetries` 次后返回 false」——请求随后正常结束、对象图释放，既保留付费墙自动重试又不再 OOM
- **分层重试**：Native 层每波到上限后释放内存并把错误冒到 UI，DOM 脚本作为外层重置 `globalThis.__lcaNR` 计数器、重新发起一波 Native 重试
- 兼容旧安装：检测到 0.7.0 的无限重试补丁会自动升级为有界版本；卸载可还原新旧两种 P2

### 0.7.1

- 移除 Native 层无限重试补丁（P1/P2/P3），改为仅注入有界 DOM 重试脚本（**注意：此版本导致付费墙不再自动重试，已被 0.7.2 修正**）
- 新增 `retryMaxRetries` 设置项：可在面板设置中配置每次失败的重试上限（默认 200，范围 1–1000）

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
