# SchulOS – Betriebshandbuch

Rahmen für den laufenden Betrieb einer SchulOS-Installation: wohin man schaut, wenn etwas zu tun ist, und – als eigenes Kapitel –
was bei einer **Datenpanne** zu tun ist. Das Dokument ersetzt die Fachdokumente nicht, sondern verweist auf sie. Es ist öffentlich;
Namen, Telefonnummern und Adressen trägt die Schule in ihrem **eigenen Exemplar** ein (Ausfüllfelder in Kapitel 3).

Alle Rechtsaussagen sind Planungsannahmen – **zu prüfen** durch die bzw. den Datenschutzbeauftragten der Schule (DSB). Landesrechtliche
Besonderheiten sind nicht abschließend bekannt und als „zu prüfen“ gekennzeichnet.

## 1. Inhalt und Verweise

| Thema | Wo nachlesen |
|---|---|
| Installation, Rollen Hauptsystem/Backupserver, Betrieb, `schulosctl` | [INSTALLATION.md](INSTALLATION.md) §2, §3, §5 |
| Sicherung, Offsite-Kopie, **Wiederherstellung** | [INSTALLATION.md](INSTALLATION.md) §4 (insbesondere §4.3a unveränderliche Offsite-Kopie, §4.4 Wiederherstellung) |
| Außenzugang, Gerätezertifikate | [INSTALLATION.md](INSTALLATION.md) §5b, §5c |
| Updates (Betriebssystem und SchulOS), Rückweg | [INSTALLATION.md](INSTALLATION.md) §5a |
| Bedrohungsmodell, Annahmen, Grenzen | [SICHERHEIT.md](SICHERHEIT.md) |
| Datenschutz: Löschkonzept, TOM (Art. 32), Organisatorisches | [DATENSCHUTZ.md](DATENSCHUTZ.md) §3, §6, §7 |
| Aufgaben der Schule beim Datenschutz (DSB-Checkliste) | [DSB-FRAGEN.md](DSB-FRAGEN.md), in SchulOS unter Verwaltung → Datenschutz → Einrichtung |
| **Datenpanne** (Art. 33/34 DSGVO) | Kapitel 2 bis 6 dieses Dokuments, Vorlagen in [vorlagen/](vorlagen/) |

## 2. Datenpanne – was ist das und wer macht was?

### 2.1 Was ist eine Datenpanne?

Eine Verletzung des Schutzes personenbezogener Daten (Art. 4 Nr. 12 DSGVO): Daten gehen **verloren, werden verändert, offengelegt oder
sind für Unbefugte zugänglich** – absichtlich oder versehentlich. Es kommt nicht darauf an, ob schon etwas „passiert“ ist; auch der
begründete Verdacht ist sofort zu melden (intern), die Einschätzung folgt danach.

Beispiele aus dem Schulalltag:

- Elternbrief, E-Mail oder Zeugnisliste geht an den falschen Verteiler oder mit sichtbaren Empfängern an alle.
- USB-Stick, Laptop, Tablet oder Handy mit Schülerdaten (Klassenliste, Fotos, Notentabelle) ist verloren oder gestohlen.
- Ein Konto wurde übernommen (Passwort weitergegeben, auf einer Fälschungsseite eingegeben, Gerät in fremden Händen).
- Ausdruck oder Export (Auskunft, Zugangsdaten-Liste, Klassenliste) liegt offen herum oder wurde falsch weitergegeben.
- Eine Einstellung zeigt Daten zu Unrecht an (zu weit vergebene Rechte, falsche Zielgruppe einer Mitteilung).
- Einbruch in den Server, Schadsoftware, Verschlüsselung der Daten (Kapitel 6).
- Ein Backup-Datenträger oder der Wiederherstellungsschlüssel ist verloren.

Keine Datenpanne im engeren Sinn, aber trotzdem zu melden und zu klären: Beinahe-Pannen und Ausfälle ohne Datenbezug (z. B. Server
wegen Defekt kurz nicht erreichbar). Ein **dauerhafter Verlust** der Verfügbarkeit (Daten weg, keine Sicherung) ist dagegen eine Panne.

### 2.2 Rollen (Entscheidung der Projektleitung 2026-10-28)

