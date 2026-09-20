# The embedding service (D21). onnxruntime needs glibc, so this is Debian slim, not Alpine.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY model.mjs fetch-model.mjs ./
# The encoder is baked into the image; the running service never reaches the internet.
RUN node fetch-model.mjs /app/models

FROM node:22-slim
WORKDIR /app
COPY --from=build /app /app
COPY server.mjs ./
ENV NODE_ENV=production MODEL_DIR=/app/models PORT=8080
USER node
CMD ["node", "server.mjs"]
