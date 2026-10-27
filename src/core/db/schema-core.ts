// Fundament von SchulOS: Gruppen, Rechte, Stammdaten, Benachrichtigungen, Audit-Log.
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { roleEnum, users } from "./schema-auth";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Schlüssel/Wert-Ablage für schulweite Einstellungen (Schulname, Schulfarbe, …). */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------- Stammdaten

export const schoolYears = pgTable("school_years", {
  id: id(),
  /** z. B. „2026/27" */
  name: text("name").notNull().unique(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  isCurrent: boolean("is_current").notNull().default(false),
  /** Beginn des 2. Halbjahres (Zeugnistermin danach); leer = keine Halbjahre gepflegt */
  term2StartsOn: date("term2_starts_on"),
});

// Neue Arten nur hinten anfügen: Postgres sortiert Enums nach Deklaration.
export const ROOM_KINDS = ["klassenraum", "nw", "informatik", "kunst", "musik", "sport", "werkraum", "kueche", "mensa", "aula", "sonstiges"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];
export const roomKindEnum = pgEnum("room_kind", ROOM_KINDS);

export const subjects = pgTable("subjects", {
  /** Kurzzeichen, z. B. „D", „M", „E", „BI" */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Fachfarbe als Hex, z. B. „#D9480F" */
  color: text("color").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  /** Wunsch-Raumart für den Unterricht, z. B. „sport“ oder „nw“ (leer = egal) */
  roomKind: roomKindEnum("room_kind"),
});

export const rooms = pgTable("rooms", {
  /** Raumkürzel, z. B. „112", „TH1" */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: roomKindEnum("kind").notNull().default("klassenraum"),
  building: text("building"),
  /** z. B. „EG“, „1. OG“ */
  floor: text("floor"),
  capacity: integer("capacity"),
  /** Schlüssel aus ROOM_EQUIPMENT */
  equipment: text("equipment").array().notNull().default(sql`'{}'::text[]`),
  accessible: boolean("accessible").notNull().default(false),
  /** inaktive Räume tauchen in Auswahllisten nicht mehr auf, bestehende Einträge bleiben */
  active: boolean("active").notNull().default(true),
});

export const ROOM_EQUIPMENT = ["beamer", "tafel_digital", "dokukamera", "lehrer_pc", "schueler_pcs", "audio", "waschbecken", "abzug"] as const;
export type RoomEquipment = (typeof ROOM_EQUIPMENT)[number];

export const GRADE_STAGES = ["sek1", "oberstufe"] as const;
export const gradeStageEnum = pgEnum("grade_stage", GRADE_STAGES);

/** Jahrgangsstufen der Schule (aus dem Schulprofil vorbelegt, frei benennbar), z. B. 5 … 10, EF, Q1, Q2. */
export const gradeLevels = pgTable("grade_levels", {
  level: integer("level").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  stage: gradeStageEnum("stage").notNull(),
});

// Neue Arten nur hinten anfügen: Postgres sortiert Enums nach Deklaration.
export const CLOSURE_KINDS = ["ferien", "frei"] as const;
export type ClosureKind = (typeof CLOSURE_KINDS)[number];
export const closureKindEnum = pgEnum("school_closure_kind", CLOSURE_KINDS);

/** Ferien und unterrichtsfreie Tage (bewegliche Ferientage, pädagogische Tage). Feiertage werden berechnet. */
export const schoolClosures = pgTable(
  "school_closures",
  {
    id: id(),
    kind: closureKindEnum("kind").notNull(),
    /** z. B. „Herbstferien“, „Pädagogischer Tag“ */
    name: text("name").notNull(),
    startsOn: date("starts_on").notNull(),
    /** einschließlich */
    endsOn: date("ends_on").notNull(),
    /** Herkunft: null = von Hand gepflegt (hat Vorrang), sonst automatischer Abruf (z. B. „openholidays“) */
    source: text("source"),
    /** ID beim Anbieter – bleibt auch nach Handänderung, damit der Abgleich den Eintrag wiedererkennt */
    externalId: text("external_id"),
  },
  (t) => [
    check("school_closures_range", sql`${t.endsOn} >= ${t.startsOn}`),
    index("school_closures_starts_idx").on(t.startsOn),
    uniqueIndex("school_closures_external_idx").on(t.externalId),
  ],
);

/** Stundentafel: Soll-Wochenstunden je Jahrgang und Fach (Klassenunterricht der Sek I) */
export const curriculumHours = pgTable(
  "curriculum_hours",
  {
    gradeLevel: integer("grade_level")
      .notNull()
      .references(() => gradeLevels.level, { onDelete: "cascade" }),
    subjectId: text("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    hours: integer("hours").notNull(),
  },
  (t) => [primaryKey({ columns: [t.gradeLevel, t.subjectId] }), check("curriculum_hours_range", sql`${t.hours} between 1 and 12`)],
);

/** Zeitraster: 1. Stunde 08:00–08:45 usw. */
export const periods = pgTable("periods", {
  nr: integer("nr").primaryKey(),
  startsAt: text("starts_at").notNull(),
  endsAt: text("ends_at").notNull(),
});

// ------------------------------------------------------------- Personen & Gruppen

export const parentChild = pgTable(
  "parent_child",
  {
    parentId: text("parent_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    childId: text("child_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.parentId, t.childId] }), index("parent_child_child_idx").on(t.childId)],
);

