FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @captain/api...
COPY apps/api ./apps/api
RUN pnpm --filter @captain/api build

FROM node:22-alpine
WORKDIR /repo/apps/api
COPY --from=build /repo /repo
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
