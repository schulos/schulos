# SchulOS Backup – Web-UI und API des Backupservers (Next.js standalone, Node 24 LTS, Nicht-Root)
# Bauen (aus dem Repo-Root, wegen der Workspaces):  docker build -f apps/backup/Dockerfile -t schulos-backup:dev .
# Daten:  /srv/schulos-backup/{db,config,rest} (Volumes; rest = Repositories + .htpasswd, geteilt mit dem rest-server)
# Konfiguration: backup.env, siehe INSTALLATION.md §8.1
ARG NODE_IMAGE=node:24-alpine
ARG RESTIC_IMAGE=restic/restic:0.19.1
# rclone für die Offsite-Kopie (B-37): SFTP, S3 u. a.; restic nutzt es als Backend (rclone:<remote>:<pfad>)
ARG RCLONE_IMAGE=rclone/rclone:1.75.1

FROM ${RESTIC_IMAGE} AS restic
FROM ${RCLONE_IMAGE} AS rclone

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/ui/package.json packages/ui/
COPY packages/server/package.json packages/server/
COPY apps/backup/package.json apps/backup/
COPY apps/agent/package.json apps/agent/
# alle Workspaces: Build-Werkzeuge (Tailwind, TypeScript) sind Root-devDependencies; ins Image kommt nur die Standalone-Ausgabe
RUN npm ci --no-audit --no-fund

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY apps/backup ./apps/backup
# Build-Name aus dem Commit (B-47, reproduzierbar); ohne Angabe würfelt Next einen
ARG SCHULOS_BUILD_ID
RUN cd apps/backup && npx next build --webpack
# Kommandozeile im Container (Kopplungscodes ohne Web-UI, B-45): apps/backup/src/cli.ts → cli.mjs
RUN npx esbuild apps/backup/src/cli.ts --bundle --platform=node --target=node24 --format=esm --log-level=warning --outfile=apps/backup/.next/cli.mjs

FROM ${NODE_IMAGE} AS runner
# Standalone-Ausgabe im Monorepo: server.js liegt unter apps/backup (Tracing-Wurzel ist das Repo)
WORKDIR /app/apps/backup
# Version aus dem Release-Workflow (Tag), lokal „dev“
ARG SCHULOS_VERSION=dev
LABEL org.opencontainers.image.version=${SCHULOS_VERSION} \
      org.opencontainers.image.source=https://github.com/schulos/schulos
ENV SCHULOS_VERSION=${SCHULOS_VERSION} \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3100 \
    HOSTNAME=0.0.0.0 \
    SCHULOS_CONFIG_DIR=/srv/schulos-backup/config \
    PGLITE_DIR=/srv/schulos-backup/db/pglite \
    SCHULOS_REST_DIR=/srv/schulos-backup/rest
# restic für Aufräumen, Prüfung und Test-Restore direkt auf den Repositories (statisch aus dem offiziellen Image);
# pg_restore 18 für den Test-Restore der Datenbank
COPY --from=restic /usr/bin/restic /usr/local/bin/restic
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
# apk.log enthält Uhrzeiten → raus (reproduzierbares Image, B-47)
RUN apk add --no-cache tini postgresql18-client \
 && rm /var/log/apk.log \
 && mkdir -p /srv/schulos-backup/config /srv/schulos-backup/db /srv/schulos-backup/rest \
 && chown -R node:node /srv/schulos-backup
COPY --from=build --chown=root:root /app/apps/backup/.next/standalone /app
COPY --from=build --chown=root:root /app/apps/backup/.next/static ./.next/static
COPY --from=build --chown=root:root /app/apps/backup/drizzle ./drizzle
COPY --from=build --chown=root:root /app/apps/backup/.next/cli.mjs ./cli.mjs
# PGlite lädt pglite.data zur Laufzeit – der Tracer erfasst die Datei nicht
COPY --from=build --chown=root:root /app/node_modules/@electric-sql/pglite /app/node_modules/@electric-sql/pglite
USER node
VOLUME ["/srv/schulos-backup/config", "/srv/schulos-backup/db", "/srv/schulos-backup/rest"]
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
