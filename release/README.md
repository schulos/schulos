# Releases

Ablauf (INSTALLATION.md §5a.2, B-29):

1. Version in `package.json` setzen (SemVer: Patch = Fehler/Sicherheit, Minor = neue Funktionen, Major = größere Umbauten).
2. `release/notes/<version>.json` anlegen – Änderungen **in Alltagssprache** (so stehen sie später in Verwaltung → System):
   ```json
   {
     "changes": [{ "kind": "neu", "text": "Elternsprechtage buchen" }],
     "minVersion": "1.4.0",
     "securityRelevant": false,
     "betaDays": 14
   }
   ```
   `kind`: `neu` · `verbessert` · `behoben` · `sicherheit`. Optional: `minVersion` (Vorgabe: x.(y−1).0, also nur von der
   direkt vorigen Minor-Reihe aus erreichbar), `securityRelevant` (Vorgabe: gibt es eine Änderung `sicherheit`),
   `betaDays` (Vorgabe 14; 0 = sofort stabil). Prüfen: `npx tsx scripts/release-manifest.ts --check <version>`.
3. Committen, Tag `v<version>` (bzw. `v<version>-rc.N` für eine Vorabversion) pushen → Workflow `release.yml`:
   baut die Images App, Backup und Agent für GHCR, signiert sie mit cosign (Schlüsselpaar, ohne Rekor), schreibt das
   Release-Manifest (Images per Digest) und signiert es, legt das GitHub-Release mit `release.json` + `release.json.sig` an.
   Dazu (GATE-031, ab v0.3.2) `schulosctl.mjs` (aus dem Build-Stand gebaut) und `compose.yaml` als Anhang, ihre SHA-256 stehen
   unter `files` im Manifest (`--files`, geprüft mit `--hostfiles`) – damit ersetzt `schulosctl update` sich selbst und die
   Compose-Datei auf dem Server (INSTALLATION.md §5a.2).

**Kanäle:** Jedes Release startet im Kanal **beta** und ist ab `stableFrom` (Veröffentlichung + `betaDays`) im Kanal
**stabil**. Vorabversionen (`-rc.N`) werden nie stabil. `schulosctl` (B-31/B-32) rechnet den Kanal aus dem signierten
Manifest – es gibt keine Kanal-Datei, die man nachträglich umstellen müsste.

**Runner (SEC-10/REPO-02):** Mit der Repo-Variable `SCHULOS_RUNNER=oeffentlich` (öffentliches Repo) laufen `release.yml` und
das Signieren der ISO-Prüfsumme auf frischen GitHub-Runnern, der Schlüssel kommt nicht auf die Build-VM. Ohne Variable
(privates Repo ohne Freiminuten) läuft beides wie bisher auf der Build-VM.

**Schlüssel:** `cosign.pub` ist der öffentliche Schlüssel (kommt in `schulosctl`). Der private Schlüssel liegt nur als
GitHub-Secret `COSIGN_PRIVATE_KEY` (verschlüsselt, Passwort in `COSIGN_PASSWORD`). Prüfen von Hand:
`cosign verify --key release/cosign.pub --insecure-ignore-tlog=true ghcr.io/schulos/schulos@sha256:…` bzw.
`cosign verify-blob --key release/cosign.pub --signature release.json.sig --insecure-ignore-tlog=true release.json`.
Fingerabdruck des Schlüssels (SHA-256 über DER, `openssl pkey -pubin -in release/cosign.pub -outform DER | sha256sum`):
`948938a6649e2a11e0c171e8b2ebf53484a000d83d4b07bcd8684593705f3682` (seit der Veröffentlichung, Oktober 2026; bis v0.5.1 galt `45d4ea42…14be1`) – zum Abgleich, wenn ein Schlüssel über denselben Weg wie
ein Release kommt; auf Servern prüft besser das installierte `schulosctl` (eingebackener Schlüssel, siehe INSTALLATION.md §5a.2).

**Wöchentlicher Neubau (B-30):** Montags 04:00 UTC (oder von Hand: Actions → Release → „Run workflow“) prüft der Workflow,
ob sich eines der Fremd-Images (`node`, `restic` als Basis; `caddy`, `postgres`, `rest-server` im Stack) seit dem neuesten
fertigen Release geändert hat – verglichen wird der Digest mit `upstream` im Manifest. Wenn ja: automatisches Patch-Release
x.y.(z+1) **aus demselben Commit** (keine neuen Funktionen), Änderung „sicherheit“, `betaDays` 3; der Tag entsteht dabei
im Workflow. Deshalb vor einem eigenen Patch-Release erst `git fetch --tags` und die nächste freie Nummer nehmen.
Die Fremd-Images werden beim Bauen per Digest gepinnt und im Manifest festgehalten – `schulosctl` zieht genau diese.
Ein getaggtes Release nimmt die Digests aus `deploy/upstream/Dockerfile` (B-47, gleiche wie die ISO, Dependabot hält sie
aktuell); der wöchentliche Neubau löst die Tags dagegen frisch auf.

**Release-ISO (B-49):** Die ISO zu einem Release entsteht nicht aus einem Neubau, sondern aus genau den signierten Images
des Releases: `gh workflow run iso.yml -f release=v<version>` (Build-VM; dazu wie immer Rauchtest und QEMU-Tests). Der Lauf
checkt den Commit aus `release.json` aus, prüft die Signatur des Manifests gegen `release/cosign.pub`, prüft die drei
eigenen Images zusätzlich mit `cosign verify` und zieht alle Images (auch caddy, postgres, rest-server) per Digest aus dem
Manifest. Auf dem Medium heißen sie `ghcr.io/…/schulos:<version>` bzw. wie in Compose; die Digests stehen in der Stückliste.
Nach grünen Tests hängt der Job `release-anhang` (REPO-02) die ISO `schulos-<version>.iso`, `schulos-<version>.iso.sha256`,
die cosign-Signatur der Prüfsumme `schulos-<version>.iso.sha256.sig` und `schulos-<version>.stueckliste.json` ans Release
(GitHub erlaubt bis 2 GiB je Datei, die ISO hat ~1,5 GB); eine Kopie bleibt auf der Build-VM unter `~/schulos-iso/`. Prüfen:
`docs/INSTALLATION.md` §1.1. Signiert wird mit `SCHULOS_RUNNER=oeffentlich` auf einem GitHub-Runner (ISO als Artefakt dorthin),
sonst auf der Build-VM. Lokal: `bash iso/build-docker.sh --release v<version>` auf einem
sauberen Checkout des Release-Commits (Docker bei ghcr.io angemeldet, für cosign `SCHULOS_REGISTRY_USER`/`_TOKEN`).
Erst Releases ab B-49 lassen sich so bauen (ältere haben die Werkzeuge im Release-Commit nicht).
