# Veröffentlichung – Checkliste für den Umschalt-Tag (REPO-01…03)

> Stand: 2026-10-16 · **Umschalten freigegeben** (Projektleitung 2026-10-16, Entscheidungen in Abschnitt A). Organisation
> `schulos`, Repo `schulos/schulos`. Zuvor galt: nur nach Release v0.5.0 und ausdrücklicher erneuter Zustimmung (Q-R5-1). Jeder Schritt unten, der etwas nach außen sichtbar macht, ist mit 🔓 markiert und braucht diese Zustimmung.

Entschieden (Q-R5-1/Q-R5-2): **frisches Repo** in einer **GitHub-Organisation** – nur der aktuelle Stand, ohne die
Historie des privaten Repos, Commits mit Noreply-Adresse; Lizenz AGPL-3.0 (`LICENSE`, `NOTICE`), Copyright
„SchulOS-Mitwirkende“; Issues/Discussions aus, private Sicherheitsmeldungen an (`SECURITY.md`); Rulesets mit
Pflicht-Checks; GHCR-Pakete öffentlich; Release und PR-CI auf GitHub-Runnern, self-hosted nur für eigene Läufe
(ISO/QEMU/Lasttest).

---

## A. Offene Punkte für die Projektleitung (vor dem Umschalt-Tag)

- [x] **Zustimmung** (2026-10-16) zum Umschalten überhaupt (Haftung, „ohne Gewähr“ reicht? ggf. rechtlicher Rat) – Q-R5-1
- [x] **Namensprüfung „SchulOS“** (erledigt, 2026-10-16): DPMA (DPMAregister, Klassen 9 und 42, auch ähnliche Schreibweisen), EUIPO (eSearch
      plus/TMview), dazu Domain- und GitHub-Org-Name. Bei Treffern mit älteren Rechten: anderen Namen wählen, **bevor**
      etwas veröffentlicht ist
- [x] **Name der Organisation:** `schulos` (wird Teil von `ghcr.io/<org>/schulos` und der Repo-URL in `schulosctl`)
- [x] **Signierschlüssel:** neu erzeugt (Q-4E-33, Fingerabdruck in `release/README.md`)
- [x] **Welche Doku öffentlich wird** (Q-4E-34: Arbeitsdokumente werden **nicht** veröffentlicht): Arbeitsdokumente (`docs/LOG.md`, `docs/QUESTIONS.md`, `docs/PHASE4.md`,
      `docs/FEINSCHLIFF.md`, `CLAUDE.md`) mitveröffentlichen oder vorher entfernen (Q-4E-34)
- [x] Lizenzvariante bestätigt: **AGPL-3.0-or-later** (so vorbereitet) oder „only“ (Q-4E-30)
- [x] Quellcode-Hinweis in der App (AGPL § 13) – vor dem Umschalten eingebaut (Q-4E-31, `src/core/source.ts`)

## B. Im privaten Repo vorbereiten (Branch + PR wie immer)

1. Stand: Release v0.5.0 fertig, `main` grün, GATE 4e abgenommen.
2. **Repo-Bezüge umstellen** auf `<org>/schulos` bzw. `ghcr.io/<org>` – die Prüfung listet alle Stellen als
   „umschalten“: `npm run veroeffentlichen:pruefen`. Heute sind das:
   - `apps/ctl/src/stack.ts` (`RELEASE_REPO` – von dort holt `schulosctl update` die Releases; einzige Stelle im Code)
   - `package.json` (`repository`), die drei Dockerfiles (`org.opencontainers.image.source`)
   - Doku: `release/README.md`, `docs/INSTALLATION.md` §5a.2, `docs/PLAN.md` §0, `CLAUDE.md`, `docs/QUESTIONS.md`
   - Kommentare in `packages/server/src/release.ts`, `apps/ctl/src/bundle.ts`
   Danach: `npm run veroeffentlichen:pruefen -- --umschalttag` → Exit 0.
