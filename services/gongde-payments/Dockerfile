FROM node:22.19.0-alpine3.22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# `npm run build` ends with `node scripts/copy-assets.mjs`, so the build stage
# needs the scripts directory too; without it the build stops with
# MODULE_NOT_FOUND before any source is compiled.
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22.19.0-alpine3.22
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY --from=build --chown=65532:65532 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/dist ./dist
COPY --chown=65532:65532 migrations ./migrations
COPY --chown=65532:65532 scripts ./scripts
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=5 --start-period=5s CMD node -e "fetch('http://127.0.0.1:8080/api/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
