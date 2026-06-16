# Codexio

Codexio 是无数据库、配置驱动的 coding agent 文本中转器。

```bash
pnpm install
pnpm build
pnpm --filter @codexio/cli start -- init
pnpm --filter @codexio/cli start -- config proxy set --http http://127.0.0.1:7890 --https http://127.0.0.1:7890 --socks socks5://127.0.0.1:7890
pnpm --filter @codexio/cli start -- serve
```

默认配置写入 `~/.codexio/config.yaml`，默认启用 `web` 和 `cli` 本地通道。
