# Web-Push – Weckruf bei geschlossener App (nur nach DSB-Votum)

Freigegeben von der Projektleitung am 2026-11-01 (Fragebogen Runde 12) **unter dem Vorbehalt eines positiven schriftlichen Votums der/des
Datenschutzbeauftragten**. Aufgaben: `docs/BACKLOG.md`, Block „Web-Push“ (WP-01 ff.).

**Vorbemerkung:** Bis zum Votum gilt die Vorgabe „Kein Push“ (`docs/DSB-FRAGEN.md` §5, DATENSCHUTZ §5). Dieses Dokument beschreibt die
Umsetzung für den Fall eines positiven Votums; vorher wird nichts gebaut außer der Ergänzung der DSB-Fragen (WP-01).

## Problem und Nutzen

- **Lehrkräfte:** Vertretung, Messenger- und Elternbrief-Antworten sehen sie heute nur beim Öffnen von SchulOS oder per Mail (falls SMTP eingerichtet ist).
- **Schüler:innen:** Ausfall/Vertretung am Morgen, neue Aufgaben, Nachrichten; stärkster Nutzen laut Q-50 („hoch gewünscht“).
- **Eltern:** Elternbriefe, Rückfragen, Sprechtag-Termine; private Geräte, daher Push neben Mail der einzig realistische Kanal.
- **Sekretariat, Schulleitung:** weniger Rückfragen „haben Sie die Mitteilung gesehen?“; Pflichtmitteilungen laufen weiter über Gong/Mail,
  Push ist nie der einzige Zustellweg.
- **Admin:** Schalter und Überblick, ob Push genutzt wird.

## Umfang

**Gehört dazu**

1. Opt-in je **Gerät** (nie je Konto vorbelegt, nie Standard): Profil → Benachrichtigungen → „Push auf diesem Gerät“, der Browser fragt
   nach der Berechtigung; jederzeit abschaltbar.
2. Nutzlast **ohne Namen und Inhalt**: festes Muster „Neue Benachrichtigung in SchulOS“ ohne Absender, Betreff, Namen, mit Link; Inhalte
   werden erst nach Anmeldung in der App geladen. Ereignisse wählbar je Kategorie (Gong-Eintrag, Vertretung für mich, neue Nachricht).
3. Schulweiter Hauptschalter (Standard **aus**) und Rollenfreigabe: Personal und Eltern ab Start, Schüler:innen schulweit einschaltbar (Standard aus).
4. Eigene VAPID-Schlüssel je Installation (Geheimnis im `config`-Volume, im Backup, nicht im Export), Zustellung per `web-push` vom Server.
5. Abmelden entfernt das Gerät; Antworten 404/410 des Push-Dienstes löschen das Abonnement automatisch.
6. Ruhezeiten in Stufe 1 fest: 20–6 Uhr und Wochenende kein Push (Gong/Mail bleiben).

**Ausdrücklich nicht:** Inhalte, Namen, Fächer oder Notenbezüge in der Nutzlast; Push für Notenbuch, Krankmeldung, Datenschutzfälle; Push
ohne Gong-/Mail-Entsprechung; Anbieter-SDKs; Pflicht-Push.
**Spätere Stufen:** einstellbare Ruhezeiten; Sammelnachricht je Zeitfenster („3 neue“); Push für Fälligkeiten; Mail als Rückfallebene
bei nicht zugestelltem Push.

## Umsetzung

- **Modul:** neues Kernstück `src/core/push/` (`service.ts`, `vapid.ts`, `actions.ts`) statt eigenem Modul, denn alle Module benachrichtigen über
  den Gong. Einhängepunkt: `src/core/notifications/index.ts` (nach dem Speichern eines Eintrags und `publish` aus `bus.ts` einen Push-Job
  einreihen; vorhandene Bündelung `bundleKey` nutzen, damit nicht je Eintrag gepusht wird).
- **Service Worker:** `src/core/pwa/service-worker.ts` (ausgeliefert von `src/app/sw.js/route.ts`, Regeln in `service-worker.test.ts`) um
  `push`- und `notificationclick`-Handler erweitern; die Regel „keine Inhalte zwischenspeichern“ bleibt, der Handler zeigt nur den festen
  Text. `docs/SICHERHEIT.md` S63 und Test ergänzen.
- **Tabellen (Präfix `push_`):** `push_subscriptions` (id, user_id, Endpunkt-URL, Schlüssel `p256dh`/`auth`, Gerätebezeichnung grob, created_at,
  last_ok_at, last_error); `push_prefs` (user_id, Kategorien). Endpunkt und Schlüssel sind geheim: nie in Listen für andere, nicht in
  Exporten und Logs.
- **Rechte:** eigene Abos verwalten = angemeldete Person (Eigenzugriff, trotzdem Prüfung in der Action); Hauptschalter/Rollenfreigabe =
  vorhandenes Verwaltungsrecht für Einstellungen. Server Actions mit `requireUser`/`requirePermission`.
- **Moduleinstellungen:** `push.enabled` (Standard aus), `push.roles`, `push.categories`; der Schalter im Profil ist nur sichtbar, wenn aktiv und
  die Rolle erlaubt ist.
- **Live-Kanal:** keiner zusätzlich; der SSE-Gong (`src/core/notifications/stream.ts`) bleibt, Push ist nur der Weckruf. **Mail:** unverändert;
  Admin-Alarm bei dauerhaft fehlschlagender Zustellung über `src/core/system/alarms.ts`.
