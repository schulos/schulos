# Handbuch (Modul `hilfe`)

Freigegeben von der Projektleitung am 2026-10-28 (Fragebogen Runde 11). Aufgaben: `docs/BACKLOG.md`, Block „Handbuch“
(HB-01 ff.). Dieses Dokument hält Umfang, Datenmodell grob, Rechte, Datenschutz und Entscheidungen fest.

## Ziel

Ein schulinternes, durchsuchbares Nachschlagewerk „So läuft es bei uns“: Abläufe und Anleitungen für Personal, Schüler:innen
und Eltern an einer Stelle. Das Modul `hilfe` erscheint im Menü als „Handbuch“; ein „?“ in der Kopfzeile öffnet es.

Warum ein eigenes Modul: Beiträge der Neuigkeiten werden nach spätestens einem Jahr gelöscht und haben keine Gliederung;
Dateien sind an Mitglieder oder Eigentümer gebunden. Das Modul verwendet nur Bausteine der Neuigkeiten wieder
(Zielgruppen-Auflösung, Markdown, Suchanbieter- und Widget-Muster).

## Umfang

- **Stufe 1 (HB-01 bis HB-04):** Bereiche und Seiten (zwei Ebenen), Markdown-Editor, Zielgruppen je Seite (Rollen oder Gruppen,
  keine = alle), Reihenfolge, Entwurf/veröffentlicht, Verlinkung, Druckansicht, Volltextsuche und globale Suche, „?“ in der
  Kopfzeile, Ansprechperson je Seite, „Überprüfung fällig“ mit Gong (Vorgabe 12 Monate, abschaltbar).
- **Später (HB-05, HB-06):** Anhänge (PDF/Bilder, Typ-/Größenprüfung, Virenscan) und Seitenverlauf (letzte 10 Fassungen).
- **Starter-Seiten (HB-07):** wenige neutrale Vorlagen (Erste Schritte je Rolle, Zwei-Faktor, Krankmeldung, Kurswahl, Passwort
  vergessen), die die Schule kopiert und anpasst; keine automatische Aktualisierung, keine Fremdinhalte. Kontexthilfe: „?“ führt
  zur Seite des jeweiligen Moduls.

**Ausdrücklich nicht:** freies Wiki für alle, Kommentare/Diskussion (dafür Foren), Mehrsprachigkeit, Freigabe-Workflows mit
mehreren Stufen, Helpdesk/Tickets, Zugriff ohne Anmeldung.

## Datenmodell (grob)

Präfix `hilfe_`: `hilfe_sections` (Titel, Reihenfolge), `hilfe_pages` (Bereich, Titel, Text, Reihenfolge, Status,
Ansprechperson, Überprüfung fällig am, zuletzt geändert von/am), `hilfe_targets` (Seite, Rolle oder Gruppe), später
`hilfe_attachments` und `hilfe_revisions`. Volltextindex auf Titel und Text.

## Rechte

Lesen: jede angemeldete Person, Sichtbarkeit ausschließlich über die Zielgruppen der Seite; der Service filtert selbst.
`hilfe.edit` (Seiten und Bereiche anlegen, ändern, veröffentlichen; Vorgabe Verwaltung) und `hilfe.manage` (alle Seiten,
Verlauf, Starter-Vorlagen). Die Ansprechperson darf ihre eigene Seite bearbeiten. Funktionsgruppen (IT, Hausmeisterei,
Fachschaften) erhalten die Rechte über Gruppenrechte. Entwürfe sehen nur Pflegende.

## Datenschutz

Der Inhalt ist organisatorisch; Personenbezug entsteht nur durch Ansprechperson und Bearbeiter:in. Diese Verweise folgen dem
Konto (Löschklasse `LK-KONTO`, beim Löschen leer gesetzt); die Seiten selbst unterliegen keiner automatischen Löschfrist.
Der Editor weist darauf hin, dass keine Schülerdaten sowie keine Gesundheits- oder Notendaten in Seiten gehören. Anhänge
werden vor dem Speichern geprüft. Kein Zugriff ohne Anmeldung. Verarbeitungszweck für das Verzeichnis: interne Hilfe und
Anleitungen. Rechtliche Einordnung: zu prüfen.

## Entscheidungen (Projektleitung 2026-10-28)

1. Eigenes kleines Modul `hilfe` statt Erweiterung von Neuigkeiten oder Dateien.
2. Pflege über `hilfe.edit` plus Ansprechperson für die eigene Seite.
3. Neutrale Starter-Seiten werden mitgeliefert.
4. Überprüfungs-Erinnerung mit Vorgabe 12 Monate, Gong, abschaltbar.
5. Zwei Gliederungsebenen (Bereich → Seite).
6. Sichtbarkeit über Zielgruppen; Starter-Seiten für Eltern und Schüler:innen vorbelegt sichtbar, eigene Seiten nur Personal.
7. Anhänge und Verlauf später, Stufe 1 nur Text.
8. Menüname „Handbuch“, „?“ in der Kopfzeile.
