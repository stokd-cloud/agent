FROM node:24.15.0-bookworm-slim@sha256:152aceace5c03e2597988763165ee33e3fd3633636db0fc983cd2e126b02cfde AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json packages/protocol/
COPY packages/storage/package.json packages/storage/tsconfig.json packages/storage/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages/protocol/src packages/protocol/src
COPY packages/storage/src packages/storage/src
RUN pnpm --filter @stokd-cloud/agent-protocol build \
    && pnpm --filter @stokd-cloud/agent-storage build

FROM public.ecr.aws/aws-cli/aws-cli:2.31.5@sha256:800a73f4f4884f20c5aae912229fb145def8621e4b9c1b9a63bb9400501843f3 AS awscli
FROM mongo:7.0.29@sha256:153d075ff9e0cc36f0be1c48df4d74a01b01f94c5dd249eb094f7ec99862ce88
LABEL org.opencontainers.image.title="Stokd Agent storage maintenance" \
      org.opencontainers.image.version="node-24.15.0-mongodb-7.0.29-tools-100.14.0-awscli-2.31.5" \
      org.opencontainers.image.base.digest="sha256:153d075ff9e0cc36f0be1c48df4d74a01b01f94c5dd249eb094f7ec99862ce88"
COPY --from=awscli /usr/local/aws-cli /usr/local/aws-cli
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/protocol ./packages/protocol
COPY --from=build /workspace/packages/storage ./packages/storage
COPY infra/runtime/maintenance-entrypoint.sh /usr/local/bin/stokd-agent-storage-maintenance
COPY infra/runtime/materialize-json.mjs /opt/stokd-agent/materialize-json.mjs
COPY infra/runtime/offline-config.mjs /opt/stokd-agent/offline-config.mjs
COPY infra/runtime/verify-restore-selection.mjs /opt/stokd-agent/verify-restore-selection.mjs
COPY infra/runtime/restore-operation-state.mjs /opt/stokd-agent/restore-operation-state.mjs
COPY infra/runtime/restore-secret-material.mjs /opt/stokd-agent/restore-secret-material.mjs
COPY infra/runtime/validation-payload.mjs /opt/stokd-agent/validation-payload.mjs
COPY infra/runtime/offline-restore-entrypoint.sh /opt/stokd-agent/offline-restore-entrypoint
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws \
    && chmod 0555 /usr/local/bin/stokd-agent-storage-maintenance /opt/stokd-agent/materialize-json.mjs /opt/stokd-agent/offline-config.mjs /opt/stokd-agent/verify-restore-selection.mjs /opt/stokd-agent/restore-operation-state.mjs /opt/stokd-agent/restore-secret-material.mjs /opt/stokd-agent/validation-payload.mjs /opt/stokd-agent/offline-restore-entrypoint \
    && test "$(node --version)" = "v24.15.0" \
    && aws --version 2>&1 | grep -Fq 'aws-cli/2.31.5' \
    && test "$(mongod --version | awk '/db version/{print $3}')" = "v7.0.29" \
    && test "$(mongorestore --version | awk '/mongorestore version/{print $3}')" = "100.14.0"
USER root
ENTRYPOINT ["/usr/local/bin/stokd-agent-storage-maintenance"]
