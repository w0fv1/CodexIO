# Codexio

Codexio 是无数据库、配置驱动的 coding agent 文本中转器。

```bash
pnpm install
pnpm dev
```

开发预览启动后打开 `http://127.0.0.1:8787`。Web 页面、WebSocket 和内部 API 共用同一个 Codexio HTTP 服务。

正式安装包通过 Windows Service 运行：

```cmd
install.cmd
start.cmd
```

停止、重启或卸载服务：

```cmd
stop.cmd
restart.cmd
uninstall.cmd
```

默认配置写入项目内 `.codexio/config.yaml`。默认启用 `web` 通道，可启用 `feishu` 长连接通道、`feishuWebhook` 单向通道和 `email` 邮件通道。`server` 是 Codexio HTTP 服务，`channels.web` 控制是否启用网页输入输出。配置里的 `server.token` 是 agent 写入 `/api/agent/message` 的内部 token，空值会在启动时自动生成并写回。
默认 workspace 是项目内 `.codexio/workspace`。`workspace.path` 支持绝对路径、相对配置文件所在目录的路径，也支持 `~` 和 `~/Desktop` 这类用户目录路径。
`pnpm dev` 会直接启动 Codexio server。日志会输出在当前终端，按 `Ctrl+C` 会停止 server。
`pnpm bundle` 生成未来 exe 使用的单文件 Node bundle，产物不入库。
运行日志按天写入 `.codexio/log/YYYY-MM-DD.log`，本机日志目录不会进入发布包。
Codexio 使用原生多 thread 模型。Web 通道会为每个对话生成并传递 threadId，Agent 在首次收到该 thread 的消息时创建对应 Codex thread。`$ clear` 或 `￥ clear` 会清空当前 thread 并为该 thread 创建新的 Codex 对话。
Codex 子进程的 stdout/stderr 会同步输出到启动 codexio 的终端。
内置 agent 默认按完全访问模式运行：Codex 使用 `danger-full-access` 和 `never` approval，Claude 使用 `bypassPermissions`。

Codex 默认使用 Codexio 随包携带的 `@openai/codex`。如需接入本机公共 Codex CLI，并共享 Codex App、VS Code Codex 使用的账号和配置，把 `agents.codex.bundled` 改为 `false`：

```yaml
agents:
  codex:
    enabled: true
    bundled: false
```

Feishu 开放平台通道只绑定一个群组或私聊会话。启动后，用户先在飞书里给机器人发一条消息，终端会输出 `feishu chat connected: <chat_id>`。需要启动后立即使用固定会话时，把这个值写入配置：

```yaml
channels:
  feishu:
    enabled: true
    chatId: <chat_id>
```

飞书自定义机器人 Webhook 只支持单向输出：

```yaml
channels:
  feishuWebhook:
    enabled: true
    url: <webhook_url>
```

邮件通道使用 IMAP 收取未读邮件，使用 SMTP 发送 agent 输出：

```yaml
channels:
  email:
    enabled: true
    user: user@example.com
    agent:
      imap:
        host: imap.example.com
        port: 993
        secure: true
        user: agent@example.com
        password: <password>
        mailbox: INBOX
      smtp:
        host: smtp.example.com
        port: 465
        secure: true
        user: agent@example.com
        password: <password>
        from: agent@example.com
    idle: true
    pollSeconds: 30
```

邮件通道只处理来自 `user` 的未读邮件，其他发件人的邮件会被过滤。

`idle: true` 时邮件通道使用 IMAP IDLE 长连接等待新邮件，`pollSeconds` 是 IDLE 重启和异常重试间隔；`idle: false` 时才按 `pollSeconds` 做纯轮询。

Host 会先启动内部 API 和 channel，再异步启动 agent。Codex 未登录时，登录链接会通过已启动的通道发出。

正式安装包启动时会自动检查 Codexio 最新版本。检查只读取公开版本元数据，不下载文件、不自动安装；发现新版本时，会提示到 `https://next.firco.cn/manage/nfirco/release` 后台发布页面下载。

当前 agent 状态接口：

```text
GET /api/status
```

Agent 输出接口：

```text
POST /api/agent/message
```

`/api/agent/message` 只用于 agent 把文本交给所有前端通道，不用于外部把文本交给 agent。
调用时需要带内部 token：

```text
Authorization: Bearer <server.token>
```

网页输入框支持清空命令，命令不会发送给 Codex：

```text
$ clear
$clear
￥ clear
￥clear
```
