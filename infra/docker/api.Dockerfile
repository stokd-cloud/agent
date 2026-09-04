FROM node:24.15.0-bookworm-slim@sha256:152aceace5c03e2597988763165ee33e3fd3633636db0fc983cd2e126b02cfde AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json packages/protocol/
COPY packages/storage/package.json packages/storage/tsconfig.json packages/storage/
COPY packages/runtime/package.json packages/runtime/tsconfig.json packages/runtime/
COPY apps/api/package.json apps/api/tsconfig.json apps/api/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages/protocol/src packages/protocol/src
COPY packages/storage/src packages/storage/src
COPY packages/runtime/src packages/runtime/src
COPY apps/api/src apps/api/src
RUN pnpm --filter @stokd-cloud/agent-protocol build \
    && pnpm --filter @stokd-cloud/agent-storage build \
    && pnpm --filter @stokd-cloud/agent-runtime build \
    && pnpm --filter @stokd-cloud/agent-api build

FROM node:24.15.0-bookworm-slim@sha256:152aceace5c03e2597988763165ee33e3fd3633636db0fc983cd2e126b02cfde
LABEL org.opencontainers.image.title="Stokd Agent API infrastructure runtime" \
      org.opencontainers.image.version="node-24.15.0-storage-readiness" \
      org.opencontainers.image.base.digest="sha256:152aceace5c03e2597988763165ee33e3fd3633636db0fc983cd2e126b02cfde"
ENV NODE_ENV=production PORT=8080
WORKDIR /opt/workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/protocol ./packages/protocol
COPY --from=build /workspace/packages/storage ./packages/storage
COPY --from=build /workspace/packages/runtime ./packages/runtime
COPY --from=build /workspace/apps/api ./apps/api
COPY infra/runtime/api-entrypoint.sh /usr/local/bin/agent-api-entrypoint
COPY infra/runtime/api-entry.mjs /opt/stokd-agent/api-entry.mjs
# api-entry.mjs shells out to this wrapper for its storage readiness probe, so
# the API image needs it too -- it was previously only in the maintenance image
# and every task died with ENOENT before serving a request. The wrapper only
# needs bash, node and packages/storage, all already present here.
COPY infra/runtime/maintenance-entrypoint.sh /usr/local/bin/stokd-agent-storage-maintenance
RUN chmod 0555 /usr/local/bin/agent-api-entrypoint /opt/stokd-agent/api-entry.mjs /usr/local/bin/stokd-agent-storage-maintenance \
    && install -d -o node -g node -m 0700 /run/stokd-agent
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/agent-api-entrypoint"]
