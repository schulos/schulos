# CA-07: Caddy mit DNS-Modulen für Let's Encrypt per DNS-Prüfung (docs/ZERTIFIKATE.md Teil B) – nur für Server mit
# „öffentliche Domain, Server nur im Schulnetz“; alle anderen nutzen weiter das Standard-Image caddy:2.
# Bauen (aus dem Repo-Root):  docker build -f deploy/caddy-dns/Dockerfile -t schulos-caddy-dns:dev .
# Reproduzierbar (B-47): Basis-Images per Digest über die Build-Args (deploy/upstream/Dockerfile, Release/ISO), Go-Module per
# go.sum (Dependabot gomod), ohne VCS-Angaben und Pfade im Binary. Statt xcaddy: dasselbe Hauptprogramm (main.go) im Repo –
# so liegt jede Abhängigkeit mit Prüfsumme fest und xcaddy selbst ist keine weitere ungepinnte Abhängigkeit.
ARG GO_IMAGE=golang:1.27-alpine
ARG CADDY_IMAGE=caddy:2

FROM ${GO_IMAGE} AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS="-trimpath -buildvcs=false -mod=readonly"
COPY deploy/caddy-dns/go.mod deploy/caddy-dns/go.sum ./
RUN go mod download && go mod verify
COPY deploy/caddy-dns/main.go ./
RUN go build -ldflags="-s -w" -o /out/caddy . && /out/caddy list-modules | grep -c '^dns\.providers\.'

# Laufzeit wie das Standard-Image (Pfade /etc/caddy, /data, /config, Benutzer, Zertifikatsspeicher) – nur das Binary ist anders
FROM ${CADDY_IMAGE}
ARG SCHULOS_VERSION=dev
LABEL org.opencontainers.image.version=${SCHULOS_VERSION} \
      org.opencontainers.image.source=https://github.com/schulos/schulos \
      org.opencontainers.image.description="Caddy mit DNS-Modulen (SchulOS, ACME DNS-01)"
COPY --from=build /out/caddy /usr/bin/caddy