| Rolle | Aufgabe in der Panne |
|---|---|
| **Alle Beschäftigten** | Verdacht **sofort** der Schulleitung und der bzw. dem DSB melden (Dienstanweisung, Baustein in der DSB-Checkliste, Thema „Datenpanne“). Nichts löschen, nichts „reparieren“. |
| **Schulleitung** (Verantwortliche) | **Entscheidet** über Meldung an die Aufsichtsbehörde und über die Benachrichtigung Betroffener; hält die Frist im Blick. |
| **DSB** | **Berät**, schätzt das Risiko mit ein, **füllt die Meldung aus** (Vorlage), führt die Dokumentation, ist Ansprechstelle der Aufsicht. |
| **Admin / Betreiber** | **Liefert die Technik**: Was ist passiert, welche Daten und wie viele Personen, wann bekannt geworden, welche Sofortmaßnahmen (Kapitel 4). Meldet **unverzüglich** an die Schule (Art. 33 Abs. 2 DSGVO, wenn nicht die Schule selbst betreibt – Auftragsverarbeiter). |
| **Schulträger / IT-Dienstleister** | Je nach Betriebsmodell einbeziehen (Netz, Endgeräte, Verträge). Ob und wie er zu informieren ist: zu prüfen (Dienstanweisung, Vertrag). |

Die Schule ist Verantwortliche (Art. 4 Nr. 7 DSGVO); der Betreiber der Instanz ist – sofern er nicht selbst zur Schule gehört –
Auftragsverarbeiter und entscheidet nichts über Meldungen.

### 2.3 Ablauf mit Zeitachse

Die **72-Stunden-Frist** (Art. 33 Abs. 1 DSGVO) beginnt, sobald die Schule als Verantwortliche **Kenntnis** hat, also mit hinreichender
Sicherheit weiß, dass eine Verletzung vorliegt – nicht erst nach Abschluss der Untersuchung. Wochenenden und Ferien zählen mit
(zu prüfen). Wer den Verdacht hat, hält Datum und Uhrzeit fest („T0“). Meldet der Betreiber der Schule, kommt es auf den Zeitpunkt an, zu
dem die Schule davon erfährt – der Betreiber muss aber **unverzüglich** melden, nicht erst nach eigener Prüfung.

| Schritt | Wann | Wer | Was |
|---|---|---|---|
| 1. Erkennen | T0 | alle | Auffälligkeit bemerken (Fehlversand, Verlust, Alarm-Mail, Hinweis von Dritten). Zeit und Beobachtung notieren. |
| 2. Intern melden | sofort, am selben Tag | alle → Schulleitung, DSB, ggf. Admin/Betreiber | Persönlich oder telefonisch (Kontakte in Kapitel 3), danach kurz schriftlich. Nicht per SchulOS-Nachricht, wenn das Konto betroffen sein könnte. |
| 3. Eindämmen | sofort, parallel zu 4 | Admin/Betreiber, ggf. Beschäftigte | Weitere Offenlegung stoppen (Kapitel 4). **Beweise nicht vernichten** (Protokoll, Logs, betroffene Geräte unverändert lassen). |
| 4. Einschätzen | möglichst am ersten Tag | DSB mit Schulleitung und Admin | Welche Daten, wie viele Personen, welche Kategorien (Minderjährige, Gesundheitsbezug „krank“, Noten, Zugangsdaten)? Wie wahrscheinlich und wie schwer sind Folgen für die Betroffenen? Ergebnis: **kein Risiko / Risiko / hohes Risiko** – mit Begründung. |
| 5. Entscheiden und melden | **spätestens 72 h nach T0** | Schulleitung entscheidet, DSB füllt aus | Bei **voraussichtlich kein Risiko** keine Meldung (Begründung dokumentieren, Schritt 7). Sonst Meldung an die Aufsichtsbehörde mit der Vorlage [DATENPANNE-MELDUNG.md](vorlagen/DATENPANNE-MELDUNG.md). Fehlen noch Angaben: **trotzdem fristgerecht** melden und Rest nachliefern (Art. 33 Abs. 4); bei Verspätung die Gründe angeben (Abs. 1). |
| 6. Betroffene benachrichtigen | **unverzüglich**, wenn **hohes Risiko** | Schulleitung (DSB berät) | Mit [DATENPANNE-BENACHRICHTIGUNG.md](vorlagen/DATENPANNE-BENACHRICHTIGUNG.md) in klarer, einfacher Sprache; bei Minderjährigen an die Eltern. Ausnahmen nach Art. 34 Abs. 3 (z. B. Daten waren nachweislich verschlüsselt, Risiko durch Maßnahmen abgewendet) sind zu prüfen und zu begründen. |
| 7. Dokumentieren | laufend, spätestens bei Abschluss | DSB | Jeden Fall – **auch nicht gemeldete** – mit [DATENPANNE-DOKUMENTATION.md](vorlagen/DATENPANNE-DOKUMENTATION.md) festhalten (Art. 33 Abs. 5). |
| 8. Ursache beheben, Lehren | nach der Akutphase | Schulleitung, DSB, Admin | Ursache beseitigen, Rechte/Einstellungen/Unterweisung anpassen, Dienstanweisung prüfen, Ergebnis in der Dokumentation vermerken. |

