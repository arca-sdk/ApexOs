# syntax=docker/dockerfile:1
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hearth/web build && pnpm --filter @hearth/server build
RUN pnpm --filter @hearth/server deploy --prod --legacy /out

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    HEARTH_PORT=8080 \
    HEARTH_HOST=0.0.0.0 \
    HEARTH_DATA_DIR=/data \
    HEARTH_WEB_DIR=/app/web \
    HEARTH_CATALOG_DIR=/app/catalog
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/server/catalog ./catalog
COPY --from=build /src/apps/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/index.js"]