// Neue Arten nur hinten anfügen: Postgres sortiert Enums nach Deklaration.
export const GROUP_KINDS = ["klasse", "kurs", "ag", "fachschaft", "gremium", "frei", "wahlpflicht", "foerderkurs"] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];
export const groupKindEnum = pgEnum("group_kind", GROUP_KINDS);

export const groups = pgTable(
  "groups",
  {
    id: id(),
    name: text("name").notNull(),
    /** URL-tauglicher, eindeutiger Name, z. B. „7b" oder „q1-e-gk1" */
    slug: text("slug").notNull().unique(),
    kind: groupKindEnum("kind").notNull(),
    description: text("description"),
    schoolYearId: text("school_year_id").references(() => schoolYears.id, { onDelete: "set null" }),
    /** Jahrgangsstufe (siehe grade_levels.level) bei Klassen/Kursen */
    gradeLevel: integer("grade_level"),
    /** Kursniveau, z. B. „E“/„G“ (Sek I) oder „GK“/„LK“ (Oberstufe) */
    level: text("level"),
    subjectId: text("subject_id").references(() => subjects.id, { onDelete: "set null", onUpdate: "cascade" }),
    /** Stammraum (Klassenraum) – Vorgabe beim Setzen von Stunden */
    homeRoomId: text("home_room_id").references(() => rooms.id, { onDelete: "set null", onUpdate: "cascade" }),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    /** beim Schuljahreswechsel archiviert: ohne Mitglieder, nur noch für die Verwaltung sichtbar (B-08) */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("groups_kind_idx").on(t.kind)],
);

export const MEMBER_ROLES = ["member", "leader"] as const;
export const memberRoleEnum = pgEnum("member_role", MEMBER_ROLES);

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").notNull().default("member"),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index("group_members_user_idx").on(t.userId)],
);

/** Gruppenmerkmale (Bereiche, die eine Gruppe nutzt): z. B. „dateien.gruppenordner", „messenger.raum". */
export const groupFeatures = pgTable(
  "group_features",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    feature: text("feature").notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.feature] })],
);

// ------------------------------------------------------------------------ Rechte

/**
 * Ein Recht wird entweder einer Rolle ODER einer Gruppe gewährt (Prinzip
 * „Rechte über Gruppen"). Genau eins der beiden Ziele ist gesetzt.
 */
export const grants = pgTable(
  "grants",
  {
    id: id(),
    permission: text("permission").notNull(),
    role: roleEnum("role"),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    check("grants_one_target", sql`(${t.role} is null) <> (${t.groupId} is null)`),
    uniqueIndex("grants_role_uq").on(t.permission, t.role),
    uniqueIndex("grants_group_uq").on(t.permission, t.groupId),
  ],
);

/** Module an/aus. Fehlt eine Zeile, gilt der Default aus dem Manifest. */
export const moduleStates = pgTable("module_states", {
  moduleId: text("module_id").primaryKey(),
  enabled: boolean("enabled").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------- Querschnitt

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    moduleId: text("module_id").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"),
    readAt: timestamp("read_at", { withTimezone: true }),
    /**
     * Bündel (Q5-03): Gongs mit demselben Schlüssel ersetzen sich je Person, z. B. „stundenplan:2026-10-13“ = eine Nachricht
     * je Person und Tag. null = einzelne Nachricht.
     */
    bundleKey: text("bundle_key"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt), uniqueIndex("notifications_user_bundle_uq").on(t.userId, t.bundleKey)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    target: text("target"),
    meta: jsonb("meta"),
    /** nach Pseudonymisierung (Frist oder Kontolöschung): stabiles Pseudonym statt actor_id (B-06) */
    actorPseudonym: text("actor_pseudonym"),
    pseudonymizedAt: timestamp("pseudonymized_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_created_idx").on(t.createdAt), index("audit_log_actor_action_idx").on(t.actorId, t.action)],
);

export type Group = typeof groups.$inferSelect;
export type Grant = typeof grants.$inferSelect;
export type Subject = typeof subjects.$inferSelect;