**Weitere Wege – jeweils zu prüfen, nicht automatisch Pflicht:** Information des Schulträgers, der Schulaufsicht oder der
Dienstherrenseite nach Dienstanweisung oder Erlass des Landes; Strafanzeige bei Straftaten (Einbruch, Erpressung, Ransomware);
Meldung an die Versicherung; Hinweis an Dienstleister. **Pflichtweg nach der DSGVO ist nur die Aufsichtsbehörde** (Art. 33) – für
die übrigen Wege entscheidet die Schulleitung nach Beratung durch die bzw. den DSB.

### 2.4 Ablage und Aufbewahrung

Ausgefüllte Meldungen, Dokumentationen und Benachrichtigungen enthalten selbst personenbezogene Angaben. Sie gehören **in die Akte der
bzw. des DSB** – nicht in SchulOS (keine Dateien, Mitteilungen, Foren, Handbuch-Seiten), nicht in allgemeine Laufwerke und nicht
per ungeschützter E-Mail. **Aufbewahrung der Dokumentation: 3 Jahre ab Abschluss des Falls** (Vorschlag der Projektleitung
2026-10-28 als Nachweis gegenüber der Aufsicht; Entscheidung und Vermerk im VVT/Löschkonzept der Schule), danach vernichten.

## 3. Rollen und Kontakte (Ausfüllfelder)

In das **eigene Exemplar** der Schule eintragen, ausdrucken und an einem Ort ablegen, der auch bei Ausfall von SchulOS erreichbar ist
(Sekretariat, Schulleitungsbüro, Akte der DSB). Die Angaben zu DSB und Betreiber stehen in SchulOS unter Verwaltung → Datenschutz →
Hinweise und VVT.

| Rolle | Name | Telefon (auch außerhalb der Dienstzeit) | E-Mail | Vertretung |
|---|---|---|---|---|
| Schulleitung | | | | |
| Datenschutzbeauftragte:r (DSB) | | | | |
| Admin / Betreiber von SchulOS | | | | |
| Schulträger / IT-Dienstleister | | | | |
| Zuständige Aufsichtsbehörde (Datenschutz) | | | Meldeweg (Formular, Adresse): | – |
| Polizei / Versicherung (bei Bedarf) | | | | – |

Zuständig ist die Datenschutzaufsicht des Landes, in dem die Schule liegt (bei öffentlichen Schulen in Nordrhein-Westfalen
voraussichtlich die Landesbeauftragte für Datenschutz und Informationsfreiheit – zu prüfen). Meldeweg und Formular auf der Seite der
Behörde nachsehen und hier eintragen.

## 4. Ereignis → Sofortmaßnahme in SchulOS

Menüpfade gelten für Konten mit den passenden Verwaltungsrechten; Rechte und Module im Detail: Verwaltung → Rechte & Module.
`schulosctl` läuft **auf dem Hauptsystem** (Konsole oder SSH aus dem Schulnetz, INSTALLATION.md §5) mit `sudo`.

