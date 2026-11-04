# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
FROM ${NODE_IMAGE} AS build
ENV CI=true NODE_OPTIONS=--max-old-space-size=768 MAKEFLAGS=-j1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global --ignore-scripts pnpm@10.28.1
WORKDIR /app
COPY . .
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile --child-concurrency=1 && pnpm run build && pnpm install --prod --frozen-lockfile --offline

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=320
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
RUN mkdir -p /var/lib/guardian-state && chown node:node /var/lib/guardian-state
USER node
ENTRYPOINT ["node", "dist/wallet-guardian/cli.js"]
CMD ["help"]
