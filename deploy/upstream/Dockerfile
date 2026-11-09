# Fremd-Images per Digest (B-47) – eine Quelle für ISO-Bau, Releases (getaggt) und Sicherheitsprüfung.
# Kein echtes Dockerfile: jede Zeile „FROM <name:tag>@sha256:… AS <schlüssel>“ ist ein Eintrag; Dependabot (docker,
# wöchentlich) hält die Digests aktuell. Tags müssen zu den Vorgaben in Dockerfiles/compose*.yaml passen
# (packages/server/src/release.test.ts prüft das) – hebt Dependabot einen Tag an, dort mitziehen.
# Der wöchentliche Neubau (release.yml) löst die Tags frisch auf (B-30) und nimmt die Digests hier nicht.
#
# Basis der eigenen Images (Dockerfile, apps/agent/Dockerfile, apps/backup/Dockerfile)
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS node
FROM restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 AS restic
FROM rclone/rclone:1.75.2@sha256:2687085f718d3c628f7fdfb77c52a1d344332aed543110bb88088f2c70d43eb5 AS rclone
# CA-07: Go für das Caddy-Image mit DNS-Modulen (deploy/caddy-dns/Dockerfile; Laufzeit-Basis ist caddy unten)
FROM golang:1.27-alpine@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS golang
# laufen im Stack mit (compose.yaml, compose.backup.yaml)
FROM caddy:2@sha256:36c24ad91a7ff7bc4c87fe22bfa8df3c4b18da0773d73fc12ee2c52b98c0bb7e AS caddy
FROM postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6 AS postgres
FROM restic/rest-server:0.14.0@sha256:d2aff06f47eb38637dff580c3e6bce4af98f386c396a25d32eb6727ec96214a5 AS rest-server
# nur mit Compose-Profil „geraete“ (P4-40b, Schul-CA für Gerätezertifikate) – nicht auf der ISO, wird bei Bedarf geladen
FROM smallstep/step-ca:0.30.2@sha256:a2b17872915c193259b75a5474c398326f41bd199f0842093e52cf4182bc8270 AS step-ca
# nur mit Compose-Profil „clamav“ (P4-72, Virenscan der Uploads, GPL-2.0) – nicht auf der ISO, wird bei Bedarf geladen
FROM clamav/clamav:1.5.4@sha256:638d90201ee7ee6a82d249a2fc23b132e578673b5f1f2766852b127676ca1ef6 AS clamav
# nur mit Compose-Profil „crowdsec“ (SEC-15, Angriffserkennung, MIT) – nicht auf der ISO, wird bei Bedarf geladen
FROM crowdsecurity/crowdsec:v1.8.2@sha256:65b74942f7e7ed5c60fde4ac15fc4ba715904c398c8b16dd451f4907d90347d4 AS crowdsec
# nur Werkzeuge beim ISO-Bau (kein Teil der Releases): Build-Container (Debian 13), BuildKit für die eigenen Images
# (gleiche Version überall → gleiche Bytes), Stückliste, cosign (Release-ISO prüft die Signaturen der Images, B-49), k6 (Lasttest, B-50a)
FROM node:24-trixie@sha256:5c6e2e57d7dd6652ce6f087ba0328312059d7c77f93baa8751865dbf103f1acb AS iso-build
FROM moby/buildkit:v0.34.2@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe AS buildkit
FROM anchore/syft:v1.57.0@sha256:3c70e6d5979364cefdc22b51617a78fd264574d3bd6b4f84a351204147025e2a AS syft
FROM ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d AS cosign
FROM grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8 AS k6
