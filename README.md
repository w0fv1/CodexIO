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

默认配置写入 `~/.codexio/config.yaml`，默认启用 `web` 通道，可启用 `feishu` 长连接通道。
`codexio` 和 `codexio serve` 是同一个 host 启动入口。
`pnpm bundle` 生成未来 exe 使用的单文件 Node bundle，产物不入库。
每次启动 codexio 后，Codex 的第一条消息都会创建新 session；同一进程内的后续消息会继续当前 session。`/$ clear` 会开启新对话。
Codex 子进程的 stdout/stderr 会同步输出到启动 codexio 的终端。

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

网页输入框支持清空命令，命令不会发送给 Codex：

```text
/$ clear
/$$ /$ clear
```
