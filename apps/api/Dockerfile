FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
# pnpm patches (patches/*.patch, declared in pnpm-workspace.yaml) must be present before install.
COPY patches ./patches
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

FROM node:22-alpine
WORKDIR /repo/apps/api
COPY --from=build /repo /repo
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