3. **Geheimnis-Prüfung über die ganze Historie:** `gh workflow run security.yml` (gitleaks, zizmor, npm audit) → grün.
   Ins frische Repo kommt nur der Stand, die Historie bleibt privat – trotzdem: ein Geheimnis, das je im Repo war, gilt
   als verbrannt und wird erneuert, nicht nur gelöscht.
4. Abschließend `npm run verify` und der volle CI-Lauf auf dem PR.

## C. Organisation und frisches Repo anlegen

5. 🔓 **Organisation** anlegen (GitHub Free reicht). Einstellungen:
   - Zwei-Faktor-Pflicht für Mitglieder; Basisrecht für Mitglieder „Kein“ bzw. „Lesen“
   - Actions: nur Actions, die per Commit-SHA eingebunden sind (Dependabot hält sie aktuell); Standard-Rechte des
     `GITHUB_TOKEN` „Lesen“; „Actions dürfen PRs anlegen/freigeben“ aus
   - **Fork-PRs: „Require approval for all external contributors“** (jeder Lauf aus einem Fork wartet auf Freigabe)
6. 🔓 **Frisches Repo** `<org>/schulos` – zuerst **privat** anlegen, erst in Schritt 14 öffentlich schalten:
   ```bash
   git clone --depth 1 --branch main <privates-repo> schulos-export && cd schulos-export
   rm -rf .git && git init -b main
   git add -A
   git -c user.name="SchulOS-Mitwirkende" -c user.email="<id>+<konto>@users.noreply.github.com" \
     commit -m "SchulOS – Stand v0.5.0"
   git remote add origin https://github.com/<org>/schulos.git && git push -u origin main
   ```
   Noreply-Adresse: GitHub → Settings → Emails („Keep my email addresses private“ an, „Block command line pushes that
   expose my email“ an). Auch künftige Commits nur mit dieser Adresse (`git config user.email` im Repo setzen).
   Der Update-Test vor einem Release braucht einen Vorgänger-Commit bzw. -Tag (`scripts/update-test.sh`): das erste
   Release also erst nach mindestens einem weiteren Commit taggen.
7. **Repo-Einstellungen:** Issues, Discussions, Wiki, Projects **aus**; „Private vulnerability reporting“ **an**;
   Dependabot-Alerts und -Sicherheitsupdates an; Secret Scanning + Push Protection an; Merge nur per Merge-Commit
   (wie `scripts/pr-merge.sh`), Head-Branches nach dem Merge löschen.
8. **Secrets/Variablen** neu setzen (werden nicht mitkopiert): `COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD`
   (Q-4E-33), Variable `SCHULOS_RUNNER` (Abschnitt D).
9. **Rulesets:**
   - Branch `main`: Änderungen nur per PR, Pflicht-Checks `ergebnis` (CI) sowie `secrets`, `dependencies`, `veroeffentlichung`,
     `workflows` (Sicherheit), kein Force-Push, kein Löschen; Bypass nur für Admins der Organisation.
   - Tags `v*`: anlegen/ändern/löschen nur für Admins (ein Tag startet `release.yml`).

## D. Runner umstellen (REPO-02, siehe auch `.github/workflows/*.yml`)

Gesteuert über die Repo-Variable **`SCHULOS_RUNNER`** (Settings → Secrets and variables → Actions → Variables):

| Wert | Wo die Jobs laufen | Wofür |
|---|---|---|
| *(nicht gesetzt)* | alles auf der Build-VM (self-hosted), Fork-PRs auf GitHub | heute: privates Repo ohne GitHub-Freiminuten |
| `oeffentlich` | **Release** (`release.yml`, Signieren der ISO-Prüfsumme) und **alle Pull Requests** auf GitHub-Runnern; Push auf `main`, Zeitpläne, ISO/QEMU, Lasttest auf der Build-VM | öffentliches Repo (GitHub-Runner sind für öffentliche Repos frei) |
| `github` | alles auf GitHub-Runnern (außer Lasttest/Build-VM-Pflege) | Notbetrieb ohne Build-VM |

