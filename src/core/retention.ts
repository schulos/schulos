// Löschkonzept-Baustein (docs/DATENSCHUTZ.md §3): zentrale Löschklassen und die
// Zuordnung jeder Tabelle mit Personenbezug. Module deklarieren ihre Tabellen im Manifest
// (`retention`), Core-Tabellen stehen hier. Ein Test stellt sicher, dass keine Tabelle fehlt.

export const RETENTION_CLASSES = {
  "LK-SESSION": { label: "Bei Ablauf", start: "Ablauf der Sitzung", rule: "sofort", max: "–" },
  "LK-90": { label: "90 Tage", start: "Erstellung", rule: "90 Tage", max: "1 Jahr" },
  "LK-KONTO": {
    label: "Mit dem Konto",
    start: "Kontoende (Abgang, Ausscheiden; Eltern: Kontoende des letzten Kindes)",
    rule: "Sperre sofort, Löschung nach 90 Tagen",
    max: "1 Jahr",
  },
  "LK-1J": { label: "1 Jahr", start: "Erstellung", rule: "1 Jahr", max: "2 Jahre" },
  "LK-ENDE-1J": { label: "1 Jahr nach Ende", start: "Ende des Objekts (Ablauf, Archivierung)", rule: "1 Jahr", max: "2 Jahre" },
  "LK-TERMIN": { label: "2 Jahre nach Termin", start: "Terminende", rule: "2 Jahre", max: "3 Jahre" },
  "LK-SJ": { label: "Schuljahresende", start: "Ende des Schuljahres der Entstehung", rule: "zum Schuljahresende", max: "1 Jahr" },
  "LK-SJ-1J": {
    label: "Schuljahresende + 1 Jahr",
    start: "Ende des Schuljahres der Entstehung",
    rule: "Schuljahresende + 1 Jahr",
    max: "Schuljahresende + 2 Jahre",
  },
  "LK-AKTE": {
    label: "Akte (Archivexport)",
    start: "Abschluss des Schuljahres",
    rule: "Archivexport, danach wie LK-SJ-1J",
    max: "– (10 Jahre im Archiv, § 9 VO-DV I)",
  },
} as const satisfies Record<string, { label: string; start: string; rule: string; max: string }>;

export type RetentionClassId = keyof typeof RETENTION_CLASSES;

/**
 * DS-15: Klassen mit einer Frist in Tagen, die eine Schule je Datenart als Moduleinstellung (`period`) ändern darf –
 * `rule` = Regelfrist (Vorgabe), `max` = Grenze „einstellbar bis“ (DATENSCHUTZ.md §3.3). Bei LK-KONTO ist es die Karenz
 * zwischen Abgang und Löschung. Schuljahres- und Aktenfristen bleiben fest (Rechtsfristen, § 9 VO-DV I).
 */
export const CLASS_DAYS: Partial<Record<RetentionClassId, { rule: number; max: number }>> = {
  "LK-90": { rule: 90, max: 365 },
  "LK-KONTO": { rule: 90, max: 365 },
  "LK-1J": { rule: 365, max: 730 },
  "LK-ENDE-1J": { rule: 365, max: 730 },
  "LK-TERMIN": { rule: 730, max: 1095 },
};

/** Untergrenze jeder einstellbaren Frist (DS-15): kürzer wird es für Rückfragen und Eigenexport zu knapp. */
export const PERIOD_MIN_DAYS = 30;

/** Tage in Worten: 365 → „1 Jahr“, 730 → „2 Jahre“, sonst „n Tage“. */
export function daysText(days: number): string {
  if (days % 365 === 0) return days === 365 ? "1 Jahr" : `${days / 365} Jahre`;
  return `${days} Tage`;
}

/** Regelfrist in Worten – mit einer von der Schule eingestellten Frist (`days`) statt der Klassenvorgabe. */
export function ruleText(classId: RetentionClassId, days?: number | null): string {
  const base = RETENTION_CLASSES[classId].rule;
  const d = CLASS_DAYS[classId];
  if (!d || !days || days === d.rule) return base;
  if (classId !== "LK-KONTO") return daysText(days);
  const after = days % 365 === 0 ? (days === 365 ? "einem Jahr" : `${days / 365} Jahren`) : `${days} Tagen`;
  return `Sperre sofort, Löschung nach ${after}`;
}

