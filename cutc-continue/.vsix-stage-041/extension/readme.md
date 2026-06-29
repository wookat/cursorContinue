# 持续对话助手

Cursor 中文持续对话桥，提供三件事：

- 侧边栏中文输入面板。
- 项目级消息队列、握手和状态反馈。
- 可选的 Cursor 官方聊天框失败重试助手。

## 使用

1. 在 Cursor 安装 `cutc-continue-0.3.0.vsix`。
2. 打开一个项目目录。
3. 打开左侧 `CUTC` 面板。
4. 点击 `给当前项目安装规则`。
5. 在 Cursor Agent 对话里说：`启动 CUTC，按项目规则运行 instruction.py 等待我的下一条指令。`
6. 面板显示 `已连接` 后，在侧边栏输入下一条指令并点击 `发送指令`。

也可以点击 `启动等待终端` 做手动测试。未连接时发送的消息会进入队列，Agent 下次运行
`instruction.py` 时会按顺序消费。

## 连接判断

`instruction.py` 等待时会持续刷新：

```text
.cursor/cutc-state/status.json
```

当 `state=waiting` 且 `heartbeat_ms` 在 5 秒内更新，面板显示 `已连接`。

消息队列在：

```text
.cursor/cutc-state/queue.json
```

每次 Agent 消费一条消息后，会在 `status.json` 写入 `last_ack_id`。

## 官方聊天框重试助手

`安装官方聊天框重试助手` 会给 Cursor 的 `workbench.desktop.main.js` 追加一个有标记的
小脚本，并创建备份。它只在出现可见的 composer 失败提示时尝试重发，默认每轮最多 30 次，
并在官方聊天框附近显示 `CUTC` 状态按钮。

这是可选功能。安装或卸载后需要重启 Cursor。
