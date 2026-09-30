FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
# Includes engine source; the API dependency closure installs pg-boss and its runtime dependencies.
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @captain/api...
COPY apps/api ./apps/api
# The inference Sprite's bootstrap files, uploaded by the API when an owner sets up a subscription (D18).
COPY infra/sprites ./infra/sprites
RUN pnpm --filter @captain/api build \
 && test -f /repo/packages/engine/src/install.ts \
 && pnpm --filter @captain/api exec node --import tsx --input-type=module -e "await import('@captain/engine')"

# The Expo web export the API serves from its own origin (docs/plans/expo-web-session-2026-09.md §A.1). Its own
# stage, so the runtime image carries the export and none of the mobile toolchain. The public API URL is the
# only build argument (apps/mobile/src/config.ts); no secret exists in this stage. Web sessions use the page origin.
FROM node:22-alpine AS web
RUN corepack enable
WORKDIR /repo
ENV CI=1 EXPO_NO_TELEMETRY=1
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/mobile/package.json apps/mobile/
RUN pnpm install --frozen-lockfile --filter @captain/mobile...
COPY apps/mobile ./apps/mobile
ARG EXPO_PUBLIC_API_URL=https://app.askthecaptain.app
# The harness selector is never set here (mobile auth composition contract §7.1): this is the production export.
RUN env -u CAPTAIN_MOBILE_HARNESS pnpm --filter @captain/mobile exec expo export --platform web --output-dir dist/web --max-workers 2 \
 && test -f /repo/apps/mobile/dist/web/index.html

FROM node:22-alpine
WORKDIR /repo/apps/api
COPY --from=build /repo /repo
# Served at `/` by the API; the path is its default WEB_EXPORT_DIR (apps/api/src/web/static.ts).
COPY --from=web /repo/apps/mobile/dist/web /repo/apps/mobile/dist/web
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
