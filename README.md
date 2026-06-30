# 续聊助手

这是一个 Cursor 续聊插件。它使用项目内的本地队列和 `instruction.js wait`（或 `instruction.py wait`）桥接 Cursor 官方 Agent 对话，让你可以在插件面板里继续发送指令、引用文件、粘贴图片，并管理多个并行 Agent 会话。

## 0.7.6 主要能力

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

1. 在 Cursor 安装 `dist/local-continue-assistant-0.7.6.vsix`。
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