| Ereignis | Sofortmaßnahme | Fundstelle |
|---|---|---|
| Konto vermutlich übernommen (Phishing, Passwort weitergegeben, Gerät in fremden Händen) | **Konto sperren**: Verwaltung → Benutzer → Person → „Sperren“ – beendet alle Sitzungen sofort. Danach „Passwort zurücksetzen“ (neues Zufallspasswort, altes sofort ungültig, **Wechsel bei der nächsten Anmeldung erzwungen**, Sitzungen beendet). Erst entsperren, wenn die Person ihr Gerät bzw. ihren zweiten Faktor wieder sicher hat. | Verwaltung → Benutzer → Person; DATENSCHUTZ.md §6 (Sitzungen, Passwörter) |
| Zweiter Faktor (Code-App, Sicherheitsschlüssel) verloren oder in fremden Händen | Verwaltung → Benutzer → Person → „Zwei-Faktor zurücksetzen“: entfernt Code-App und Sicherheitsschlüssel, **beendet alle Sitzungen**, macht eine Code-Liste ungültig; die Person richtet neu ein. | Verwaltung → Benutzer → Person; DATENSCHUTZ.md §6 (Zwei-Faktor) |
| Admin- oder Verwaltungskonto übernommen bzw. Admin ausgesperrt | Auf dem Server: `sudo schulosctl reset-admin [name]` – neues Zufallspasswort (bei der Anmeldung zu ändern), zweiter Faktor aus (wird bei der Anmeldung neu verlangt), Sperre weg, **Sitzungen beendet**, Eintrag im Protokoll. Konten mit mehr Rechten als die handelnde Person lassen sich in der Oberfläche nicht zurücksetzen (SEC-04) – dann diesen Weg nehmen. | INSTALLATION.md §5 (`schulosctl`) |
| Auffällige Häufung von Fehl-Anmeldungen, Alarm-Mail „Anmeldungen“ | Übersicht → Karte „Vorübergehend gesperrte Anmeldungen“ ansehen (nicht vorschnell „Sperre aufheben“); Protokoll prüfen; Alarm-Empfänger und Schwelle: Verwaltung → System → „Sicherheitsalarme“. Optional vorhandene Angriffserkennung (CrowdSec) unter Verwaltung → System prüfen. | INSTALLATION.md §5 (SEC-14, SEC-15); DATENSCHUTZ.md §6 (Brute-Force) |
| Verlorenes oder gestohlenes Gerät mit **Gerätezertifikat** (Personal von außen) | Verwaltung → System → Gerätezertifikate → Zertifikat in der Liste „Sperren“ (mit Grund) – wirkt sofort bei jeder Anfrage. Zusätzlich das Konto der nutzenden Person wie oben behandeln. | INSTALLATION.md §5c |
| Adresse eines **Monitors** (Info-Bildschirm) abgegriffen | Verwaltung → Monitore → Bildschirm „Sperren“ (zeigt danach nichts mehr) oder „Neue Adresse erzeugen“ (die alte wird ungültig). | Verwaltung → Monitore |
| Zu weit vergebene Rechte, falsche Sichtbarkeit, fehlerhafte Zielgruppe | Verwaltung → Rechte & Module: Recht bzw. Gruppenzuordnung zurücknehmen oder **das Modul ausschalten** (Seiten sind dann nicht erreichbar, Aktionen gesperrt). Wer was geändert hat: Verwaltung → Protokoll (Bereich „Rechte“, „Module“, „Gruppen“). | Verwaltung → Rechte & Module; Verwaltung → Protokoll |
| Fehlversand **außerhalb** von SchulOS (E-Mail, Ausdruck, Messenger) | Empfänger bitten, die Nachricht ungelesen zu löschen und das schriftlich zu bestätigen; bei Papier zurückholen. SchulOS bewahrt Exporte (Auskunft, Archivexport, Zugangsdaten-CSV) nicht auf dem Server auf – ein Rückruf auf dem Server ist daher nicht nötig. Waren Startpasswörter betroffen: „Passwort zurücksetzen“ für alle betroffenen Konten. | DATENSCHUTZ.md §3.5 (Exporte) |
| **Umfang und Betroffene** bestimmen | Verwaltung → Protokoll, Filter „Bereich“ (u. a. Klassenbuch, Abwesenheiten, Notenbuch): Schreib- und – für sensible Bereiche – Lesezugriffe mit Konto und Zeit. Auskunft zu einer Person: Verwaltung → Benutzer → Person → „Auskunft (Art. 15) als ZIP herunterladen“. Einträge älter als ein Jahr sind pseudonymisiert; der Löschlauf kann Beweise entfernen. | DATENSCHUTZ.md §4 (DS-04, DS-08), §3 |
| **Beweise sichern** | Verwaltung → Datenschutz → Löschlauf → „Löschsperren“: betroffene Personen oder Gruppen **begründet und befristet** vom Löschlauf ausnehmen. Protokoll-Ansichten festhalten (Datum, Filter, Bildschirmfoto im DSB-Ordner, nicht in SchulOS). Betroffene Geräte nicht zurücksetzen. Zustand des Servers vorher sichern: `sudo schulosctl backup now`. | Verwaltung → Datenschutz → Löschlauf; INSTALLATION.md §5 |
| Verdacht auf Eindringen in den **Server** | Zugänge prüfen: `sudo schulosctl status`; SSH-Netze ansehen mit `sudo schulosctl ssh-netze` (ohne Argument zeigt es die Netze; nur das Schulnetz bzw. das VPN-Netz darf drin stehen); Admin-Ebene nie im Internet. Danach Kapitel 6, wenn Daten verschlüsselt oder gelöscht wurden. | INSTALLATION.md §5, §5b (SEC-12) |
| Daten verloren oder verfälscht | **Wiederherstellung** aus der Sicherung: Auftrag im Backupserver, **Bestätigungscode auf dem Hauptsystem** unter Verwaltung → Backup; je nach Fall einzelne Dateien, ganzes Hauptsystem oder aus der Offsite-Kopie. | INSTALLATION.md §4.4 |
| Sicherung selbst gefährdet (Backupserver übernommen, Datenträger verloren) | **Offsite-Kopie prüfen**: Verwaltung → System zeigt „Unveränderliche Kopie: vorhanden / veraltet / fehlt / nicht eingerichtet“ mit Datum; Alarm-Mails beachten. Verlorener Datenträger mit Sicherung: ohne Schlüssel nicht lesbar – Verlust trotzdem dokumentieren (Verschlüsselung in der Einschätzung vermerken). Ein verlorener **Wiederherstellungsschlüssel** ist neu zu erzeugen (Plattenschlüssel: `sudo schulosctl wiederherstellungsschluessel`). | INSTALLATION.md §4.3a, §2.3 |
| Fehlerhaftes Update | `sudo schulosctl rollback` (Rückweg nach dem Update; Updates laufen mit Sicherung und Probelauf). | INSTALLATION.md §5a |

