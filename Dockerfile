# SchulOS – App-Image (Next.js standalone, Node 24 LTS, läuft als Nicht-Root)
# Bauen:  docker build -t schulos:dev .
# Daten:  /srv/schulos/{db,files,config} (Volumes); Konfiguration siehe src/core/config.ts
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm-Workspaces: npm ci braucht die package.json aller Workspaces
COPY packages/ui/package.json packages/ui/
COPY packages/server/package.json packages/server/
COPY apps/backup/package.json apps/backup/
COPY apps/agent/package.json apps/agent/
RUN npm ci --no-audit --no-fund

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# direkt `next build` statt `npm run build`: das prebuild-Skript würde ein lokales Geheimnis in .env.local schreiben
# Build-Name aus dem Commit (B-47, reproduzierbar); ohne Angabe würfelt Next einen
ARG SCHULOS_BUILD_ID
RUN npx next build --webpack
# Kommandozeile für schulosctl (info, reset-admin, demo-reset) – src/cli.ts
RUN node scripts/build-cli.mjs

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
# Version aus dem Release-Workflow (Tag), lokal „dev“
ARG SCHULOS_VERSION=dev
LABEL org.opencontainers.image.version=${SCHULOS_VERSION} \
      org.opencontainers.image.source=https://github.com/schulos/schulos
ENV SCHULOS_VERSION=${SCHULOS_VERSION} \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    SCHULOS_CONFIG_DIR=/srv/schulos/config \
    FILES_DIR=/srv/schulos/files \
    PGLITE_DIR=/srv/schulos/db/pglite
# apk.log enthält Uhrzeiten → raus (reproduzierbares Image, B-47)
RUN apk add --no-cache tini \
 && rm /var/log/apk.log \
 && mkdir -p /srv/schulos/config /srv/schulos/files /srv/schulos/db \
 && chown -R node:node /srv/schulos
COPY --from=build --chown=root:root /app/.next/standalone ./
COPY --from=build --chown=root:root /app/.next/static ./.next/static
# statisches Rückfall-Favicon (public/icon.png, P4-04) – der Standalone-Server kopiert public/ nicht selbst
COPY --from=build --chown=root:root /app/public ./public
COPY --from=build --chown=root:root /app/drizzle ./drizzle
COPY --from=build --chown=root:root /app/.next/cli.mjs ./cli.mjs
# PGlite lädt pglite.data zur Laufzeit – der Tracer erfasst die Datei nicht (Fallback ohne PostgreSQL)
COPY --from=build --chown=root:root /app/node_modules/@electric-sql/pglite ./node_modules/@electric-sql/pglite
USER node
VOLUME ["/srv/schulos/config", "/srv/schulos/files", "/srv/schulos/db"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