// ------------------------------------------------------------------ Datenschutz (Track B)

/**
 * Löschsperre (Legal Hold, DATENSCHUTZ.md §3.7 Nr. 4): Daten einer Person oder Gruppe werden vom Löschlauf
 * ausgenommen – begründet und befristet.
 */
export const privacyHolds = pgTable(
  "privacy_holds",
  {
    id: id(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    /** einschließlich */
    until: date("until").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [check("privacy_holds_target", sql`(${t.userId} is null) <> (${t.groupId} is null)`)],
);

/** Löschprotokoll: je Lauf die Anzahlen je Tabelle – nie Inhalte (DATENSCHUTZ.md §3.7 Nr. 3). */
export const privacyDeletionRuns = pgTable("privacy_deletion_runs", {
  id: id(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** leer = nächtlicher Lauf */
  triggeredBy: text("triggered_by").references(() => users.id, { onDelete: "set null" }),
  /** [{ table, scope, deleted, error }] */
  result: jsonb("result").notNull(),
  total: integer("total").notNull().default(0),
});

export const PHOTO_CONSENT_BASES = ["self", "parent", "paper"] as const;
export const photoConsentBasisEnum = pgEnum("photo_consent_basis", PHOTO_CONSENT_BASES);

/**
 * Profilbild (B-07, DS-09, § 120 Abs. 6 SchulG NRW): eine Zeile = Foto **und** Einwilligung liegen vor. Ohne Zeile
 * zeigt SchulOS Initialen. Widerruf löscht Zeile und Datei sofort; Nachweis von Einwilligung/Widerruf im Audit-Log.
 */
export const profilePhotos = pgTable("profile_photos", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  mime: text("mime").notNull(),
  /** self = die Person selbst · parent = Erziehungsberechtigte:r im System · paper = schriftlich, von der Verwaltung erfasst */
  consentBasis: photoConsentBasisEnum("consent_basis").notNull(),
  consentBy: text("consent_by").references(() => users.id, { onDelete: "set null" }),
  /** Datum der Einwilligung (bei „paper“ das Datum auf dem Formular) */
  consentOn: date("consent_on").notNull(),
  createdAt: createdAt(),
});

/**
 * Schuljahreswechsel (B-08, DS-10): ein Durchlauf je abgeschlossenem Schuljahr. Die Schritte sind Zeitstempel,
 * damit der Assistent weiß, wo er steht.
 */
export const schoolYearTransitions = pgTable("school_year_transitions", {
  id: id(),
  fromYearId: text("from_year_id")
    .notNull()
    .unique()
    .references(() => schoolYears.id, { onDelete: "cascade" }),
  toYearId: text("to_year_id")
    .notNull()
    .references(() => schoolYears.id, { onDelete: "cascade" }),
  startedBy: text("started_by").references(() => users.id, { onDelete: "set null" }),
  /** Versetzung: neue Klassen angelegt, Abgänger vorgemerkt */
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  /** Konto-IDs der Abgänger:innen – werden beim Abschluss mit Abgangsdatum gesperrt */
  leavers: jsonb("leavers").$type<string[]>().notNull().default([]),
  /** Neuaufnahmen aus der Schulanmeldung übernommen (P4-39; entfällt ohne aufgenommene Anträge) */
  admittedAt: timestamp("admitted_at", { withTimezone: true }),
  /** Konto-IDs, die der Schritt „Neuaufnahmen“ neu angelegt hat (Kinder + neue Elternkonten) – für „Startpasswörter neu erzeugen“ (Q5-21) */
  admittedUsers: jsonb("admitted_users").$type<string[]>().notNull().default([]),
  /** Gruppen des alten Schuljahres archiviert */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  /** Pflichtschritt „Löschprotokoll und Sperren geprüft“ (DATENSCHUTZ.md §3.8) */
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /**
   * SP3-LA (F-10-7): Klassen-Zuordnung alt → neu aus der Versetzung (`{ "<alte Gruppen-id>": "<neue Gruppen-id>" }`) für „Lehrkraft folgt
   * der Klasse“. `null` = Übergang vor SP3-LA – dann rekonstruiert die Übernahme die Zuordnung über die Namensregel.
   */
  classMap: jsonb("class_map").$type<Record<string, string>>(),
  createdAt: createdAt(),
});

/**
 * Archivexport einer Akte (Klassenbuch) je Gruppe (DATENSCHUTZ.md §3.6). Name und Schuljahr werden kopiert, damit der
 * Nachweis die Löschung der Gruppe überdauert. Erst nach „übergeben“ darf der Löschlauf die Akte löschen.
 */
export const recordArchives = pgTable("record_archives", {
  id: id(),
  groupId: text("group_id")
    .unique()
    .references(() => groups.id, { onDelete: "set null" }),
  groupName: text("group_name").notNull(),
  schoolYearName: text("school_year_name").notNull(),
  /** Abschlussdatum der Akte (Ende des Schuljahres) */
  closedOn: date("closed_on").notNull(),
  /** frühestes Vernichtungsdatum: 31.12. des Abschlussjahres + 10 Jahre (§ 9 VO-DV I) */
  destroyEarliest: date("destroy_earliest").notNull(),
  exportedAt: timestamp("exported_at", { withTimezone: true }).notNull().defaultNow(),
  exportedBy: text("exported_by").references(() => users.id, { onDelete: "set null" }),
  handedOverAt: timestamp("handed_over_at", { withTimezone: true }),
  handedOverBy: text("handed_over_by").references(() => users.id, { onDelete: "set null" }),
});

/** Hintergrundjobs im App-Prozess (B-17): Sperre gegen Doppelläufe + letzter Lauf. Keine Personendaten. */
export const systemJobs = pgTable("system_jobs", {
  name: text("name").primaryKey(),
  /** gesperrt bis – ein Lauf hält die Sperre, abgestürzte Läufe geben sie nach Ablauf frei */
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lockedBy: text("locked_by"),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
  /** ok | failed */
  lastStatus: text("last_status"),
  lastError: text("last_error"),
});

/**
 * Transaktionsmails (P4-30): Warteschlange mit Wiederholung. Nach dem Versand (bzw. endgültigem Fehlschlag) werden
 * Empfänger, Betreff und Text geleert – es bleiben nur Zweck, Versuche und Zeitpunkte (LK-90 ab `created_at`).
 */
export const mailOutbox = pgTable(
  "mail_outbox",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** Empfängeradresse (eine je Zeile) */
    to: text("to").notNull(),
    subject: text("subject").notNull(),
    text: text("text").notNull(),
    /** Zweck, z. B. „email-bestaetigen“, „testmail“ – bleibt für die Kennzahlen */
    purpose: text("purpose").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** nächster Versuch frühestens (Wiederholung mit wachsendem Abstand) */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** endgültig gescheitert (zu viele Versuche) */
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mail_outbox_pending_idx").on(t.nextAttemptAt)],
);

/**
 * Zähler gegen Missbrauch (P4-31): je Zweck und Subjekt (IP gekürzt, E-Mail, Konto) – der Schlüssel ist ein HMAC, die
 * Adresse selbst steht nirgends. Zeilen leben nur bis zum Ende von Fenster bzw. Sperre (`expires_at`, LK-SESSION).
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    blockedUntil: timestamp("blocked_until", { withTimezone: true }),
    /** Ende von Fenster bzw. Sperre – danach ist die Zeile bedeutungslos und wird gelöscht */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("rate_limits_expires_idx").on(t.expiresAt)],
);