**Nach jeder Sofortmaßnahme:** Uhrzeit und Person notieren (für die Dokumentation, Kapitel 2.3 Schritt 7). Maßnahmen in der Verwaltung
stehen im Protokoll; Befehle auf dem Server hält die ausführende Person selbst schriftlich fest.

## 5. Was SchulOS für Erkennung und Einschätzung liefert

- **Alarm-Mails** (SEC-14) an die eingetragenen Empfänger: Häufung fehlgeschlagener Anmeldungen, neue Admin-/Verwaltungsrechte,
  Backup überfällig oder fehlgeschlagen, unveränderliche Kopie veraltet, Speicherplatz knapp. Empfänger prüfen: Verwaltung → System.
  Die Mails enthalten keine Personendaten.
- **Protokoll** (Verwaltung → Protokoll): Änderungen der Verwaltung und Lesezugriffe auf Klassenbuch, Fehlzeiten und
  Abwesenheiten; ein Jahr, danach pseudonymisiert. Es zeigt nicht alles (z. B. keine Zugriffe außerhalb von SchulOS).
- **Auskunft** je Person (Verwaltung → Benutzer → Person) hilft bei der Frage, **welche Daten** einer Person betroffen sind.
- **Sicherungsstand** (Verwaltung → Backup, Verwaltung → System): letzter guter Stand und Alter der unveränderlichen Kopie – wichtig für
  die Frage „Wie viel geht verloren?“.

Was SchulOS **nicht** kann: Es führt kein Datenpannen-Register und keine Fristüberwachung (Entscheidung der Projektleitung
2026-10-28; Register frühestens nach dem ersten Pilot). Die Frist notiert die Schule selbst – im Dokumentationsblatt.

## 6. Kurzseite Ransomware (Daten verschlüsselt, Erpresserschreiben)

