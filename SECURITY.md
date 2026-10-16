# Sicherheitslücken melden

**Bitte keine öffentlichen Issues, Diskussionen oder Pull Requests für Sicherheitslücken.**

Melden Sie Schwachstellen vertraulich über **GitHub Security Advisories**: im Repository unter
*Security → Advisories → Report a vulnerability* („Privately report a vulnerability“). Die Meldung sehen nur die
Betreuenden des Projekts.

Hilfreich sind:

- betroffene Version (Verwaltung → System bzw. `schulosctl version`) oder Commit,
- Komponente (Hauptsystem, Backupserver, Backup-Agent, `schulosctl`, Installer/ISO),
- Schritte zum Nachvollziehen und erwartete Auswirkung,
- ob die Lücke bereits anderen bekannt oder öffentlich ist.

Bitte **keine echten personenbezogenen Daten** (Schüler:innen, Eltern, Personal) in Meldungen, Screenshots oder
Anhängen – zum Nachstellen gibt es die Demo-Schule (`npm run db:reset`, Logins in `README.md`).

## Was Sie erwarten können

SchulOS ist ein **Vorschau-Projekt ohne Support** (siehe `README.md`). Die Betreuung geschieht in der Freizeit, es gibt
keine zugesagten Reaktionszeiten. Wir bemühen uns,

- den Eingang einer Meldung innerhalb von **14 Tagen** zu bestätigen,
- bestätigte Lücken in einem Patch-Release zu beheben (Kennzeichnung „sicherheit“ in den Release-Notizen; Server mit
  automatischen Patch-Updates bekommen es im nächsten Wartungsfenster),
- die Meldung nach der Behebung als Advisory zu veröffentlichen und – wenn gewünscht – Sie dort zu nennen.

## Unterstützte Versionen

Nur das jeweils **neueste Release** (Kanal „stabil“ bzw. „beta“) bekommt Sicherheitskorrekturen. Ältere Versionen
werden nicht nachgepflegt; ein Update ist immer nur von der direkt vorigen Minor-Version aus vorgesehen
(`docs/INSTALLATION.md` §5a.2).

## Geltungsbereich

Im Geltungsbereich: der Code in diesem Repository, die veröffentlichten Images (`ghcr.io/…/schulos*`), die Release-ISO
und `schulosctl`. Nicht im Geltungsbereich: Lücken in Fremdkomponenten (Node.js, PostgreSQL, Caddy, Debian …) – bitte
an das jeweilige Projekt melden; Fehlkonfigurationen einzelner Installationen; Angriffe, die physischen Zugriff auf
einen entsperrten Server oder ein Admin-Konto voraussetzen; Last-/DoS-Tests gegen fremde Installationen.

Bitte testen Sie nur gegen eigene Installationen (z. B. die Demo-Instanz aus der ISO oder `docker compose`), nie gegen
Server von Schulen.

Wie SchulOS Sicherheit umsetzt (Bedrohungsmodell, Prüfungen, Härtung): `docs/SICHERHEIT.md`.
