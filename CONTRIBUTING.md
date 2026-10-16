# Mitwirken

Danke für das Interesse an SchulOS. Bitte vorab lesen: SchulOS ist ein **Vorschau-Projekt ohne Support**
(`README.md`). Issues und Diskussionen sind bewusst ausgeschaltet.

- **Sicherheitslücken:** nie öffentlich – Weg in `SECURITY.md`.
- **Pull Requests aus Forks** sind willkommen, werden aber erst **nach Freigabe** durch die Betreuenden geprüft:
  Die CI läuft für Forks nur auf GitHub-Runnern und erst, nachdem jemand den Lauf freigegeben hat. Eine Zusage, dass ein
  PR übernommen wird, gibt es nicht. Größere Änderungen vorher kurz ansprechen (per PR-Entwurf mit Beschreibung).
- **Lizenz der Beiträge:** Mit einem Beitrag stellen Sie ihn unter die Lizenz des Projekts (AGPL-3.0-or-later, Datei
  `LICENSE`) und bestätigen, dass Sie dazu berechtigt sind. Es gibt keine gesonderte Rechteübertragung (kein CLA);
  Urheber:innen sind gemeinsam die „SchulOS-Mitwirkenden“ (`NOTICE`).
- **Keine echten Daten:** keine personenbezogenen Daten, keine Zugangsdaten, keine internen Adressen in Code, Tests,
  Screenshots oder Beschreibungen. `npm run veroeffentlichen:pruefen` findet die häufigsten Fälle.
- **Keine fremden Inhalte:** keine Texte, Screenshots, Icons oder Hilfeseiten anderer Schulplattformen als Vorlage, keine
  Produktnamen Dritter als Vergleich (`docs/PLAN.md` §2).

## Ablauf

1. Lokal einrichten (`README.md`, Abschnitt „Entwicklung“): `npm ci`, `npm run db:reset`, `npm run dev`.
2. Änderung mit Tests: Logik in `service.ts` mit Vitest, Oberfläche mit Playwright (`e2e/`). Konventionen für Module,
   Rechte und Löschfristen stehen unten („Konventionen“).
3. `npm run check` muss grün sein (TypeScript, ESLint, Lizenzprüfung, Vitest); bei Änderungen an der Oberfläche
   zusätzlich `npm run verify` (mit Build und E2E).
4. Ein Thema je PR, Beschreibung: was, warum, wie getestet. UI-Texte deutsch, Code und Bezeichner englisch.

Neue Abhängigkeiten nur mit AGPL-verträglicher Lizenz (`scripts/licenses.mjs`) und mit Begründung im PR.

## Konventionen

- Module liegen in `src/modules/<id>/` mit `manifest.ts`, `schema.ts` (Tabellen-Präfix `<id>_`), `service.ts` (reine
  Logik, getestet) und `actions.ts` (Server Actions).
- **Jede** Server Action prüft Rechte über `requirePermission()` aus `src/core/permissions` bzw. im Service. In Modulen
  kommen `requireUser`/`requirePermission` aus `moduleActions("<id>")` (`src/core/modules/guard.ts`) – das sperrt
  ausgeschaltete Module; Seiten je Modulordner per `layout.tsx` mit `requireModulePage()`, modul-eigene API-Routen per
  `moduleOffResponse()`.
- **Jede** neue Tabelle mit Personenbezug wird im Manifest unter `retention` einer Löschklasse zugeordnet
  (`src/core/retention.ts`, `docs/DATENSCHUTZ.md` §3), sonst wird `retention.test.ts` rot. Freitext mit Gesundheitsbezug
  vermeiden (Abwesenheiten: nur „krank“/„sonstiger Grund“).
- DB-Schema ändern: Tabelle in `src/core/db/schema.ts` bzw. Modul-`schema.ts` (dort nur relative Imports) →
  `npm run db:generate` → Migration in `drizzle/` mitcommitten.
- Neue Seiten nutzen die Komponenten aus `@schulos/ui` (`packages/ui`), keine Ad-hoc-Styles.
- Next.js immer mit Webpack (`next dev --webpack` / `next build --webpack`, in den npm-Skripten hinterlegt).