10. 🔓 **Self-hosted Runner** im neuen Repo registrieren – als **Runner-Gruppe der Organisation**, beschränkt auf das
    eine Repo und auf **ausgewählte Workflows vom Branch `main`** (`ci.yml`, `security.yml`, `iso.yml`, `lasttest.yml`,
    `buildvm.yml`, `installer.yml` jeweils `@refs/heads/main`). „Öffentliche Repositories erlauben“ muss dafür in der
    Gruppe ausdrücklich an sein. Labels wie bisher: `schulos-iso` (schwer) und `leicht`.
    Warum die Beschränkung: Ein Fork-PR bringt seine **eigene** Workflow-Datei mit – die Bedingungen in den Workflows
    schützen nur, solange niemand sie ändert. Erst die Runner-Gruppe (nur Workflows von `main`) und die Freigabepflicht
    für Fork-Läufe (Schritt 5) halten fremden Code sicher von der Build-VM fern.
11. Variable `SCHULOS_RUNNER=oeffentlich` setzen. Probe: einen PR aus einem eigenen Branch öffnen → alle Jobs auf
    `ubuntu-24.04`; nach dem Merge läuft die CI auf `main` auf der Build-VM.
12. Erstes Release im neuen Repo: Version anheben, Tag pushen → `release.yml` auf GitHub-Runnern (Update-Test, Images nach
    `ghcr.io/<org>`, Signaturen, SBOMs). Danach `gh workflow run iso.yml -f release=v<x>` → ISO + Prüfsumme +
    cosign-Signatur der Prüfsumme hängen am Release (`docs/INSTALLATION.md` „ISO herunterladen und prüfen“).

## E. Sichtbar schalten

13. 🔓 **GHCR-Pakete** `schulos`, `schulos-backup`, `schulos-agent` der Organisation: Package settings → mit dem Repo
    verknüpfen, Sichtbarkeit **öffentlich**. Probe ohne Anmeldung: `docker pull ghcr.io/<org>/schulos:<version>`.
14. 🔓 **Repo öffentlich** schalten (Settings → General → Danger Zone). Danach prüfen: README wird angezeigt,
    „Report a vulnerability“ ist sichtbar, Issues/Discussions sind aus.
15. **`schulosctl update` ohne Token** auf einem Testserver: `unset SCHULOS_GITHUB_TOKEN; schulosctl update --check` →
    Liste der Releases, Signatur geprüft. (Ohne Token zählt GitHub 60 API-Aufrufe je Stunde und Adresse; `schulosctl`
    lädt die Release-Dateien deshalb ohne Token über die normalen Download-Links, die nicht mitzählen.)

## F. Danach

- Bestehende Testserver, die noch vom privaten Repo aktualisieren: einmalig das `schulosctl` aus dem neuen Repo von Hand
  einsetzen (Vorgehen wie `docs/INSTALLATION.md` §5a.2 „Umstellung älterer Installationen“), sonst sehen sie keine neuen
  Releases mehr. Bei neuem Signierschlüssel ist das ohnehin nötig.
- Das private Repo archivieren (nicht löschen – es enthält die Historie und die alten Releases).
- `CLAUDE.md` und `docs/PLAN.md` §0 auf das neue Repo umstellen (Remote, `pr-merge.sh` arbeitet mit dem aktuellen Repo).
- Vor jedem Merge und Release weiter `npm run veroeffentlichen:pruefen` (findet Namen, Heimnetz-Adressen, Hostnamen,
  Geheimnisse; allgemeine Muster in `scripts/veroeffentlichen-pruefen.ts`, persönliche Muster – Namen, Heimnetz, Hostnamen – nur lokal in `scripts/veroeffentlichen-muster.local.json` bzw. als Secret `VEROEFFENTLICHUNG_MUSTER`, nie im Repo).
