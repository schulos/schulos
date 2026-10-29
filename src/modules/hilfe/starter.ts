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

export interface StarterPage {
  /** muss `slugify(title)` entsprechen (Test) – Ziel der Kontexthilfe in context.ts */
  slug: string;
  title: string;
  /** leer = alle */
  roles: Role[];
  body: string;
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
  const sections = await db.select({ id: hilfeSections.id, title: hilfeSections.title }).from(hilfeSections);
  const sectionId = sections.find((s) => s.title === STARTER_SECTION)?.id ?? (await createSection(db, actor, STARTER_SECTION));
  const created: string[] = [];
  for (const p of missing) {
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
