# ONNX inference dependencies require glibc; do not switch this service to Alpine.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build
# Pinned revision and checksums come from model-artifacts.ts; no runtime download.
RUN SEMANTIC_MODEL_PATH=/opt/wgo/models/e5 node dist/post/semantic/prepare-model.js
RUN pnpm prune --prod

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV SEMANTIC_MODEL_PATH=/opt/wgo/models/e5
RUN mkdir -p /app/certs
COPY --from=build /opt/wgo/models /opt/wgo/models
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY contracts ./contracts
EXPOSE 3002
USER node
CMD ["node", "dist/start.js"]