interface RetentionBase {
  /** Name der DB-Tabelle */
  table: string;
  /** Teilmenge der Tabelle, wenn sie mehrere Regeln hat (z. B. persönliche Dateien vs. Gruppenordner) */
  scope?: string;
  /** Zweck der Verarbeitung (für VVT und Datenschutzhinweise) */
  purpose: string;
  /** Datenkategorien, z. B. ["Nachrichteninhalt", "Absender", "Zeitpunkt"] */
  categories: string[];
  /** Ergänzung für Menschen, erscheint in der Übersicht */
  note?: string;
  /**
   * SQL-Bedingung für die Teilmenge (`scope`), die der Löschlauf anwendet, z. B. `kind = 'direct'`.
   * Teilmengen ohne Bedingung lässt der Löschlauf aus (sonst träfe er auch die anderen Teilmengen).
   */
  where?: string;
  /**
   * Nur diese Spalten tragen Personenbezug: der Löschlauf leert sie (`null`) statt die Zeile zu löschen – der Rest bleibt
   * als Nachweis (G4-01: Prüfprotokoll und Bemerkung, die Prüfung selbst bleibt). Dateischlüssel darunter räumt danach
   * der Dateispeicher-Lauf ab.
   */
  clear?: string[];
  /**
   * Q5-26: Die Bedingung hängt von einer Moduleinstellung ab (voller Schlüssel, z. B. `gebaeude.report_keep`). Der Löschlauf
   * setzt deren aktuellen Wert für `{setting}` in `where` ein – nur rein numerische Werte (die Optionen stehen im Manifest).
   */
  setting?: string;
  /**
   * G4D-S01: Grund, warum `where` Zeilen mit abgelaufener Frist zurückhält (z. B. „warten auf die Übergabe des Archivexports“).
   * Die Löschvorschau zählt diese Zeilen dann als eigenen Eintrag „zurückgehalten“ – sichtbar statt still unbegrenzt. Nur mit `where`.
   */
  held?: string;
  /**
   * DS-15: Frist in Tagen aus einer Moduleinstellung (voller Schlüssel, z. B. `messenger.keep_days`) statt der Regelfrist der
   * Klasse. Nur für Klassen in `CLASS_DAYS`; die Optionen der Einstellung liegen zwischen `PERIOD_MIN_DAYS` und der Grenze
   * „einstellbar bis“, die Vorgabe ist die Regelfrist (Test `retention.test.ts`).
   */
  period?: string;
}

export type RetentionDecl = RetentionBase &
  (
    | {
        class: RetentionClassId;
        /** Spalte, aus der sich der Startzeitpunkt ergibt: Zeitstempel oder Verweis auf Konto/Gruppe/Schuljahr */
        start: string;
        /** Ersatzspalte, wenn `start` leer ist */
        fallback?: string;
      }
    | {
        /** Wird zusammen mit Datensätzen dieser Tabelle gelöscht (Fremdschlüssel/Kaskade) */
        follows: string;
      }
  );

