# Fremd-Images per Digest (B-47) – eine Quelle für ISO-Bau, Releases (getaggt) und Sicherheitsprüfung.
# Kein echtes Dockerfile: jede Zeile „FROM <name:tag>@sha256:… AS <schlüssel>“ ist ein Eintrag; Dependabot (docker,
# wöchentlich) hält die Digests aktuell. Tags müssen zu den Vorgaben in Dockerfiles/compose*.yaml passen
# (packages/server/src/release.test.ts prüft das) – hebt Dependabot einen Tag an, dort mitziehen.
# Der wöchentliche Neubau (release.yml) löst die Tags frisch auf (B-30) und nimmt die Digests hier nicht.
#
# Basis der eigenen Images (Dockerfile, apps/agent/Dockerfile, apps/backup/Dockerfile)
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS node
FROM restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 AS restic
FROM rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5 AS rclone
# laufen im Stack mit (compose.yaml, compose.backup.yaml)
FROM caddy:2@sha256:f2a1290d0463aad60660d4ec134943f183ee2a5f6c3eb7bf32dd984f2f020772 AS caddy
FROM postgres:18@sha256:fc973eb97c9fd04bfa1840e0f510719a584ccb3be8debfe6a4144637a9dfe8cf AS postgres
FROM restic/rest-server:0.14.0@sha256:d2aff06f47eb38637dff580c3e6bce4af98f386c396a25d32eb6727ec96214a5 AS rest-server
# nur mit Compose-Profil „geraete“ (P4-40b, Schul-CA für Gerätezertifikate) – nicht auf der ISO, wird bei Bedarf geladen
FROM smallstep/step-ca:0.30.2@sha256:a2b17872915c193259b75a5474c398326f41bd199f0842093e52cf4182bc8270 AS step-ca
# nur mit Compose-Profil „clamav“ (P4-72, Virenscan der Uploads, GPL-2.0) – nicht auf der ISO, wird bei Bedarf geladen
FROM clamav/clamav:1.5.4@sha256:638d90201ee7ee6a82d249a2fc23b132e578673b5f1f2766852b127676ca1ef6 AS clamav
# nur mit Compose-Profil „crowdsec“ (SEC-15, Angriffserkennung, MIT) – nicht auf der ISO, wird bei Bedarf geladen
FROM crowdsecurity/crowdsec:v1.8.1@sha256:0f2523fa61ef507f15d953045cface490cc880670c62f2755ced17524107f71a AS crowdsec
# nur Werkzeuge beim ISO-Bau (kein Teil der Releases): Build-Container (Debian 13), BuildKit für die eigenen Images
# (gleiche Version überall → gleiche Bytes), Stückliste, cosign (Release-ISO prüft die Signaturen der Images, B-49), k6 (Lasttest, B-50a)
FROM node:24-trixie@sha256:1278a37eb510ec1606fba0e80f554bcc941ae0b44f35ae373c4822ae7717c64d AS iso-build
FROM moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea AS buildkit
FROM anchore/syft:v1.54.1@sha256:3eb5379ba7b409c3f4069b686110527af0c47df993fa5c10d13e7cf34f49b1aa AS syft
FROM ghcr.io/sigstore/cosign/cosign:v3.0.2@sha256:b29487e48205d875c324c79583e2806d9d269c0fa299e0861bbec023d8430c8b AS cosign
FROM grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34 AS k6
