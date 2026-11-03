# Fachraum-Prüfungen (GS-01…GS-03)

Gefahrstoffe/Chemie-Sammlung im Prüfkatalog von Gebäude & Technik. Freigegeben von der Projektleitung 2026-11-02 (Runde 13),
erweitert Q-23 („zunächst die 12 Prüfarten“). Aufgaben: docs/BACKLOG.md, Abschnitt „Fachraum-Prüfungen“.

> **Keine Rechtsberatung.** Prüfarten, Intervalle und Quellen sind eine Vorlage zum Prüfen („zu prüfen“). Maßgeblich sind Schulträger,
> Fachkraft für Arbeitssicherheit, Unfallkasse und die jeweils gültigen Regeln (u. a. RISU-NRW, GefStoffV, DGUV Regel 113-018,
> StrlSchV). SchulOS behauptet keine Rechtsverbindlichkeit.

## Problem und Nutzen

- **Fachschaft Chemie/Naturwissenschaften:** RISU-NRW, GefStoffV und DGUV Regel 113-018 verlangen wiederkehrende Prüfungen in Fachräumen
  (Abzüge, Notduschen, Sicherheitsschränke, Gefahrstoffverzeichnis). Bisher Tabelle/Papier; Fristen gehen unter, weil die Erinnerungen nur
  an die Hausmeisterei (`gebaeude.manage`) gingen.
- **Schulleitung:** Nachweis gegenüber Unfallkasse/Schulträger an einer Stelle (Prüfliste, CSV), gleiche Ampel wie bei den Gebäude-Prüfungen.
- **Hausmeisterei:** muss Fachschafts-Prüfungen nicht mitverwalten, sieht sie aber weiter.

## Entscheidungen (Projektleitung 2026-11-02)

1. **Umfang:** Chemie/NW-Fachräume + Strahlenschutz Physik; Biologie (Biostoffe) später.
2. **Zuständigkeit:** Gruppe je Prüfart (z. B. Fachschaft) bekommt Erinnerungen und erfasst; Hausmeisterei sieht alles.
3. **Gefahrstoffverzeichnis:** keine Datenbank (kein Chemikalienkataster), nur Prüffrist „Verzeichnis aktualisiert“ mit PDF-Anhang.

## Umgesetzt

### GS-01 Vorlage und Anlagenarten

Sieben neue Prüfarten in `INSPECTION_TEMPLATE` (`src/modules/gebaeude/pruefarten.ts`, Liste `FACHRAUM_TEMPLATE_KEYS`), wie die zwölf
bisherigen **ausgeschaltet** und mit Quelle „… – zu prüfen“:

| Schlüssel | Prüfart | gilt für | Intervall (Annahme) | zuständig (Vorgabe) | Quelle (Hinweis) |
|---|---|---|---|---|---|
| `laborabzuege` | Laborabzüge (Fachraum) | Anlage, Kategorie „Laborabzug“ | 12 Monate | externe Firma | DIN EN 14175, DGUV Regel 113-018, RISU-NRW |
| `notduschen` | Augen- und Körpernotduschen (Funktionsprobe) | Anlage, Kategorie „Augen-/Körpernotdusche“ | 1 Monat, Vorwarnung 7 Tage | Schule | DIN EN 15154, DGUV Regel 113-018, RISU-NRW |
| `sicherheitsschraenke` | Sicherheitsschränke für Gefahrstoffe | Anlage, Kategorie „Sicherheitsschrank für Gefahrstoffe“ | 12 Monate | externe Firma | DIN EN 14470-1, TRGS 510, DGUV Regel 113-018 |
| `gasversorgung-not-aus` | Gasversorgung und Not-Aus im Fachraum | Raum | 12 Monate | Schule | DGUV Regel 113-018, RISU-NRW, DGUV Vorschrift 3 |
| `gefahrstoffverzeichnis` | Gefahrstoffverzeichnis aktualisieren und Bestand aussondern | Gebäude | 12 Monate | Schule | GefStoffV § 6 Abs. 12, RISU-NRW |
| `gefaehrdungsbeurteilung-fachraum` | Gefährdungsbeurteilungen Fachraum überprüfen | Raum | 12 Monate | Schule | GefStoffV § 6, ArbSchG § 5, RISU-NRW |
| `strahlenschutz-dichtheit` | Strahlenschutz: Dichtheitsprüfung radioaktiver Präparate | Raum (Physiksammlung) | 12 Monate, Vorwarnung 60 Tage | externe Firma | StrlSchV, RISU-NRW |

- **Anlagenarten als Kategorie-Vorlagen** (nach INV-01, keine Enum-Werte): `abzug` (Präfix AB), `notdusche` (ND), `sicherheitsschrank`
  (SSG), alle mit Prüfpflicht, in `ASSET_CATEGORY_TEMPLATE` (`kategorien.ts`); Kurzformen für den CSV-Import (Laborabzug, Digestorium,
  Augendusche, Gefahrstoffschrank …). Ein Mangel an diesen Anlagen wird eine Meldung der Kategorie „Sicherheit“.
- **Bestehende Installationen:** `ensureTemplate`/`ensureCategories` fügen fehlende Schlüssel beim nächsten Aufruf hinzu
  (`onConflictDoNothing`), ausgeschaltet; angepasste Einträge bleiben. Kein Installer-/Backup-Eingriff, keine Daten-Migration.