/** Core-Tabellen (gehören keinem Modul). */
export const CORE_RETENTION: RetentionDecl[] = [
  {
    table: "users",
    purpose: "Zugang zur Plattform, Zuordnung zu Klassen und Gruppen",
    categories: ["Name", "Benutzername", "E-Mail", "Rolle", "Kürzel", "Status", "Kennzeichen eigenständig + Einwilligung Eltern informieren"],
    class: "LK-KONTO",
    start: "id",
    period: "verwaltung.account_grace",
  },
  { table: "accounts", purpose: "Anmeldung", categories: ["Passwort-Hash"], follows: "users" },
  { table: "two_factors", purpose: "Zwei-Faktor-Anmeldung", categories: ["TOTP-Geheimnis (verschlüsselt)", "Wiederherstellungscodes (verschlüsselt)"], follows: "users" },
  { table: "passkeys", purpose: "Sicherheitsschlüssel/Passkeys als zweiter Faktor (SEC-03)", categories: ["öffentlicher Schlüssel", "Schlüsselkennung", "Name des Schlüssels", "angelegt/zuletzt benutzt"], follows: "users" },
  { table: "two_factor_code_lists", purpose: "Gedruckte Code-Liste (zweiter Faktor für Schüler:innen ohne Handy, SEC-02)", categories: ["Prüfwerte unbenutzter Codes (HMAC)", "erzeugt von/am"], follows: "users" },
  {
    table: "sessions",
    purpose: "Angemeldet bleiben",
    categories: ["Sitzungskennung", "IP-Adresse", "Browser", "letzte Aktivität (P4-71)"],
    class: "LK-SESSION",
    start: "expires_at",
  },
  {
    table: "verifications",
    purpose: "Einmalcodes (z. B. Passwort zurücksetzen)",
    categories: ["Kennung", "Code"],
    class: "LK-SESSION",
    start: "expires_at",
  },
  {
    table: "auth_throttle",
    purpose: "Schutz vor Passwort-Raten: Fehlversuche und vorübergehende Sperre",
    categories: ["Benutzername", "IP-Adresse", "Anzahl Fehlversuche"],
    class: "LK-SESSION",
    start: "updated_at",
  },
  {
    table: "mail_outbox",
    purpose: "Transaktionsmails zuverlässig zustellen (Warteschlange mit Wiederholung)",
    categories: ["Empfängeradresse", "Betreff", "Text", "Zweck", "Versuche", "Zeitpunkte"],
    class: "LK-90",
    start: "created_at",
    note: "Empfänger, Betreff und Text werden direkt nach dem Versand geleert – danach nur Kennzahlen",
  },
  {
    table: "rate_limits",
    purpose: "Schutz vor Missbrauch öffentlicher Formulare und Links (Anzahl Vorgänge je Zeitfenster)",
    categories: ["Schlüssel aus Zweck und IP-Adresse (gekürzt) bzw. E-Mail-Adresse – nur als HMAC", "Anzahl", "Fenster/Sperre"],
    class: "LK-SESSION",
    start: "expires_at",
    note: "nur bis zum Ende von Zeitfenster bzw. Sperre",
  },
  {
    table: "device_certs",
    purpose: "Außenzugang für Personal nur von freigegebenen Geräten (Gerätezertifikate, Sperrliste)",
    categories: ["Gerätebezeichnung", "Zertifikat (Fingerabdruck, Seriennummer, Laufzeit)", "gebundenes Konto (optional)", "Ausgestellt/gesperrt von", "Zeitpunkte"],
    class: "LK-ENDE-1J",
    start: "not_after",
    note: "Ende = Ablauf des Zertifikats; der private Schlüssel wird nie gespeichert",
  },
  { table: "parent_child", purpose: "Eltern sehen Daten ihrer Kinder", categories: ["Eltern-Kind-Zuordnung"], follows: "users" },
  {
    table: "profile_photos",
    purpose: "Profilbild – nur mit Einwilligung (Art. 6 Abs. 1 a DSGVO), Widerruf jederzeit",
    categories: ["Foto", "Einwilligung (Art, Datum, erteilt von)"],
    class: "LK-KONTO",
    start: "user_id",
    note: "Widerruf löscht das Foto sofort",
  },
  {
    table: "groups",
    purpose: "Klassen, Kurse, AGs und Gremien abbilden",
    categories: ["Gruppenname", "Leitung"],
    class: "LK-ENDE-1J",
    start: "school_year_id",
    note: "Ende = Archivierung beim Schuljahreswechsel; Gruppen ohne Schuljahr (Fachschaft, Gremium) bleiben bestehen",
  },
  { table: "group_members", purpose: "Mitgliedschaft in Gruppen", categories: ["Mitgliedschaft", "Leitung ja/nein"], class: "LK-KONTO", start: "user_id" },
  { table: "notifications", purpose: "Hinweise im Gong", categories: ["Hinweistext", "Gelesen-Zeitpunkt"], class: "LK-90", start: "created_at" },
  {
    table: "audit_log",
    purpose: "Nachweis von Änderungen in der Verwaltung (Art. 5 Abs. 2 DSGVO)",
    categories: ["Handelnde Person", "Vorgang", "Betroffenes Objekt", "Zeitpunkt"],
    class: "LK-1J",
    start: "created_at",
    note: "danach pseudonymisiert statt gelöscht",
  },
  {
    table: "privacy_holds",
    purpose: "Löschsperre (z. B. laufendes Verfahren)",
    categories: ["Person oder Gruppe", "Grund", "Befristung", "Angelegt von"],
    class: "LK-ENDE-1J",
    start: "until",
  },
  {
    table: "school_year_transitions",
    purpose: "Schuljahreswechsel nachvollziehen (Versetzung, Abgänge, Prüfschritt)",
    categories: ["Abgänger:innen (Konto-IDs)", "Neu angelegte Konten der Neuaufnahmen (Konto-IDs)", "Bearbeitet von", "Zeitpunkte"],
    class: "LK-SJ-1J",
    start: "created_at",
  },
  {
    table: "record_archives",
    purpose: "Nachweis der Archivexporte (Klassenbuch) und ihrer Übergabe",
    categories: ["Klasse", "Schuljahr", "Fristen", "Bearbeitet von"],
    class: "LK-ENDE-1J",
    start: "destroy_earliest",
    note: "Nachweis, solange die Akte aufbewahrt werden muss (Ende = frühestes Vernichtungsdatum)",
  },
  {
    table: "privacy_deletion_runs",
    purpose: "Nachweis der Löschungen (Löschprotokoll)",
    categories: ["Anzahlen je Datenart", "Ausgelöst von"],
    class: "LK-SJ-1J",
    start: "started_at",
    note: "nur Anzahlen, keine Inhalte",
  },
];

