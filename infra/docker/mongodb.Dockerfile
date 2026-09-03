FROM mongo:7.0.29@sha256:153d075ff9e0cc36f0be1c48df4d74a01b01f94c5dd249eb094f7ec99862ce88
LABEL org.opencontainers.image.title="Stokd Agent MongoDB" \
      org.opencontainers.image.version="mongodb-7.0.29-tools-100.14.0" \
      org.opencontainers.image.base.digest="sha256:153d075ff9e0cc36f0be1c48df4d74a01b01f94c5dd249eb094f7ec99862ce88"
RUN test "$(mongod --version | awk '/db version/{print $3}')" = "v7.0.29" \
    && test "$(mongodump --version | awk '/mongodump version/{print $3}')" = "100.14.0"
COPY infra/runtime/mongo-entrypoint.sh /usr/local/bin/agent-mongo-entrypoint
RUN chmod 0555 /usr/local/bin/agent-mongo-entrypoint
ENTRYPOINT ["/usr/local/bin/agent-mongo-entrypoint"]
