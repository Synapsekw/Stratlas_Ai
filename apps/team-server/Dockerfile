# syntax=docker/dockerfile:1.7
# Team Server (preview) image: one bundled Node file and the SQL migrations on a distroless,
# non-root base (no shell, no package manager). Build from the repository root:
#
#   docker build -f apps/team-server/Dockerfile -t aio-team-server:0.1.0 .
#
# Run it with apps/team-server/compose.yaml and docs/server/README.md.

FROM node:24-bookworm-slim AS build
WORKDIR /src
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
# the server, its workspace packages and the root build tools; no install scripts
RUN pnpm install --frozen-lockfile --ignore-scripts --filter . --filter "@aio/team-server..."
RUN pnpm -F @aio/team-server build && mkdir -p /out/data

FROM gcr.io/distroless/nodejs24-debian12:nonroot
WORKDIR /app
COPY --from=build /src/apps/team-server/dist/ /app/dist/
COPY --from=build /src/apps/team-server/migrations/ /app/migrations/
# the data folder (blobs, the server key) belongs to the non-root user
COPY --from=build --chown=65532:65532 /out/data /data
ENV NODE_ENV=production \
    AIO_DATA_DIR=/data \
    AIO_PORT=8443 \
    AIO_MIGRATIONS_DIR=/app/migrations
USER 65532:65532
EXPOSE 8443
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/dist/healthcheck.mjs"]
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/main.mjs"]
CMD ["serve"]