/** Tabellen ohne Personenbezug – mit Begründung, damit die Ausnahme bewusst bleibt. */
export const NO_PERSONAL_DATA: Record<string, string> = {
  app_settings: "Schuleinstellungen",
  school_years: "Stammdaten Schuljahre",
  subjects: "Stammdaten Fächer",
  rooms: "Stammdaten Räume",
  room_info_fields: "Infofelder des Raumsteckbriefs (Bezeichnung, Sichtbarkeit, Reihenfolge) – keine Personen",
  room_info_values: "Infofelder je Raum (Technik, Sicherheit, Lüftung …) – Sachangaben ohne Personendaten (Hinweis im Formular), wer geändert hat steht nur im Audit-Log",
  room_equipment_types: "Ausstattungskatalog des Raumsteckbriefs (RS-05, Name) – keine Personen",
  room_equipment_items: "Ausstattung je Raum mit Menge (RS-05) – Sachangaben, wer geändert hat steht nur im Audit-Log",
  room_photos: "Raumfotos (RS-04): Räume und Sachen, keine Personen (Hinweis am Upload), Metadaten entfernt; wer hochgeladen hat, steht nur im Audit-Log",
  periods: "Zeitraster",
  grade_levels: "Jahrgangsstufen",
  school_closures: "Ferien und unterrichtsfreie Tage",
  curriculum_hours: "Stundentafel",
  monitor_screens: "Bildschirme (Name, Ort, Profil, Token-Hash) – keine Personen",
  module_states: "Module an/aus",
  group_features: "Merkmale von Gruppen",
  grants: "Rechte an Rollen oder Gruppen, nie an Personen",
  booking_resources: "Buchbare Räume und Geräte",
  timetable_duty_areas: "Aufsichtsbereiche (Name, Reihenfolge)",
  timetable_forecast_grades: "Klassenzahl je Jahrgang im nächsten Schuljahr (SP2-12, Prognose des Fachbedarfs) – keine Personen",
  timetable_grade_rules: "Tagesgrenzen und Ganztag je Jahrgangsstufe (SP2-03: Stunden je Tag, Nachmittage, Mittag) – keine Personen",
  system_jobs: "Hintergrundjobs: Name, Sperre, Zeitpunkt und Ergebnis des letzten Laufs",
  pinnwaende_columns: "Spalten einer Pinnwand (Titel, Reihenfolge) – gelöscht mit der Pinnwand",
  anmeldung_slots: "Gesprächstermine eines Anmeldeverfahrens (Zeit, Raum, Plätze) – keine Personen; Buchungen stehen am Antrag",
  gebaeude_responsibilities: "Zuständige Gruppe je Meldungskategorie (Gruppe, keine Personen)",
  gebaeude_assets: "Anlagen und Geräte (Inventar) – keine Personen",
  gebaeude_inspection_types: "Prüfarten (Name, Intervall, Quelle) – keine Personen",
  buecherei_titles: "Bücherei-Bestand: Titel (bibliografische Angaben) – keine Personen",
  buecherei_copies: "Bücherei-Bestand: Exemplare (Nummer, Signatur, Standort, Zustand, Aussonderung) – keine Personen",
  buecherei_stats: "Bücherei: Zahl der Ausleihen und Verlängerungen je Monat und Medienart – keine Personen",
  buecherei_teaching_materials: "Schulbuchausleihe: Lernmittel je Jahrgang/Fach/Kurs (bibliografische Angaben, Preis) – keine Personen",
  buecherei_material_copies: "Schulbuchausleihe: Exemplare mit Inventarnummer, Zustand (Vermerk zur Sache), Aussonderung – keine Personen",
  hilfe_sections: "Handbuch: Bereiche (Titel, Reihenfolge) – keine Personen",
  buecherei_booklists: "Schulbuchausleihe: Hinweistext der Bücherliste je Jahrgang – keine Personen",
};