- Die Oberfläche (Prüfarten) zeigt die Fachraum-Prüfarten als eigene Liste „Fachraum-Prüfungen“ mit Hinweis.

### GS-02 Zuständige Gruppe je Prüfart

- Spalte `gebaeude_inspection_types.responsible_group_id` (FK `groups`, `on delete set null`), Migration `0129_gs_02_zustaendige_gruppe.sql`.
  Setzen nur mit `gebaeude.configure` (Prüfarten-Formular, Feld „zuständige Gruppe“); auswählbar sind Funktionsgruppen (Fachschaft,
  Gremium, AG, frei) wie bei den Zuständigkeiten je Meldungskategorie – Klassen/Kurse nicht, sonst wären Schüler:innen zuständig.
  Wechsel im Audit-Log (`gebaeude.inspection_type.group`).
- **Zuständig** sind aktive **Beschäftigte** der Gruppe, deren Konto nicht gesperrt ist (`responsibleInspectionTypes`, wie die
  verantwortliche Gruppe einer Inventar-Kategorie, inv-4). Schüler:innen in der Gruppe zählen nie.
- **Rechte (Service-Grenze):** Mitglieder sehen unter `/gebaeude/pruefungen` nur die Prüfarten ihrer Gruppen, planen, erfassen (mit
  Protokoll-PDF) und streichen offene Prüfungen **nur dieser Arten**; Protokolle ihrer Prüfarten können sie herunterladen. Alles andere
  bleibt bei `gebaeude.manage`/`view_all`. Prüfliste und CSV bleiben Nachweise für „alles lesen“. Planen ist neu im Audit-Log
  (`gebaeude.inspection.plan`).
- **Erinnerungen und Alarm-Gong:** der nächtliche Lauf (`runInspectionReminders`, Job „gebaeude-fristen“) fasst je zuständiger Gruppe
  zusammen – „Prüfungen (Fachschaft Chemie): 1 überfällig“ geht an die Gruppenmitglieder (Link mit Filter „meine Zuständigkeit“),
  nicht mehr an die Hausmeisterei. Hat die Gruppe keine aktiven Beschäftigten, fällt die Erinnerung an `gebaeude.manage` zurück.
- **Filter „meine Zuständigkeit“** (`?zustaendig=meine`) für alle, die alles sehen und selbst in einer zuständigen Gruppe sind;
  Gruppenmitglieder ohne `view_all` sind immer darauf beschränkt und finden die Seite über „Prüfungen meiner Zuständigkeit“ auf
  Gebäude & Technik.

### GS-03 Doku und E2E

- Handbuch-Starter-Seite **„Fachraum-Prüfungen“** (Bereich Gebäude & Technik, nur Personal) mit Hinweis „zu prüfen – keine
  Rechtsberatung“ und den Quellen; SICHERHEIT S103; E2E `e2e/fachraum.spec.ts` (Verwaltung setzt Gruppe, Fachschaft plant und erfasst
  am Handy 360 px dunkel mit axe inkl. Zielgröße, Lehrkraft ohne Gruppe 404).

## Konservativ entschieden (offene Detailfragen, ohne Rückfrage)

- **Alarm-Mail:** die Mail an die Alarm-Adresse des Betriebs (SMTP-Konfiguration) bleibt unverändert und nennt weiter **alle**
  überfälligen Prüfungen; an die Gruppe geht der tägliche Gong (Benachrichtigung). Keine neuen Mails an persönliche Adressen.
- **Streichen** offener Prüfungen gehört zum Planen und ist für die zuständige Gruppe erlaubt (nur eigene Prüfart, nur offene).
- **Mangel erfassen** braucht zusätzlich das Melderecht (`gebaeude.report`, Vorgabe für Lehrkräfte/Personal), weil daraus eine Meldung
  entsteht; ohne Recht kommt eine Feldmeldung statt eines halben Eintrags.
- **Keine Vorbelegung der Gruppe:** Die Vorlage nennt keine Gruppe; die Schule wählt sie (Fachschaften heißen überall anders).
- **Demo-Daten unverändert** (Fachraum-Prüfarten bleiben aus), damit bestehende Demo-Abläufe und Zählungen gleich bleiben.
- **Prüfliste/CSV** bleiben bei „alles lesen“; die Gruppe sieht ihre Nachweise in der Liste (Stand „erledigt“) mit Protokoll.
- **Strahlenschutz** als Raum-Prüfung (Physiksammlung), nicht als Anlage – sonst würden alle Geräte der Kategorie „Fachsammlungen“
  automatisch geplant.

## Datenschutz

Kein neuer Personenbezug: Prüfungen bleiben ohne Prüfer:in (Firma statt Person), Protokoll-PDF und Bemerkung unter der bestehenden
Regel (LK-1J, `gebaeude.report_keep`). Die Gruppenzuordnung ist ein Organisationsdatum. Erinnerungen nennen Prüfart, Gegenstand und Termin.

## Nicht im Umfang

Chemikalienkataster (Stoffe, H-/P-Sätze, Mengen, Betriebsanweisungen), Unterweisungsnachweise je Person, Biologie (Biostoffe).
