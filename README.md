# Codexio

Codexio 是无数据库、配置驱动的 coding agent 文本中转器。

```bash
pnpm install
pnpm dev
```

开发预览启动后打开 `http://127.0.0.1:8787`。

登录当前启用的 agent：

```bash
pnpm run login
```

Codex 登录使用控制台设备码流程，只输出登录链接和验证码，不主动打开浏览器。
当前内置 Claude CLI 没有暴露控制台-only 登录参数，所以 `claude` agent 不执行自动登录。

`pnpm login` 是 pnpm 自己的 npm registry 登录命令，不会执行项目脚本。

正式运行：

```bash
pnpm build
pnpm start -- init
pnpm start
```

默认配置写入项目内 `.codexio/config.yaml`，默认启用 `web` 通道，可启用 `feishu` 长连接通道、`feishuWebhook` 单向通道和 `email` 邮件通道。配置里的 `server.token` 是 agent 写入 `/api/message` 的内部 token，空值会在启动或初始化配置时自动生成并写回。
默认 workspace 是项目内 `.codexio/workspace`。`workspace.path` 支持绝对路径、相对 codexio 项目根目录的路径，也支持 `~` 和 `~/Desktop` 这类用户目录路径。
`codexio` 和 `codexio serve` 是同一个 host 启动入口。
`pnpm bundle` 生成未来 exe 使用的单文件 Node bundle，产物不入库。
每次启动 codexio 后，Codex 的第一条消息都会创建新 session；同一进程内的后续消息会继续当前 session。`/$ clear` 会开启新对话。
Codex 子进程的 stdout/stderr 会同步输出到启动 codexio 的终端。
内置 agent 默认按完全访问模式运行：Codex 使用 `danger-full-access` 和 `never` approval，Claude 使用 `bypassPermissions`。

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

Host 会先启动 HTTP 和 channel，再异步启动 agent。Codex 未登录时，登录链接会通过已启动的通道发出；新打开的网页会恢复最近 20 条临时消息。

当前 agent 状态接口：

```text
GET /api/status
```

Agent 输出接口：

```text
POST /api/message
```

`/api/message` 只用于 agent 把文本交给所有前端通道，不用于外部把文本交给 agent。
调用时需要带内部 token：

```text
Authorization: Bearer <server.token>
```

网页输入框支持清空命令，命令不会发送给 Codex：

```text
/$ clear
/$$ /$ clear
```