- **Netz/Betrieb:** Der Server braucht **ausgehend** HTTPS zu den Push-Diensten der Browserhersteller; bei „Server nur im Schulnetz“ ist die
  Ausgangsfreigabe zu prüfen und im Installer/Handbuch zu nennen. Service Worker und Push brauchen vertrauenswürdiges TLS: Push erst, wenn
  ein öffentlich vertrauenswürdiges Zertifikat möglich ist; bei eigener CA nur auf Geräten mit verteilter Root. Abhängigkeit zu
  `docs/ZERTIFIKATE.md`.
- **Installer/Backup:** VAPID-Schlüssel im `config`-Volume (wird gesichert); Installer nur Hinweis, keine Pflichtfrage.
- **Doku:** DATENSCHUTZ §5 und DSB-FRAGEN §5 (Vorgabe ändern), VVT-Eintrag „Push-Benachrichtigung“, Hilfeseite für Nutzende (iPhone/iPad nur
  bei installierter App; Datenfluss zu den Browserherstellern), Handbuch.

## Datenschutz

- **Personenbezug:** Das Abonnement (Endpunkt-URL, Schlüssel, Gerätebezeichnung) ist an das Konto gebunden, also personenbezogen; es sind
  Betriebsdaten, keine Inhaltsdaten. Löschen bei Abmelden, Konto-Deaktivierung oder 90 Tage ohne erfolgreiche Zustellung; Eintrag im
  Manifest unter `retention` (`src/core/retention.ts`) ist Pflicht, sonst wird `retention.test.ts` rot.
- **Dritte:** Push-Dienste der Browserhersteller sehen Metadaten (Zeitpunkt, Endpunkt als pseudonyme Gerätekennung, Größe); die Nutzlast
  ist verschlüsselt (RFC 8291) und enthält ohnehin keine Inhalte. Dazu gehört eine Drittlandübermittlung (USA) – vom DSB zu bewerten;
  Rechtsgrundlage Einwilligung (freiwillig, widerrufbar); bei Minderjährigen Hinweis in den Elterninformationen.
- **Sichtbarkeit:** Nutzer:in sieht eigene Geräte; Admin sieht nur Anzahlen je Rolle (keine Endpunkte); Lehrkräfte und Schulleitung sehen
  nichts über die Push-Nutzung anderer.
- Der Opt-in-Text nennt Browserhersteller, USA-Übermittlung, Datenfluss und Widerruf; der Zeitpunkt der Einwilligung steht im Audit-Protokoll.

## Aufgaben (Größe)

| Nr. | Aufgabe | Größe | Abhängigkeit |
|---|---|---|---|
| WP-01 | DSB-Fragen ergänzen: neues Thema in der DSB-Checkliste (`checkliste.ts`), `docs/DSB-FRAGEN.md` neu erzeugen, Test grün | S | – (jetzt dran) |
| WP-02 | Tabellen, Migration, `retention`, VAPID-Schlüsselablage, Service mit Tests | M | WP-01, DSB-Votum |
| WP-03 | Service-Worker-Handler, Anpassung `service-worker.test.ts`, SICHERHEIT S63 | S–M | WP-02 |
| WP-04 | Zustellung: Einhängen in den Gong, Bündelung, Ruhezeiten, Fehlerbehandlung 404/410, Job | M | WP-02 |
| WP-05 | UI im Profil (Opt-in, Geräteliste, Kategorien) + Hauptschalter/Rollenfreigabe | M | WP-02, WP-04 |
| WP-06 | Betrieb: Ausgangsfreigabe/Installerhinweis, Alarm bei Dauerfehler | S | WP-04 |
| WP-07 | Datenschutzdokumente, Hilfe/Handbuch, E2E-Test mit Mock-Push-Dienst | M | WP-02…05 |

Gesamt **L** (Code etwa M–L; Engpässe sind das DSB-Votum und gültiges TLS auf den Endgeräten). Alle Aufgaben außer WP-01 erst nach DSB-Votum.

## Entscheidungen (Projektleitung 2026-11-01)

- **wp-1** Einführung nur nach positivem schriftlichem Votum und mit Standard „aus“. – wie vorgeschlagen
- **wp-2** Personal und Eltern ab Start, Schüler:innen schulweit einschaltbar (Standard aus). – wie vorgeschlagen
- **wp-3** Festes Muster „Neue Benachrichtigung in SchulOS“ ohne Absender, Betreff, Namen. – wie vorgeschlagen
- **wp-4** Opt-in je Gerät mit Hinweistext (Browserhersteller, USA-Übermittlung, Widerruf), Zeitpunkt im Audit; bei Minderjährigen Hinweis in den Elterninformationen. – wie vorgeschlagen
- **wp-5** Abonnements löschen bei Abmelden/Konto-Deaktivierung, sonst nach 90 Tagen ohne erfolgreiche Zustellung. – wie vorgeschlagen
- **wp-6** Push erst, wenn ein öffentlich vertrauenswürdiges Zertifikat möglich ist; bei eigener CA nur auf Geräten mit verteilter Root. – wie vorgeschlagen
- **wp-7** Ruhezeiten in Stufe 1 fest 20–6 Uhr und Wochenende kein Push (Gong/Mail bleiben). – wie vorgeschlagen
- **rf-1** Reihenfolge der Runde 12: nur DSB-Fragen ergänzen (WP-01), Bau nach Votum. – wie vorgeschlagen
