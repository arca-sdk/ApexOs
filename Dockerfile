# syntax=docker/dockerfile:1
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @apexos/web build && pnpm --filter @apexos/server build
RUN pnpm --filter @apexos/server deploy --prod --legacy /out

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    APEXOS_PORT=8080 \
    APEXOS_HOST=0.0.0.0 \
    APEXOS_DATA_DIR=/data \
    APEXOS_WEB_DIR=/app/web \
    APEXOS_CATALOG_DIR=/app/catalog
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/server/catalog ./catalog
COPY --from=build /src/apps/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/index.js"]
