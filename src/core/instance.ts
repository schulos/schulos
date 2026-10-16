// Instanztyp und Erststart (INSTALLATION.md §3.4): SCHULOS_INSTANCE = demo | production.
// - leere Datenbank + demo        → Demo-Schule per Seed
// - leere Datenbank + production  → nur Schuleinstellungen + Admin-Konto aus der Konfiguration (optional Vorlagen)
// - Demo ↔ Produktiv ist ausgeschlossen: der Typ steht in app_settings, ein anderer Typ verweigert den Start.
// Ohne SCHULOS_INSTANCE (Entwicklung, `npm run db:reset`) passiert nichts.
import { count, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { appSettings, schoolYears, subjects, periods, users } from "@/core/db/schema";
import { createUserWithPassword, hashPassword } from "@/core/auth/auth";
import { parseAdminConfig, type AdminConfig } from "@schulos/server/admin";
import { syncDefaultGrants } from "@/core/modules/registry";
import { isSchoolForm, isStateCode } from "@/core/school/catalog";
import { SUBJECT_TEMPLATE, defaultTimeGrid } from "@/core/school/templates";
import { seedDemoSchool } from "@/core/seed/seed";
import type { FileStorage } from "@/core/files/storage";
import { MODULES } from "@/modules";
import { applyCurriculumTemplate, ensureGradeLevels } from "@/modules/verwaltung/stammdaten";

export type InstanceType = "demo" | "production";
export type Env = Record<string, string | undefined>;

export class InstanceError extends Error {}

export const INSTANCE_KEY = "instance.type";

export function instanceTypeFrom(env: Env): InstanceType | undefined {
  const v = env.SCHULOS_INSTANCE?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "demo" || v === "production") return v;
  throw new InstanceError(`SCHULOS_INSTANCE="${env.SCHULOS_INSTANCE}" ist ungültig (erlaubt: demo, production).`);
}

/** Admin-Konto aus SCHULOS_ADMIN_* (Regeln in @schulos/server/admin). */
export function adminFromEnv(env: Env): AdminConfig {
  const r = parseAdminConfig(env);
  if (!r.ok) throw new InstanceError(`Produktiv-Erststart nicht möglich:\n  - ${r.errors.join("\n  - ")}`);
  return r.admin;
}

/** Schuljahr, in dem `today` liegt (1. 8. bis 31. 7.). */
export function schoolYearFor(today: Date): { id: string; name: string; startsOn: string; endsOn: string; term2StartsOn: string } {
  const y = today.getMonth() >= 7 ? today.getFullYear() : today.getFullYear() - 1;
  return {
    id: `sj-${y}-${String(y + 1).slice(2)}`,
    name: `${y}/${String(y + 1).slice(2)}`,
    startsOn: `${y}-08-01`,
    endsOn: `${y + 1}-07-31`,
    term2StartsOn: `${y + 1}-02-01`,
  };
}

async function storedType(db: Db): Promise<InstanceType | undefined> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, INSTANCE_KEY));
  const v = rows[0]?.value;
  return v === "demo" || v === "production" ? v : undefined;
}

async function isDemoFlag(db: Db): Promise<boolean> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, "demo"));
  return row?.value === true;
}

/** Instanztyp laut Datenbank: gespeicherte Einstellung, sonst bei vorhandenen Konten aus dem Demo-Kennzeichen; leer → undefined. */
export async function instanceTypeInDb(db: Db): Promise<InstanceType | undefined> {
  const stored = await storedType(db);
  if (stored) return stored;
  const n = (await db.select({ n: count() }).from(users))[0]?.n ?? 0;
  if (n === 0) return undefined;
  return (await isDemoFlag(db)) ? "demo" : "production";
}

export type InstanceResult =
  | { action: "none" }
  | { action: "checked"; type: InstanceType }
  | { action: "seeded-demo"; users: number }
  | { action: "created-production"; admin: string; usedPlainPassword: boolean };

