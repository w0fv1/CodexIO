FROM docker.io/library/node:22-bookworm-slim AS build

WORKDIR /opt/codexio

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.25.0

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.base.json ./
COPY src ./src
COPY assets ./assets
COPY README.md ./
RUN pnpm build
RUN pnpm prune --prod

FROM docker.io/library/node:22-bookworm-slim

ENV NODE_ENV=production

WORKDIR /opt/codexio

RUN apt-get update && apt-get install -y --no-install-recommends bash bubblewrap ca-certificates curl git jq less nano openssh-client procps python3 make g++ ripgrep tar unzip vim-tiny xz-utils zip && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/codexio/package.json ./package.json
COPY --from=build /opt/codexio/README.md ./README.md
COPY --from=build /opt/codexio/assets ./assets
COPY --from=build /opt/codexio/dist ./dist
COPY --from=build /opt/codexio/node_modules ./node_modules
COPY container/config.yaml ./config.container.yaml
COPY container/entrypoint.sh ./entrypoint.sh

RUN mkdir -p /data /workspace && chmod 755 /opt/codexio/entrypoint.sh

EXPOSE 8787

ENTRYPOINT ["/opt/codexio/entrypoint.sh"]

CMD ["node", "dist/CodexioApplication.js", "--config", "/data/config.yaml"]
