# SchulOS Backup-Agent – läuft im Haupt-Stack neben der App (gleiche Volumes config + files, Datenbank im internen Netz)
# Bauen (aus dem Repo-Root, wegen der Workspaces):  docker build -f apps/agent/Dockerfile -t schulos-agent:dev .
ARG NODE_IMAGE=node:24-alpine
ARG RESTIC_IMAGE=restic/restic:0.19.1
# rclone: Wiederherstellung direkt aus der Offsite-Kopie (Installer „aus Offsite“, B-42) – gleiche Version wie im Backupserver
ARG RCLONE_IMAGE=rclone/rclone:1.75.2

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/ui/package.json packages/ui/
COPY packages/server/package.json packages/server/
COPY apps/backup/package.json apps/backup/
COPY apps/agent/package.json apps/agent/
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY packages/server ./packages/server
COPY apps/agent ./apps/agent
# Version aus dem Release-Workflow (Tag) – wird in agent.mjs eingebacken und dem Backupserver gemeldet
ARG SCHULOS_VERSION
RUN SCHULOS_VERSION=${SCHULOS_VERSION} node apps/agent/build.mjs

FROM ${RESTIC_IMAGE} AS restic
FROM ${RCLONE_IMAGE} AS rclone

FROM ${NODE_IMAGE}
ARG SCHULOS_VERSION=dev
LABEL org.opencontainers.image.version=${SCHULOS_VERSION} \
      org.opencontainers.image.source=https://github.com/schulos/schulos
# pg_dump in der Version des Datenbankservers (PostgreSQL 18); restic als statisches Binary aus dem offiziellen Image
# Volume-Ordner mit Besitzer node wie im App-Image: bei einer Wiederherstellung hängt der Agent als Erster an den frischen
# Volumes (App noch aus) – Docker übernimmt den Besitzer des Ordners im Image, sonst gehören sie root (EACCES, QEMU-Test §7.6)
# apk.log enthält Uhrzeiten → raus (reproduzierbares Image, B-47)
RUN apk add --no-cache tini postgresql18-client \
 && rm /var/log/apk.log \
 && mkdir -p /srv/schulos/config /srv/schulos/files \
 && chown -R node:node /srv/schulos
COPY --from=restic /usr/bin/restic /usr/local/bin/restic
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=build /app/apps/agent/dist/agent.mjs /opt/schulos-agent/agent.mjs
ENV NODE_ENV=production \
    SCHULOS_CONFIG_DIR=/srv/schulos/config \
    FILES_DIR=/srv/schulos/files
# gleicher Benutzer (uid 1000) wie die App: liest backup-pairing.json (0600) und schreibt den Zustand daneben
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/opt/schulos-agent/agent.mjs"]