export interface RetentionEntry {
  /** Modul-id oder "core" */
  owner: string;
  decl: RetentionDecl;
}

export function collectRetention(modules: readonly { id: string; retention?: RetentionDecl[] }[]): RetentionEntry[] {
  return [
    ...CORE_RETENTION.map((decl) => ({ owner: "core", decl })),
    ...modules.flatMap((m) => (m.retention ?? []).map((decl) => ({ owner: m.id, decl }))),
  ];
}

/**
 * Prüft die Deklarationen gegen das echte Schema (`tables`: Tabellenname → Spaltennamen).
 * Liefert alle Fehler auf einmal; leeres Array = alles gedeckt.
 */
export function checkRetention(
  entries: readonly RetentionEntry[],
  tables: ReadonlyMap<string, readonly string[]>,
  noPersonalData: Record<string, string> = NO_PERSONAL_DATA,
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const declared = new Set<string>();
  for (const { owner, decl } of entries) {
    const key = `${decl.table}${decl.scope ? ` (${decl.scope})` : ""}`;
    if (seen.has(key)) errors.push(`${owner}: ${key} ist doppelt deklariert`);
    seen.add(key);
    declared.add(decl.table);
    const columns = tables.get(decl.table);
    if (!columns) {
      errors.push(`${owner}: Tabelle "${decl.table}" gibt es nicht`);
      continue;
    }
    if (decl.table in noPersonalData) errors.push(`${owner}: ${decl.table} steht zugleich in NO_PERSONAL_DATA`);
    if (!decl.purpose.trim() || decl.categories.length === 0) errors.push(`${owner}: ${key} braucht Zweck und Datenkategorien`);
    if ("follows" in decl) {
      if (!tables.has(decl.follows)) errors.push(`${owner}: ${key} folgt unbekannter Tabelle "${decl.follows}"`);
    } else {
      if (!(decl.class in RETENTION_CLASSES)) errors.push(`${owner}: ${key} hat unbekannte Löschklasse "${decl.class}"`);
      for (const col of [decl.start, decl.fallback, ...(decl.clear ?? [])]) {
        if (col !== undefined && !columns.includes(col)) errors.push(`${owner}: ${key} – Spalte "${col}" fehlt`);
      }
      if (decl.clear && !decl.where) errors.push(`${owner}: ${key} – Spalten leeren nur mit eigener Bedingung (where)`);
    }
    if (decl.period && ("follows" in decl || !CLASS_DAYS[decl.class])) errors.push(`${owner}: ${key} – einstellbare Frist (period) nur für Klassen mit Tagesfrist`);
    if (decl.held && !decl.where) errors.push(`${owner}: ${key} – „held“ nur mit eigener Bedingung (where)`);
    if (Boolean(decl.setting) !== Boolean(decl.where?.includes("{setting}")))
      errors.push(`${owner}: ${key} – „setting“ und Platzhalter {setting} in where gehören zusammen`);
  }
  for (const name of tables.keys()) {
    if (!declared.has(name) && !(name in noPersonalData)) {
      errors.push(`Tabelle "${name}" ist weder im Löschkonzept deklariert noch als „ohne Personenbezug" markiert`);
    }
  }
  for (const name of Object.keys(noPersonalData)) {
    if (!tables.has(name)) errors.push(`NO_PERSONAL_DATA nennt unbekannte Tabelle "${name}"`);
  }
  return errors;
}