Ransomware ist der schwerste realistische Fall: Daten sind verschlüsselt oder gelöscht, oft auch Sicherungen im Zugriff des Angreifers.
Diese Seite ausdrucken und beim Notfallordner ablegen.

1. **Ruhe, Uhrzeit notieren (T0).** Schulleitung, DSB und Admin/Betreiber sofort anrufen (Kapitel 3). Ab jetzt läuft die Frist
   (Kapitel 2.3).
2. **Isolieren, nicht ausschalten.** Betroffene Rechner und den Server **vom Netz trennen** (Netzwerkkabel ziehen, WLAN aus,
   Anschluss am Switch sperren). **Nicht neu starten und nicht ausschalten**, solange das nicht sicher ist: Der Arbeitsspeicher kann
   Spuren enthalten, und ein Server mit Plattenverschlüsselung per Passphrase startet ohne eingegebene Passphrase nicht wieder
   (INSTALLATION.md §2.3). Nichts löschen, keine „Aufräum“-Programme, kein Lösegeld ohne Beratung.
3. **Zugänge sperren.** Alle Admin-, Verwaltungs- und Wartungszugänge sowie die Zugangsdaten des Backups und der Offsite-Kopie als
   **kompromittiert** behandeln. Von einem **sauberen Gerät** aus: Konten mit Verwaltungsrechten sperren und neu setzen (Kapitel 4);
   Zugang zum Anbieterkonto der Offsite-Kopie (eigenes Passwort, eigener zweiter Faktor) ändern.
4. **Sicherungen prüfen, bevor etwas überschrieben wird.** Ist die **unveränderliche Offsite-Kopie** da und enthält sie einen
   Stand von **vor** dem Angriff? (Verwaltung → System bzw. Anzeige des Backupservers „Unveränderliche Kopie“; Anbieterkonsole,
   INSTALLATION.md §4.3a.) Die Haltedauer der Schnappschüsse entscheidet, wie weit man zurückgehen kann. Backups nie vom
   verdächtigen Rechner aus löschen oder aufräumen lassen.
5. **Ursache klären, bevor wiederhergestellt wird.** Wie kam der Angreifer herein (gekapertes Konto, offener Zugang, ungepatchte Lücke;
   SICHERHEIT.md „Bedrohungsbild Ransomware“)? Wird nur zurückgespielt, ohne die Lücke zu schließen, folgt die nächste Verschlüsselung.
6. **Wiederherstellen** nach INSTALLATION.md §4.4: auf **neuer oder frisch installierter Hardware** (ISO), Rolle Hauptsystem →
   „aus Backup wiederherstellen“ bzw. „aus Offsite-Kopie wiederherstellen“ (mit Wiederherstellungsschlüssel); der Bestätigungscode
   wird auf dem Hauptsystem eingegeben. Den alten, befallenen Server nicht weiterverwenden, bevor er untersucht und neu aufgesetzt ist.
   Ein neues Hauptsystem koppelt über den **Ersatz-Kopplungscode** an dieselbe Sicherung (INSTALLATION.md §4.4, „Neue Hardware“).
   Danach alle Passwörter der Verwaltungskonten ändern, den Wartungs-Zugang und die SMTP-/Offsite-Zugangsdaten erneuern.
7. **Betroffenheit einschätzen.** Wurden Daten nur verschlüsselt (Verfügbarkeit), oder liegt Abfluss vor (Erpresser drohen mit
   Veröffentlichung)? Datenträger sind per Plattenverschlüsselung geschützt, solange der Server **aus** war; ein laufender, übernommener
   Server ist es nicht. Im Zweifel von Offenlegung ausgehen.
8. **Melden.** Aufsichtsbehörde binnen 72 h (Kapitel 2.3, Schritt 5), bei hohem Risiko Betroffene (Schritt 6). Strafanzeige,
   Schulträger, Schulaufsicht und Versicherung: zu prüfen (Kapitel 2.3, „Weitere Wege“). Kommunikation mit Erpressern nur nach
   Absprache mit Schulleitung und Polizei.
9. **Dokumentieren und lernen.** Dokumentationsblatt führen, danach Zugänge, Updates, zweiten Faktor und Wiederherstellungsübung
   prüfen (monatlicher Test-Restore, INSTALLATION.md §4).
