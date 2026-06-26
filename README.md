# Codexio

Codexio 是无数据库、配置驱动的 coding agent 文本中转器。

```bash
pnpm install
pnpm dev
```

开发预览启动后打开 `http://127.0.0.1:8787`。Web 页面、WebSocket 和内部 API 共用同一个 Codexio HTTP 服务。

正式安装包通过 Electron 托盘运行，没有内置主窗口。启动 Codexio 后会出现在系统托盘，双击托盘图标会用默认浏览器打开对话页面。

```cmd
pnpm package:windows
```

托盘右键菜单提供“对话”“配置”“重启”“更新”“退出”。“对话”和“配置”都会使用系统默认浏览器打开 Codexio HTTP 服务页面。

开发模式默认配置写入项目内 `.codexio/config.yaml`。Electron 安装包默认配置写入当前用户的 Codexio 应用数据目录。默认启用 `web` 通道，可启用 `feishu` 长连接通道、`feishuWebhook` 单向通道和 `email` 邮件通道。`server` 是 Codexio HTTP 服务，`channels.web` 控制是否启用网页输入输出。配置里的 `server.token` 用于管理接口鉴权，空值会在启动时自动生成并写回。
默认 workspace 是配置文件所在目录下的 `workspace`。`workspace.path` 支持绝对路径、相对配置文件所在目录的路径，也支持 `~` 和 `~/Desktop` 这类用户目录路径。
`pnpm dev` 会直接启动 Codexio server。日志会输出在当前终端，按 `Ctrl+C` 会停止 server。
运行日志按天写入 `.codexio/log/YYYY-MM-DD.log`，本机日志目录不会进入发布包。
Codexio 使用原生多 thread 模型。Web 通道会为每个对话生成并传递 threadId，Agent 在首次收到该 thread 的消息时创建对应 Codex thread。
Codex 子进程的 stdout/stderr 会同步输出到启动 codexio 的终端。
内置 agent 默认按完全访问模式运行：Codex 使用 `danger-full-access` 和 `never` approval，Claude 使用 `bypassPermissions`。

Codex 默认使用本机公共 Codex CLI。Electron 托盘以当前用户身份运行，因此会共享 Codex App、VS Code Codex 使用的账号和配置。如需使用 Codexio 随包携带的 `@openai/codex`，把 `agents.codex.bundled` 改为 `true`：

```yaml
agents:
  codex:
    enabled: true
    bundled: true
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

正式安装包启动时会自动检查 Codexio 最新版本。发现新版本时会提示使用系统托盘“更新”；托盘更新由 Electron 主进程执行。

当前 agent 状态接口：

```text
GET /api/status
```
