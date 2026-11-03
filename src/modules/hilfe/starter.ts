// Starter-Seiten des Handbuchs (HB-07, docs/HANDBUCH.md): wenige neutrale Vorlagen, die die Schule übernimmt und anpasst. Sie werden
// über `createPage` angelegt (keine Sonderrechte, keine automatische Aktualisierung danach) und sind vorbelegt für die Gruppen,
// für die sie gedacht sind – Eltern und Schüler:innen sehen ihre Seiten, eigene Seiten bleiben dagegen zunächst „nur Personal“.
// Die Texte beschreiben die Wege in SchulOS (Menüpunkte und Schaltflächen wie in der Oberfläche); schulspezifische Angaben
// (Öffnungszeiten, Ansprechpersonen) stehen bewusst nicht drin.
import { inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { hilfePages, hilfeSections } from "@/core/db/schema";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import type { Role } from "@/core/roles";
import { toBerlinDate } from "@/core/time";
import { canEditAll, createPage, createSection, EDIT, slugify, STAFF_TARGET_ROLES } from "./service";

export const STARTER_SECTION = "Erste Schritte";
/** INV-07: Bereich für die Seite zu Gebäude & Technik/Inventar */
export const GEBAEUDE_SECTION = "Gebäude & Technik";
export const GEBAEUDE_HELP_SLUG = "gebaeude-und-technik-inventar";
/** GS-03: Seite zu den Fachraum-Prüfungen (Bereich Gebäude & Technik) */
export const FACHRAUM_HELP_SLUG = "fachraum-pruefungen";
/** CA-04: Starter-Seite zum Schul-Zertifikat (Verwaltung → System verlinkt sie, wenn es sie gibt) */
export const ROOT_CA_HELP_SLUG = "schul-zertifikat-installieren";

export interface StarterPage {
  /** muss `slugify(title)` entsprechen (Test) – Ziel der Kontexthilfe in context.ts */
  slug: string;
  title: string;
  /** leer = alle */
  roles: Role[];
  body: string;
  /** Bereich im Handbuch (Vorgabe „Erste Schritte“) */
  section?: string;
}

export const STARTER_PAGES: readonly StarterPage[] = [
  {
    slug: "erste-schritte-fuer-eltern",
    title: "Erste Schritte für Eltern",
    roles: ["eltern"],
    body: `Willkommen bei SchulOS. Hier finden Sie auf einen Blick, was Sie als Elternteil tun können.

## Anmelden

1. Melden Sie sich mit Ihrem Benutzernamen und dem Passwort an, das Sie von der Schule bekommen haben.
2. Ändern Sie das Passwort beim ersten Mal: oben rechts auf Ihren Namen tippen, dann **Passwort ändern**.
3. Hinterlegen Sie Ihre E-Mail-Adresse (Menü oben rechts, **E-Mail-Adresse**) – so erreichen Sie Benachrichtigungen und Sie können ein vergessenes Passwort selbst zurücksetzen.

Mehr dazu: [Zwei-Faktor-Anmeldung einrichten](/hilfe/zwei-faktor-anmeldung-einrichten) und [Passwort vergessen](/hilfe/passwort-vergessen).

## Was Sie hier erledigen

- **Abwesenheiten:** Ihr Kind krank melden oder eine Beurlaubung beantragen – siehe [Krankmeldung](/hilfe/krankmeldung).
- **News** und **Elternbriefe:** Neuigkeiten und Briefe der Schule lesen.
- **Elternsprechtag:** Gesprächstermine buchen, sobald die Schule das Buchen freigibt.
- **Kurswahl:** Wahlen für Ihr Kind abgeben oder bestätigen – siehe [Kurswahl](/hilfe/kurswahl).
- **Stundenplan** und **Kalender:** Unterrichtszeiten, Vertretungen, Ferien und Termine.

## Hilfe finden

Über das **?** in der Kopfzeile kommen Sie jederzeit zurück in dieses Handbuch. Wenn etwas nicht klappt, hilft das Sekretariat.`,
  },
  {
    slug: "erste-schritte-fuer-schuelerinnen-und-schueler",
    title: "Erste Schritte für Schülerinnen und Schüler",
    roles: ["schueler"],
    body: `Willkommen bei SchulOS. Das kannst du hier tun.

## Anmelden

1. Melde dich mit deinem Benutzernamen und dem Passwort an, das du von der Schule bekommen hast.
2. Ändere das Passwort beim ersten Mal: oben rechts auf deinen Namen tippen, dann **Passwort ändern**. Wähle ein Passwort, das nur du kennst.

## Was du hier findest

- **Stundenplan:** deine Stunden und Änderungen, zum Beispiel Vertretungen.
- **Aufgaben:** Aufgaben deiner Lehrkräfte ansehen und Abgaben hochladen.
- **Dateien:** Material deiner Klasse und deiner Kurse.
- **News** und **Kalender:** Neuigkeiten, Ferien und Termine.
- **Kurswahl:** wenn ein Wahlverfahren läuft, wählst du hier – siehe [Kurswahl](/hilfe/kurswahl).
- **Messenger:** Nachrichten an Klasse, Kurse und Lehrkräfte.

## Wenn du krank bist

Deine Eltern melden dich krank (siehe [Krankmeldung](/hilfe/krankmeldung)). Wenn du volljährig bist und die Schule dich als eigenständig eingetragen hat, meldest du dich selbst unter **Abwesenheiten**.

## Hilfe finden

Über das **?** in der Kopfzeile kommst du jederzeit in dieses Handbuch. Wenn du nicht weiterkommst, frag deine Klassenleitung oder das Sekretariat.`,
  },
  {
    slug: "erste-schritte-fuer-lehrkraefte-und-personal",
    title: "Erste Schritte für Lehrkräfte und Personal",
    roles: STAFF_TARGET_ROLES,
    body: `Willkommen bei SchulOS. Diese Seite hilft beim Einstieg.

## Anmelden und absichern

1. Melden Sie sich mit Ihrem Benutzernamen und dem Passwort an, das Sie bekommen haben, und ändern Sie es beim ersten Mal (oben rechts auf Ihren Namen, dann **Passwort ändern**).
2. Richten Sie die Zwei-Faktor-Anmeldung ein – siehe [Zwei-Faktor-Anmeldung einrichten](/hilfe/zwei-faktor-anmeldung-einrichten).
3. Hinterlegen Sie Ihre E-Mail-Adresse (**E-Mail-Adresse** im Menü oben rechts), damit Sie ein vergessenes Passwort selbst zurücksetzen können: [Passwort vergessen](/hilfe/passwort-vergessen).

## Täglich gebraucht

- **Stundenplan** und **Kalender:** Ihr Plan, Vertretungen, Termine.
- **Klassenbuch:** Anwesenheit und Einträge für Ihren Unterricht.
- **Abwesenheiten:** Meldungen Ihrer Klasse sehen und entscheiden.
- **Messenger**, **News**, **Elternbriefe:** Kommunikation mit Kolleginnen, Kollegen und Eltern.
- **Dateien** und **Aufgaben:** Material verteilen, Abgaben einsammeln.
- **Gebäude & Technik:** Mängel melden. Geräte und Möbel tragen ein Etikett mit QR-Code – mit der Kamera des Handys scannen, anmelden, dann sehen Sie Bezeichnung, Kategorie und Standort und können direkt „Mangel melden“. Wer das Inventar pflegt (Hausmeisterei, IT oder die verantwortliche Gruppe einer Kategorie), findet unter Gebäude & Technik → Inventar die Liste, das Anlegen und den Etikettendruck.

Die Startseite zeigt außerdem Ihre offenen Punkte, zum Beispiel Anträge, die auf eine Entscheidung warten.

## Dieses Handbuch pflegen

Wer das Recht „Handbuch bearbeiten“ hat, legt unter **Handbuch** Bereiche und Seiten an. Ist eine Person als Ansprechperson einer Seite eingetragen, darf sie diese Seite bearbeiten und bekommt eine Erinnerung, wenn die Überprüfung fällig ist.

Tragen Sie in Seiten bitte keine Schülerdaten und keine Gesundheits- oder Notendaten ein.`,
  },
  {
    slug: "zwei-faktor-anmeldung-einrichten",
    title: "Zwei-Faktor-Anmeldung einrichten",
    roles: [],
    body: `Mit der Zwei-Faktor-Anmeldung braucht eine Anmeldung zusätzlich zum Passwort einen Code aus einer Authentifizierungs-App oder einen Sicherheitsschlüssel. Ein gestohlenes Passwort allein reicht dann nicht mehr.

## Einrichten

1. Oben rechts auf Ihren Namen tippen und **Zwei-Faktor-Anmeldung und Sicherheitsschlüssel** wählen.
2. Die Einrichtung mit Ihrem Passwort starten und den angezeigten QR-Code mit einer Authenticator-App auf dem Smartphone scannen.
3. Den ersten Code aus der App eingeben und bestätigen.
4. Die angezeigten **Wiederherstellungscodes** ausdrucken oder sicher aufbewahren. Mit ihnen kommen Sie hinein, wenn das Smartphone verloren ist.

Ab der nächsten Anmeldung fragt SchulOS nach dem Code.

## Sicherheitsschlüssel

Auf derselben Seite können Sie zusätzlich einen Sicherheitsschlüssel hinterlegen. Das ist bequem und besonders sicher.

## Handy verloren?

Melden Sie sich mit einem Wiederherstellungscode an. Haben Sie keinen mehr, setzt das Sekretariat die Zwei-Faktor-Anmeldung zurück – danach richten Sie sie neu ein.

Wenn Sie nur das Passwort vergessen haben: [Passwort vergessen](/hilfe/passwort-vergessen).`,
  },
  {
    slug: "passwort-vergessen",
    title: "Passwort vergessen",
    roles: [],
    body: `## Passwort selbst zurücksetzen

Das geht für Lehrkräfte, Personal und Eltern, wenn die Zwei-Faktor-Anmeldung eingerichtet und eine E-Mail-Adresse bestätigt ist:

1. Auf der Anmeldeseite **Passwort vergessen?** wählen.
2. Benutzernamen oder E-Mail-Adresse eingeben und absenden.
3. In der E-Mail den Link öffnen – er gilt eine Stunde – und ein neues Passwort vergeben.

Aus Sicherheitsgründen antwortet SchulOS immer gleich, egal ob es zu der Angabe ein Konto gibt.

## Es klappt nicht?

Ohne Zwei-Faktor-Anmeldung, ohne bestätigte E-Mail-Adresse und für Schülerinnen und Schüler setzt das Sekretariat das Passwort zurück. Bitte dort melden und sich ausweisen.

## Passwort ändern, wenn Sie es kennen

Oben rechts auf Ihren Namen tippen, dann **Passwort ändern**.

Siehe auch: [Zwei-Faktor-Anmeldung einrichten](/hilfe/zwei-faktor-anmeldung-einrichten).`,
  },
  {
    slug: "krankmeldung",
    title: "Krankmeldung",
    roles: ["eltern", "schueler"],
    body: `## Kind krank melden (Eltern)

1. Im Menü **Abwesenheiten** öffnen.
2. Bei mehreren Kindern das Kind wählen.
3. Ersten und letzten Tag eintragen und als Grund **krank** wählen. Weitere Angaben zur Krankheit sind nicht nötig und gehören nicht in die Meldung.
4. **Abwesenheit melden** drücken. Die Klassenleitung bekommt eine Benachrichtigung.

Unter **Meine Meldungen** sehen Sie, ob die Klassenleitung die Meldung entschuldigt hat.

Wichtig: Die Meldung in SchulOS ist eine Benachrichtigung. Ob zusätzlich eine schriftliche Entschuldigung nötig ist, steht direkt am Formular.

## Beurlaubung

Für einen Tag, an dem Ihr Kind aus einem wichtigen Grund nicht kommen kann, beantragen Sie vorher unter **Abwesenheiten** eine **Beurlaubung**.

## Volljährige Schülerinnen und Schüler

Wer von der Schule als eigenständig geführt wird, meldet sich unter **Abwesenheiten** selbst ab. Alle anderen Schülerinnen und Schüler sehen dort ihre **Fehlzeiten**.

## Telefonisch

Rufen Sie im Sekretariat an, wenn die Anmeldung gerade nicht möglich ist. Das Sekretariat nimmt die Krankmeldung für Sie auf.`,
  },
  {
    slug: "kurswahl",
    title: "Kurswahl",
    roles: ["eltern", "schueler"],
    body: `Wenn die Schule ein Wahlverfahren eröffnet, finden Sie es im Menü unter **Kurswahl**. Ohne laufendes Verfahren steht dort „Zurzeit keine Kurswahl“.

## So wählen Sie

1. **Kurswahl** öffnen und das Verfahren wählen. Je nach Verfahren wählen die Schülerinnen und Schüler selbst oder die Eltern für ihr Kind.
2. Die Wünsche in der gewünschten Reihenfolge angeben – bei mehreren Wahlen steht dort „Kurs 1“, „Kurs 2“ und so weiter.
3. **Wahl abgeben** drücken.
4. Verlangt die Schule eine Bestätigung der Eltern, zeigt die Seite „Bestätigung der Eltern fehlt“. Dann bitte **Wahl bestätigen**.

Bis zum Ende der Frist können Sie die Wahl mit **Wahl ändern** anpassen. Bei jedem Angebot unter **Beschreibung der Angebote** steht, worum es geht.

## Nach dem Ende der Wahl

Die Schule teilt zu. Das Ergebnis erscheint auf derselben Seite unter „Zugeteilt“. Der **Wahlbogen** lässt sich dort drucken.

Fragen beantwortet das Sekretariat.`,
  },
  {
    // CA-04 (docs/ZERTIFIKATE.md, Verteilwege): eigene CA der Schule auf Geräten vertrauen
    slug: ROOT_CA_HELP_SLUG,
    title: "Schul-Zertifikat installieren",
    roles: [],
    body: `SchulOS läuft im Schulnetz mit einem Zertifikat der schuleigenen Zertifizierungsstelle. Damit Browser und Apps die Verbindung ohne Warnung als sicher erkennen, muss jedes Gerät dem **Wurzelzertifikat** („Schul-Zertifikat“) der Schule vertrauen. Es enthält keine Personendaten und nichts Geheimes.

## Zertifikat holen und prüfen

- **Im Schulnetz ohne Anmeldung:** die Adresse von SchulOS mit \`/ca.crt\` am Ende aufrufen (z. B. \`https://schulos.example/ca.crt\`).
- **Öffnet sich die Adresse wegen des Zertifikats gar nicht:** im Schulnetz \`http://\` und die IP-Adresse des Servers aufrufen (ohne „s“). Dort erscheint eine Hinweisseite mit dem Link zum Schul-Zertifikat.
- **Für die IT:** **Verwaltung → System → Schul-Zertifikat** – dort als \`.crt\`, \`.cer\` (Windows) und \`.mobileconfig\` (iPad/Mac).
- **Vor dem Import den Fingerabdruck (SHA-256) vergleichen:** Er steht in Verwaltung → System, auf dem Bildschirm des Servers und in \`schulosctl status\`. Stimmt er nicht überein, das Zertifikat nicht installieren und die IT informieren.

## Verteilwege

| Geräte | Weg |
|---|---|
| Windows-PCs der Schule (Domäne) | Gruppenrichtlinie: Richtlinien für öffentliche Schlüssel → Vertrauenswürdige Stammzertifizierungsstellen |
| Windows ohne Domäne | Konfigurationsprofil der Geräteverwaltung („Vertrauenswürdiges Zertifikat“) |
| Windows einzeln | \`certutil -addstore -f Root schul-zertifikat.crt\` in einer Eingabeaufforderung als Administrator |
| iPads/Macs | Profil \`.mobileconfig\` über die Geräteverwaltung; von Hand: Profil öffnen, installieren, dann unter Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen das volle Vertrauen einschalten |
| Android/Chromebooks | Geräteverwaltung bzw. Admin-Konsole des Geräteanbieters; von Hand: Einstellungen → Sicherheit → Zertifikat installieren (CA-Zertifikat) |
| Firefox | übernimmt die Zertifikate des Systems mit \`security.enterprise_roots.enabled\` bzw. der Richtlinie \`Certificates.ImportEnterpriseRoots\` |
| Private Geräte (Eltern, eigene Geräte) | praktisch nicht verwaltbar – die Warnung bleibt, bis die Schule ein öffentliches Zertifikat nutzt |

## Neues Schul-Zertifikat

Nach einer **Neuinstallation** des Servers gibt es ein neues Schul-Zertifikat: Es muss neu verteilt und das alte von den Geräten entfernt werden, sonst sperren Browser die Seite ganz. Nach einer **Wiederherstellung aus dem Backup** bleibt es gleich. Wechselt es, bekommt die IT eine Alarm-Mail, bis sie den neuen Fingerabdruck in Verwaltung → System bestätigt.`,
  },
  {
    // INV-07 (docs/INVENTAR.md): Mängel, Inventar, Etiketten, Geräteseite, Inventur, Ausleihe, Schulträger-Liste – für das Personal
    slug: GEBAEUDE_HELP_SLUG,
    title: "Gebäude und Technik: Inventar",
    roles: STAFF_TARGET_ROLES,
    section: GEBAEUDE_SECTION,
    body: `Unter **Gebäude & Technik** melden alle Beschäftigten Mängel; Hausmeisterei, IT und die verantwortlichen Gruppen einzelner Kategorien pflegen dort außerdem das **Inventar** – Geräte, Möbel und Sammlungen mit QR-Etiketten.

## Mangel melden

**Gebäude & Technik → Mangel melden**: Raum, Art und eine kurze Beschreibung. Hängt am Gerät ein Etikett, geht es schneller: QR-Code mit der Kamera des Handys scannen, anmelden, auf der Geräteseite **Mangel melden** tippen – Raum, Kategorie und Gerät sind schon eingetragen. Bitte keine Namen oder Gesundheitsangaben in die Beschreibung schreiben.

## Inventar pflegen

- **Gebäude & Technik → Inventar** zeigt die Liste mit Filtern (Kategorie, Gebäude, Raum, Zustand, Frist, Suche). Ausgemustertes ist ausgeblendet („auch ausgemusterte“).
- **Anlegen:** Bezeichnung, Kategorie und Standort genügen; die Inventarnummer vergibt SchulOS aus dem Präfix der Kategorie (z. B. IT-0007). Tische und Stühle eines Raums sind ein **Sammelposten** mit Menge.
- Preis, Lieferant, Finanzierung, Zweckbindung und Garantie sind optional. Endet eine Garantie oder Zweckbindung bald, erscheint unter **Offen für dich** auf der Startseite ein Hinweis (Vorlauf in den Moduleinstellungen).
- **Ausmustern** statt löschen: der Eintrag bleibt als Nachweis für den Schulträger.

## Etiketten drucken

Auf der Geräteseite **Etikett drucken** oder für viele Geräte **Etiketten drucken** in der Liste (Auswahl nach Kategorie, Raum oder „nur ohne Etikett“). Formate: A4-Bogen 3 × 8, A4-Bogen 4 × 13 und Endlosrolle 62 mm. Bei einem angefangenen Bogen **ab Etikett Nr.** wählen. Im Druckdialog des Browsers „Tatsächliche Größe“ (100 %) und keine Ränder einstellen. Ein neu erzeugter Code macht das alte Etikett ungültig.

## Geräteseite (Scan mit dem Handy)

Die Kamera-App öffnet den Link des Etiketts. Ohne Anmeldung erscheint nur die Anmeldeseite, danach die Geräteseite:

- **Alle Angemeldeten** sehen Bezeichnung, Kategorie, Standort und können einen Mangel melden.
- **Wer das Inventar pflegt** oder alles lesen darf, sieht zusätzlich Seriennummer, Preis, Fotos, Prüfungen und die Historie und setzt vor Ort Zustand und Raum per Knopf.

## Inventur

**Inventar → Inventur**: Raum wählen und starten. Etiketten mit der Kamera-App scannen und auf der Geräteseite **Gefunden in …** tippen, oder auf der Inventurseite die Inventarnummer eintippen (auch per Handscanner). Geräte aus einem anderen Raum lassen sich **hierher umziehen**. Beim Abschluss wird alles Offene „fehlt“; das Protokoll gibt es als CSV und Druckansicht.

## Ausleihe

Auf der Geräteseite (Karte **Ausleihe**) eine Person suchen, Rückgabedatum und Zubehör eintragen, **Verleihen**, den Leihvertrag drucken und unterschreiben lassen. **Inventar → Leihgeräte** zeigt alle offenen Ausleihen, überfällige zuerst; Erinnerungen verschickt SchulOS selbst. Entleihende finden ihre Geräte unter **Meine Leihgeräte**.

## Liste für den Schulträger (CSV)

- **Als CSV exportieren** in der Inventarliste liefert die gefilterte Liste im Schulträgerformat (Semikolon, Datum TT.MM.JJJJ, Preis in Euro).
- **Importieren:** Datei wählen, **Prüfen (Vorschau)** – noch wird nichts gespeichert. Andere Spaltennamen unter **Spaltenzuordnung** zuordnen und neu prüfen. Gleiche Inventarnummer aktualisiert den Eintrag, leere Zellen lassen den bisherigen Wert stehen. Erst wenn die Vorschau ohne Fehler ist, **übernehmen** – ganz oder gar nicht.

## Wer darf was?

| Wer | Inventar |
|---|---|
| Alle Beschäftigten | Mangel melden; Geräteseite mit Bezeichnung, Kategorie, Standort |
| Recht „alles lesen“ | Liste, Geräteseiten vollständig, Export |
| Verantwortliche Gruppe einer Kategorie | diese Kategorie pflegen, Etiketten, Ausleihe, Import/Export |
| Recht „Inventar pflegen“ (z. B. Hausmeisterei) | alle Kategorien, Inventur |
| Recht „einrichten“ (Verwaltung) | zusätzlich Kategorien, Prüfarten, endgültig löschen |

Welche Gruppe welche Rechte hat, legt die Verwaltung unter **Verwaltung → Rechte & Module** fest.`,
  },
  {
    // GS-03 (docs/FACHRAUM-PRUEFUNGEN.md): Fachraum-Prüfungen Chemie/NW und Strahlenschutz Physik, zuständige Gruppe je Prüfart
    slug: FACHRAUM_HELP_SLUG,
    title: "Fachraum-Prüfungen",
    roles: STAFF_TARGET_ROLES,
    section: GEBAEUDE_SECTION,
    body: `Unter **Gebäude & Technik → Prüfungen** führt SchulOS auch die wiederkehrenden Prüfungen in Chemie- und naturwissenschaftlichen Fachräumen und den Strahlenschutz in der Physik. Erinnerungen bekommt die Gruppe, die dafür zuständig ist – zum Beispiel die Fachschaft Chemie.

> **Zu prüfen – keine Rechtsberatung.** Prüfarten, Intervalle und Quellen sind eine Vorlage. Welche Prüfungen in welchem Abstand nötig sind, legt die Schule mit dem Schulträger und der Fachkraft für Arbeitssicherheit fest. SchulOS behauptet keine Rechtsverbindlichkeit.

## Welche Prüfarten gibt es?

| Prüfart | Vorlage | Quelle (zum Nachlesen) |
|---|---|---|
| Laborabzüge | jährlich, Fachfirma | DIN EN 14175, DGUV Regel 113-018, RISU-NRW |
| Augen- und Körpernotduschen | monatliche Funktionsprobe | DIN EN 15154, DGUV Regel 113-018, RISU-NRW |
| Sicherheitsschränke für Gefahrstoffe | jährlich, Fachfirma | DIN EN 14470-1, TRGS 510 |
| Gasversorgung und Not-Aus im Fachraum | jährlich je Raum | DGUV Regel 113-018, RISU-NRW |
| Gefahrstoffverzeichnis aktualisieren und Bestand aussondern | jährlich | GefStoffV § 6, RISU-NRW |
| Gefährdungsbeurteilungen Fachraum überprüfen | jährlich je Raum | GefStoffV § 6, ArbSchG § 5 |
| Strahlenschutz: Dichtheitsprüfung radioaktiver Präparate | jährlich, nur wenn vorhanden | StrlSchV, RISU-NRW |

Biologie (Biostoffe) folgt später. Ein **Chemikalienkataster** führt SchulOS nicht: Für das Gefahrstoffverzeichnis gibt es nur die Frist – das aktuelle Verzeichnis hängt als PDF an der erfassten Prüfung.

## Einrichten (Verwaltung)

1. **Gebäude & Technik → Prüfarten**, Liste **Fachraum-Prüfungen**: Prüfart aufklappen, Intervall und Quelle mit der Fachkraft für Arbeitssicherheit abgleichen.
2. **zuständige Gruppe** wählen (z. B. Fachschaft Chemie) und **eingeschaltet** setzen, speichern.
3. Abzüge, Notduschen und Sicherheitsschränke als Inventar anlegen (Kategorien Laborabzug, Augen-/Körpernotdusche, Sicherheitsschrank für Gefahrstoffe) – ihre Prüfungen plant SchulOS dann selbst.

## Für die zuständige Gruppe

- **Gebäude & Technik → Prüfungen meiner Zuständigkeit** zeigt nur die Prüfarten Ihrer Gruppe: überfällig, bald fällig, geplant, erledigt.
- **Prüfung planen**: Prüfart, Termin und je nach Art Raum oder Gebäude (z. B. Gefahrstoffverzeichnis für das Hauptgebäude).
- **Ergebnis erfassen**: Datum, Ergebnis, Firma bzw. Stelle (kein Personenname), Protokoll oder Verzeichnis als PDF. Bei einem Mangel entsteht automatisch eine Meldung an die Hausmeisterei; danach plant SchulOS die nächste Prüfung.
- Erinnerungen kommen als Benachrichtigung: bald fällige einmal je Woche, überfällige täglich. Ist niemand (mehr) in der Gruppe, gehen sie an die Hausmeisterei.

Die Hausmeisterei und die Schulleitung sehen weiterhin alle Prüfungen; Prüfliste und CSV für den Schulträger gibt es dort.`,
  },
];

const STARTER_SLUGS = STARTER_PAGES.map((p) => p.slug);

export interface StarterStatus {
  /** Starter-Seiten, die es noch nicht gibt */
  missing: StarterPage[];
  total: number;
}

export async function starterStatus(db: Db): Promise<StarterStatus> {
  const rows = await db.select({ slug: hilfePages.slug }).from(hilfePages).where(inArray(hilfePages.slug, STARTER_SLUGS));
  const have = new Set(rows.map((r) => r.slug));
  return { missing: STARTER_PAGES.filter((p) => !have.has(p.slug)), total: STARTER_PAGES.length };
}

/**
 * Legt die fehlenden Starter-Seiten an (Pflegende): Bereich „Erste Schritte“ (falls es ihn nicht gibt), dann je Vorlage eine
 * veröffentlichte Seite über `createPage`, sichtbar für die Zielgruppen der Vorlage. Idempotent: vorhandene Seiten – auch
 * umbenannte oder angepasste, die Adresse bleibt – werden nie überschrieben oder doppelt angelegt. Gibt die neu angelegten Titel zurück.
 */
export async function installStarterPages(db: Db, actor: PermissionSet, today = toBerlinDate(new Date())): Promise<string[]> {
  if (!canEditAll(actor)) throw new ForbiddenError(EDIT);
  const { missing } = await starterStatus(db);
  if (missing.length === 0) return [];
  const sections = new Map((await db.select({ id: hilfeSections.id, title: hilfeSections.title }).from(hilfeSections)).map((s) => [s.title, s.id]));
  const created: string[] = [];
  for (const p of missing) {
    const title = p.section ?? STARTER_SECTION;
    const sectionId = sections.get(title) ?? (await createSection(db, actor, title));
    sections.set(title, sectionId);
    // Die Adresse folgt dem Titel (slugify); eine fremde Seite mit gleicher Adresse gibt es hier nicht, sonst wäre sie „vorhanden“
    const slug = await createPage(
      db,
      actor,
      { sectionId, title: p.title, body: p.body, status: "veroeffentlicht", contactId: null, targetRoles: p.roles, targetGroupIds: [] },
      today,
    );
    if (slug === p.slug) created.push(p.title);
  }
  return created;
}

/** Test-Hilfe: Adresse einer Vorlage aus ihrem Titel. */
export const starterSlug = (title: string) => slugify(title);
