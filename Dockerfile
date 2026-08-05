# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS builder
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG ALPINE_MIRROR=https://dl-cdn.alpinelinux.org/alpine

RUN if [ "${ALPINE_MIRROR}" != "https://dl-cdn.alpinelinux.org/alpine" ]; then \
    sed -i "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
  fi && \
  apk add --no-cache python3 make g++ linux-headers su-exec

COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm install --registry="${NPM_REGISTRY}"

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Next file tracing can also omit db repos imported only from API routes /
# initializeApp. Without this, saveDiscoveredCatalog fails at runtime and
# boot rehydrate is a no-op — the exact vision:false restart window we prevent.
COPY --from=builder /app/src/lib/db ./src/lib/db
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

COPY --from=builder /sbin/su-exec /sbin/su-exec

# Fix permissions at runtime (handles mounted volumes)
RUN printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