/**
 * Gerätezertifikate für den Personal-Außenzugang (P4-40b, SICHERHEIT.md S27): ausgestellt von der Schul-CA (step-ca), hier
 * nur das Zertifikat (Fingerabdruck, Seriennummer, Laufzeit) – der private Schlüssel wird nie gespeichert. Die Zeile ist
 * die Freigabe: ein Zertifikat ohne Zeile, mit `revoked_at` oder außerhalb der Laufzeit gilt nicht (Sperrliste in der App).
 * Optional an ein Konto gebunden – dann gilt es nur für dieses Konto. LK-ENDE-1J ab `not_after`.
 */
export const deviceCerts = pgTable(
  "device_certs",
  {
    id: id(),
    /** Gerätebezeichnung der Verwaltung, z. B. „iPad Lehrerzimmer 3“ – steht nicht im Zertifikat */
    label: text("label").notNull(),
    /** Common Name im Zertifikat (`geraet-<zufall>`, ohne Personenbezug) */
    commonName: text("common_name").notNull(),
    /** SHA-256 über das DER-Zertifikat, 64 Hex-Zeichen klein – so liefert Caddy ihn (`{http.request.tls.client.fingerprint}`) */
    fingerprint: text("fingerprint").notNull(),
    serial: text("serial").notNull(),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
    /** optional: gilt nur für dieses Konto (Konto gelöscht → Zertifikat weg, nie „frei für alle“) */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => users.id, { onDelete: "set null" }),
    /** Grund der Sperre (Auswahl, kein Freitext): verloren, ausgemustert, kompromittiert, sonstiges */
    revokeReason: text("revoke_reason"),
  },
  (t) => [uniqueIndex("device_certs_fingerprint_idx").on(t.fingerprint), index("device_certs_user_idx").on(t.userId)],
);
