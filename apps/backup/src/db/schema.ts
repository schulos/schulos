// Datenbank des Backupservers (eigene PGlite-Datenbank, getrennt vom Hauptsystem).
// Nur relative Imports – drizzle-kit kennt `@/` nicht. Better-Auth erwartet die JS-Schlüssel wie im Hauptsystem.
import { bigint, bigserial, boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const USER_STATUS = ["active", "locked"] as const;
export const userStatusEnum = pgEnum("user_status", USER_STATUS);

/** Konten der Web-UI – alle mit vollen Rechten, Zwei-Faktor-Anmeldung ist Pflicht. */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  username: text("username").unique(),
  displayUsername: text("display_username"),
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name").notNull().default(""),
  status: userStatusEnum("status").notNull().default("active"),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  /** Startpasswort (angelegt bzw. zurückgesetzt durch einen anderen Admin): bis zum eigenen Wechsel nur /passwort */
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  ...timestamps,
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  ...timestamps,
});

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

/** Zweiter Faktor (TOTP-Geheimnis und Wiederherstellungscodes, beide von Better-Auth verschlüsselt). */
export const twoFactors = pgTable(
  "two_factors",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [index("two_factors_user_idx").on(t.userId), index("two_factors_secret_idx").on(t.secret)],
);

/** Anmeldesperre (Regeln: @schulos/server/throttle) – Schlüssel „u:<name>“ bzw. „ip:<adresse>“. */
export const authThrottle = pgTable("auth_throttle", {
  key: text("key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Protokoll aller Anmeldungen, Konfigurationsänderungen und (später) Wiederherstellungen. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    target: text("target"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_created_idx").on(t.createdAt)],
);

/** Einstellungen als Schlüssel/Wert (Zeitpläne, Aufbewahrung … ab B-25). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;

/** Gekoppelte SchulOS-Hauptsysteme (INSTALLATION.md §4.3). Je Instanz ein restic-Repository mit eigenem rest-server-Zugang. */
export const instances = pgTable("instances", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Benutzer im rest-server (.htpasswd) und zugleich Name des Repository-Ordners */
  restUser: text("rest_user").notNull().unique(),
  /** Repository-Passwort, verschlüsselt mit dem App-Geheimnis (für Prune, Prüfung, Test-Restore) */
  repoPasswordEnc: text("repo_password_enc").notNull(),
  /** SHA-256 des Agent-Tokens */
  agentTokenHash: text("agent_token_hash").notNull().unique(),
  mainUrl: text("main_url"),
  pairedBy: text("paired_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  /** Uhrzeiten der Sicherung (Europe/Berlin, „HH:MM“); Pflege in der Web-UI ab B-25 */
  schedule: jsonb("schedule").$type<string[]>().notNull().default(["01:30"]),
  /** „Jetzt sichern“ – vom Hauptsystem oder der Web-UI angefordert, der Agent holt es mit dem nächsten Plan ab */
  runRequestedAt: timestamp("run_requested_at", { withTimezone: true }),
  /** Aufbewahrung (restic forget): Tages-, Wochen-, Monatsstände – Vorgabe 14/4/3 (DATENSCHUTZ.md §3.3, LK-BACKUP) */
  retention: jsonb("retention").$type<{ daily: number; weekly: number; monthly: number }>().notNull().default({ daily: 14, weekly: 4, monthly: 3 }),
  /** Begründung, wenn die Aufbewahrung über 3 Monate hinausgeht */
  retentionReason: text("retention_reason"),
  /** Entkoppelt: Zugang entfernt, das Repository bleibt (Löschen nur bewusst, später) */
  removedAt: timestamp("removed_at", { withTimezone: true }),
});

/** Offene Kopplungscodes – gespeichert wird nur der Suchschlüssel und der verschlüsselte Code-Schlüssel, nie der Code. */
export const pairingCodes = pgTable("pairing_codes", {
  id: text("id").primaryKey(),
  lookup: text("lookup").notNull().unique(),
  keyEnc: text("key_enc").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  instanceId: text("instance_id").references(() => instances.id, { onDelete: "set null" }),
  /** Ersatz-Kopplung (neue Hardware, INSTALLATION.md §4.4): Code gilt für diese bestehende Instanz und ihr Repository */
  replacesInstanceId: text("replaces_instance_id").references(() => instances.id, { onDelete: "cascade" }),
  /**
   * Antwort auf „claim“ (verschlüsselt mit dem App-Geheimnis) – nur kurz nach der Kopplung, damit ein Versuch, dessen Antwort
   * verloren ging, mit demselben Code wiederholt werden kann; danach gelöscht (`forgetPairingResults`).
   */
  resultEnc: text("result_enc"),
});

export type Instance = typeof instances.$inferSelect;

/** Sicherungsläufe, gemeldet vom Backup-Agenten des Hauptsystems (ohne Inhalte, nur Kennzahlen). */
export const backupRuns = pgTable(
  "backup_runs",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    /** zeitplan | angefordert | erstlauf */
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    snapshotId: text("snapshot_id"),
    /** Größe der gesicherten Daten bzw. neu hinzugekommene Daten im Repository (Bytes) */
    bytesTotal: bigint("bytes_total", { mode: "number" }),
    bytesAdded: bigint("bytes_added", { mode: "number" }),
    error: text("error"),
    agentVersion: text("agent_version"),
  },
  (t) => [index("backup_runs_instance_idx").on(t.instanceId, t.finishedAt)],
);

/** Wartung auf dem Backupserver: Aufräumen (prune), Prüfung (check), Test-Restore – je Lauf eine Zeile. */
export const maintenanceRuns = pgTable(
  "maintenance_runs",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    /** prune | check | restore_test */
    kind: text("kind").notNull(),
    /** ok | failed */
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    /** Kennzahlen, z. B. { behalten: 18, entfernt: 1 } – keine Inhalte */
    details: jsonb("details").$type<Record<string, unknown>>(),
    error: text("error"),
    /** null = automatisch (Zeitplan) */
    triggeredBy: text("triggered_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("maintenance_runs_instance_idx").on(t.instanceId, t.kind, t.finishedAt)],
);

/** Aufträge „auf Hauptsystem wiederherstellen“ (INSTALLATION.md §4.4) – laufen erst nach Bestätigung mit dem Code auf dem Hauptsystem. */
export const restoreJobs = pgTable(
  "restore_jobs",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id").notNull(),
    snapshotShort: text("snapshot_short").notNull(),
    snapshotTime: timestamp("snapshot_time", { withTimezone: true }).notNull(),
    /** komplett | dateien */
    scope: text("scope").notNull(),
    /** wartet | bestaetigt | laeuft | fertig | fehlgeschlagen | abgelehnt */
    status: text("status").notNull(),
    /** SHA-256 von Auftrag + Bestätigungscode */
    codeHash: text("code_hash").notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    details: jsonb("details").$type<Record<string, unknown>>(),
    error: text("error"),
  },
  (t) => [index("restore_jobs_instance_idx").on(t.instanceId, t.createdAt)],
);
