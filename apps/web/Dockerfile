FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
# pnpm patches (patches/*.patch, declared in pnpm-workspace.yaml) must be present before install.
COPY patches ./patches
COPY apps/web/package.json apps/web/
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @captain/web...
COPY apps/web ./apps/web
RUN pnpm --filter @captain/web build

FROM node:22-alpine
RUN corepack enable
WORKDIR /repo
COPY --from=build /repo /repo
ENV NODE_ENV=production
CMD ["pnpm", "--dir", "apps/web", "exec", "next", "start"]