/** Prüft bzw. initialisiert die Instanz. Wirft InstanceError, wenn Konfiguration und Datenbank nicht zusammenpassen. */
export async function initializeInstance(db: Db, env: Env, today = new Date(), storage?: FileStorage): Promise<InstanceResult> {
  const type = instanceTypeFrom(env);
  if (!type) return { action: "none" };
  const n = (await db.select({ n: count() }).from(users))[0]?.n ?? 0;
  const demoFlag = await isDemoFlag(db);
  const stored = (await storedType(db)) ?? (n > 0 ? (demoFlag ? "demo" : "production") : undefined);

  if (stored && stored !== type) {
    throw new InstanceError(
      stored === "demo"
        ? "Diese Datenbank ist eine Demo-Instanz. Demo → Produktiv ist ausgeschlossen: eine Produktivinstanz entsteht immer leer (neue Datenbank)."
        : "Diese Datenbank ist eine Produktivinstanz und kann nicht als Demo gestartet werden.",
    );
  }
  if (n > 0) {
    if (type === "production" && demoFlag) throw new InstanceError("Die Datenbank enthält Demo-Daten – Produktivstart verweigert.");
    await db.insert(appSettings).values({ key: INSTANCE_KEY, value: type }).onConflictDoNothing();
    return { action: "checked", type };
  }

  if (type === "demo") {
    const s = await seedDemoSchool(db, { storage });
    await db.insert(appSettings).values({ key: INSTANCE_KEY, value: "demo" });
    return { action: "seeded-demo", users: s.users };
  }

  // Produktiv: leer bis auf Schuleinstellungen und Admin-Konto
  const admin = adminFromEnv(env);
  const state = env.SCHULOS_SCHOOL_STATE?.trim().toUpperCase();
  const form = env.SCHULOS_SCHOOL_FORM?.trim().toLowerCase();
  if (state && !isStateCode(state)) throw new InstanceError(`SCHULOS_SCHOOL_STATE="${state}" ist kein Bundesland-Kürzel (z. B. NW).`);
  if (form && !isSchoolForm(form)) throw new InstanceError(`SCHULOS_SCHOOL_FORM="${form}" ist keine bekannte Schulform.`);
  const settings: { key: string; value: unknown }[] = [
    { key: INSTANCE_KEY, value: "production" },
    { key: "school.name", value: env.SCHULOS_SCHOOL_NAME?.trim() || "SchulOS" },
  ];
  if (env.SCHULOS_SCHOOL_NUMBER?.trim()) settings.push({ key: "school.number", value: env.SCHULOS_SCHOOL_NUMBER.trim() });
  if (state) settings.push({ key: "school.state", value: state });
  if (form) settings.push({ key: "school.form", value: form });
  const passwordHash = "hash" in admin.password ? admin.password.hash : await hashPassword(admin.password.plain);

  await db.transaction(async (tx) => {
    await tx.insert(appSettings).values(settings);
    await tx.insert(schoolYears).values({ ...schoolYearFor(today), isCurrent: true });
    await syncDefaultGrants(tx as unknown as Db, MODULES);
    await createUserWithPassword(
      tx as unknown as Db,
      { id: `u-${admin.username}`, name: `${admin.firstName} ${admin.lastName}`, firstName: admin.firstName, lastName: admin.lastName, username: admin.username, role: "admin" },
      { hash: passwordHash },
    );
  });
  // Vorlagen ohne Personendaten (Fächer mit Farben, Zeitraster, Jahrgänge, Stundentafel) – optional
  if (env.SCHULOS_TEMPLATES === "1") {
    await db.insert(subjects).values(SUBJECT_TEMPLATE.map((s, i) => ({ ...s, sortOrder: i })));
    await db.insert(periods).values(defaultTimeGrid({ form: isSchoolForm(form) ? form : "gesamtschule" }).periods);
    await ensureGradeLevels(db);
    await applyCurriculumTemplate(db, null);
  }
  return { action: "created-production", admin: admin.username, usedPlainPassword: "plain" in admin.password };
}

