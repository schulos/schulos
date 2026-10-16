// Tabellen, die Better-Auth erwartet. Die JS-Schlüssel müssen den Better-Auth-Feldnamen
// entsprechen (id, name, email, emailVerified, …) – Spaltennamen in der DB sind snake_case.
import { boolean, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { ROLES, type Role } from "../roles";

export { ROLES, type Role };
export const roleEnum = pgEnum("role", ROLES);

export const USER_STATUS = ["active", "locked"] as const;
export const userStatusEnum = pgEnum("user_status", USER_STATUS);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    /** Anzeigename, z. B. „Jana Brandt" */
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    // username-Plugin
    username: text("username").unique(),
    displayUsername: text("display_username"),
    // SchulOS-Felder
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    /** Lehrkraft-Kürzel, z. B. „BRA" */
    shortCode: text("short_code").unique(),
    role: roleEnum("role").notNull().default("schueler"),
    /** Sprechzeiten und Raum (nur Rolle `beratung`, Q5-17) – erscheint im Adressbuch */
    officeHours: text("office_hours"),
    status: userStatusEnum("status").notNull().default("active"),
    /** Abgang/Ausscheiden (Konto-Lebenszyklus, LK-KONTO): Konto gesperrt, Löschung nach der Karenz */
    leftOn: date("left_on"),
    /** Löschung auf Antrag (Art. 17): ohne Karenz, sobald keine Aktenpflicht mehr entgegensteht */
    erasureRequestedOn: date("erasure_requested_on"),
    // twoFactor-Plugin: erst nach bestätigtem Code true
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    /**
     * SEC-01 (Q-5A-30): Die Verwaltung erlaubt die Ersteinrichtung der 2FA von außerhalb des Schulnetzes bis zu diesem Zeitpunkt
     * (48 h); die Einrichtung selbst leert das Feld. Better Auth kennt die Spalte nicht.
     */
    twoFactorSetupUntil: timestamp("two_factor_setup_until", { withTimezone: true }),
    /** Startpasswort der Verwaltung (Anlegen, Import, Zurücksetzen): bis zum eigenen Wechsel keine Rechte (B-11) */
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    /**
     * Q5-05 (I-05): Schüler:in handelt eigenständig (volljährig, § 123 Abs. 2 SchulG NRW) – setzt die Verwaltung, kein
     * Geburtsdatum nötig. Elternbriefe/Umfragen gehen an die Person selbst, Abwesenheiten meldet sie selbst, Eltern sehen nichts mehr.
     */
    selfResponsible: boolean("self_responsible").notNull().default(false),
    /** Q5-05: Einwilligung der eigenständigen Person „Eltern weiter informieren“ (nur von ihr selbst gesetzt; null = nein) */
    parentsInformedSince: timestamp("parents_informed_since", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("users_role_idx").on(t.role), index("users_last_name_idx").on(t.lastName)],
);

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
    /**
     * GATE-5a (G5A-S04): Sitzung entstand mit zweitem Faktor (Anmeldung mit Code bzw. Wiederherstellungscode) – gesetzt von
     * `completeSecondFactor` (zwei-faktor.ts). Das Notenbuch verlangt das, wenn das Konto 2FA hat; Better Auth kennt die Spalte nicht.
     */
    secondFactorAt: timestamp("second_factor_at", { withTimezone: true }),
    /** P4-71: letzte Aktivität (höchstens minütlich aufgefrischt) – für den Inaktivitätsablauf und die Sitzungsübersicht */
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
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
  },
  (t) => [index("accounts_user_idx").on(t.userId)],
);

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

/**
 * SEC-02: Gedruckte Code-Liste für Schüler:innen ohne Handy (zweiter Faktor für die Anmeldung von außen). Je Konto eine Liste;
 * gespeichert nur die HMACs der noch **unbenutzten** Codes – ein benutzter Code verschwindet, eine neue Liste ersetzt die alte.
 */
export const twoFactorCodeLists = pgTable("two_factor_code_lists", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** HMAC-SHA-256 (hex) je unbenutztem Code */
  codes: jsonb("codes").$type<string[]>().notNull(),
  /** Anzahl Codes beim Erzeugen (Anzeige „n von m übrig“) */
  total: integer("total").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * SEC-03: Sicherheitsschlüssel und Passkeys (WebAuthn) als zweiter Faktor nach dem Passwort – keine passwortlose Anmeldung.
 * Gespeichert sind nur der öffentliche Schlüssel und die Kennung des Schlüssels; Spalten wie im Passkey-Plugin von Better Auth
 * (ein späterer Wechsel bliebe möglich), dazu `last_used_at`.
 */
export const passkeys = pgTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    /** Name, den die Person vergibt (z. B. „Schlüssel blau“) */
    name: text("name").notNull(),
    /** öffentlicher Schlüssel (COSE, base64url) */
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Kennung des Schlüssels (base64url), weltweit eindeutig */
    credentialId: text("credential_id").notNull().unique(),
    counter: integer("counter").notNull().default(0),
    /** „singleDevice“ (Sicherheitsschlüssel) oder „multiDevice“ (synchronisierter Passkey) */
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull().default(false),
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("passkeys_user_idx").on(t.userId)],
);

/**
 * Fehlversuche bei der Anmeldung je Schlüssel („u:<benutzername>“ bzw. „ip:<adresse>“) für die vorübergehende Sperre (B-10).
 * Der Benutzername steht hier auch dann, wenn es das Konto nicht gibt – sonst ließe sich ausprobieren, welche existieren.
 */
export const authThrottle = pgTable("auth_throttle", {
  key: text("key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
