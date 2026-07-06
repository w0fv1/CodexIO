# Codexio

Codexio 是无数据库、配置驱动的本地 channel 文本中转器。

```bash
pnpm install
pnpm dev
```

开发预览启动后打开 `http://127.0.0.1:8787`。Web 页面、WebSocket 和内部 API 共用同一个 Codexio HTTP 服务。

正式发布物包含 Windows 便携 zip 和 NSIS 安装器。运行 `Codexio.exe` 后，Codexio 会出现在系统托盘，双击托盘图标会用默认浏览器打开对话页面。桌面版配置、运行状态、日志、文件缓存和默认工作区保存在 Electron 用户数据目录。通过安装器安装时，可选择是否清空已有 Codexio 用户数据，默认保留；通过安装器卸载时，可在卸载组件页选择是否删除 Codexio 用户数据，默认保留。

```cmd
pnpm package:windows
```

默认启用 `web` 输入和输出。可启用 `feishu` 长连接输入/输出、`feishuWebhook` 单向输出和 `email` 邮件输入/输出。`server.token` 用于管理接口鉴权，空值会在启动时自动生成并写回。

Codexio 不保存对话记录。WebSocket 新连接只收到 `ready`，消息只有在 channel 输出回显时才显示。

Feishu 开放平台通道只绑定一个群组或私聊会话。启动后，用户先在飞书里给机器人发一条消息，终端会输出 `feishu chat connected: <chat_id>`。需要启动后立即使用固定会话时，把这个值写入配置：

```yaml
channeli:
  feishu:
    enabled: true
    chatId: <chat_id>
channelo:
  feishu:
    enabled: true
    chatId: <chat_id>
```

飞书自定义机器人 Webhook 只支持单向输出：

```yaml
channelo:
  feishuWebhook:
    enabled: true
    url: <webhook_url>
```

邮件通道使用 IMAP 收取未读邮件，使用 SMTP 发送 channel 输出：

```yaml
channeli:
  email:
    enabled: true
    user: user@example.com
    account:
      imap:
        host: imap.example.com
        port: 993
        secure: true
        user: channel@example.com
        password: <password>
        mailbox: INBOX
    idle: true
    pollSeconds: 30
channelo:
  email:
    enabled: true
    user: user@example.com
    account:
      smtp:
        host: smtp.example.com
        port: 465
        secure: true
        user: channel@example.com
        password: <password>
        from: channel@example.com
```

邮件通道只处理来自 `user` 的未读邮件，其他发件人的邮件会被过滤。`idle: true` 时邮件通道使用 IMAP IDLE 长连接等待新邮件，`pollSeconds` 是 IDLE 重启和异常重试间隔；`idle: false` 时才按 `pollSeconds` 做纯轮询。
