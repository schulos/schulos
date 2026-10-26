// Schulbücherei – Freitext- und Datumseinstellungen, die die Optionslisten der Moduleinstellungen nicht abbilden (BU-14, BU-17):
// Rückgabetag der Schulbücher je Schuljahr und „Hinweis im Ersatzbrief“. Gespeichert in app_settings (`module.buecherei.…`), ohne
// Personenbezug (Freitext: nur die Sache, keine Namen). Pflege mit `buecherei.materials`, Änderungen im Audit-Log.
import { and, eq, gte, isNull } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { appSettings, buechereiMaterialIssues, schoolYears } from "@/core/db/schema";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { canMaterials, lernmittelEnabled } from "./lernmittel";

export const MAX_COMPENSATION_NOTE = 600;

const returnDayKey = (yearId: string) => `module.buecherei.return_day.${yearId}`;
const NOTE_KEY = "module.buecherei.compensation_note";

async function readText(db: Db, key: string): Promise<string | null> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key));
  return typeof row?.value === "string" && row.value.trim() ? row.value : null;
}

async function writeText(db: Db, key: string, value: string | null): Promise<void> {
  if (value === null) {
    await db.delete(appSettings).where(eq(appSettings.key, key));
    return;
  }
  await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Rein: Rückgabetag, der gilt – der eingestellte, sonst das Schuljahresende. */
export const effectiveReturnDay = (custom: string | null, yearEndsOn: string) => custom ?? yearEndsOn;

/** Eingestellter Rückgabetag eines Schuljahres (null = nicht eingestellt → Schuljahresende). */
export async function customReturnDay(db: Db, yearId: string): Promise<string | null> {
  const v = await readText(db, returnDayKey(yearId));
  return v && isYmd(v) ? v : null;
}

/** Rückgabetag der Schulbücher eines Schuljahres: eingestellt oder Schuljahresende. */
export async function returnDayOf(db: Db, year: { id: string; endsOn: string }): Promise<string> {
  return effectiveReturnDay(await customReturnDay(db, year.id), year.endsOn);
}

export interface ReturnDayInfo {
  yearId: string;
  yearName: string;
  endsOn: string;
  /** Rückgabetag, der gilt */
  day: string;
  /** eingestellt (sonst Schuljahresende) */
  custom: boolean;
}

/** Rückgabetag des laufenden Schuljahres (null ohne laufendes Schuljahr). */
export async function currentReturnDay(db: Db): Promise<ReturnDayInfo | null> {
  const [y] = await db.select({ id: schoolYears.id, name: schoolYears.name, endsOn: schoolYears.endsOn }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
  if (!y) return null;
  const custom = await customReturnDay(db, y.id);
  return { yearId: y.id, yearName: y.name, endsOn: y.endsOn, day: effectiveReturnDay(custom, y.endsOn), custom: custom !== null };
}

/**
 * Rückgabetag eines Schuljahres setzen (BU-14); leer = Schuljahresende. Muss zwischen heute und dem Schuljahresende liegen.
 * Offene Ausgaben des Schuljahres bekommen die neue Fälligkeit; liegt sie nicht in der Vergangenheit, beginnt die Mahnung von vorn.
 */
export async function setReturnDay(db: Db, viewer: PermissionSet, yearId: string, raw: string, today: string): Promise<void> {
  if (!canMaterials(viewer)) throw new ForbiddenError("buecherei.materials");
  if (!(await lernmittelEnabled(db))) throw new ValidationError({ returnDay: "Die Schulbuchausleihe ist ausgeschaltet (Verwaltung → Rechte & Module → Bücherei)" });
  const [year] = await db.select({ id: schoolYears.id, endsOn: schoolYears.endsOn }).from(schoolYears).where(eq(schoolYears.id, yearId));
  if (!year) throw new ValidationError({ returnDay: "Schuljahr gibt es nicht" });
  const value = raw.trim();
  if (value) {
    if (!isYmd(value)) throw new ValidationError({ returnDay: "Datum wie 2027-06-25 eingeben" });
    if (value < today) throw new ValidationError({ returnDay: "Der Rückgabetag darf nicht in der Vergangenheit liegen" });
    if (value > year.endsOn) throw new ValidationError({ returnDay: "Der Rückgabetag muss spätestens am Schuljahresende liegen" });
  }
  await writeText(db, returnDayKey(yearId), value || null);
  const due = value || year.endsOn;
  await db.update(buechereiMaterialIssues).set({ dueOn: due }).where(and(eq(buechereiMaterialIssues.schoolYearId, yearId), isNull(buechereiMaterialIssues.returnedOn)));
  // Frist wieder in der Zukunft → Mahnung von vorn
  await db
    .update(buechereiMaterialIssues)
    .set({ dunningLevel: 0, dunnedOn: null })
    .where(and(eq(buechereiMaterialIssues.schoolYearId, yearId), isNull(buechereiMaterialIssues.returnedOn), gte(buechereiMaterialIssues.dueOn, today)));
  await audit(db, viewer.userId, "buecherei.material.return_day", yearId, { returnDay: value || null });
}

/** „Hinweis im Ersatzbrief“ (BU-17): Freitext der Schule, erscheint im Druck unter Betrag und Grund; null = nichts. */
export async function compensationNote(db: Db): Promise<string | null> {
  return readText(db, NOTE_KEY);
}

export async function setCompensationNote(db: Db, viewer: PermissionSet, raw: string): Promise<void> {
  if (!canMaterials(viewer)) throw new ForbiddenError("buecherei.materials");
  const value = raw.replace(/\r\n/g, "\n").trim();
  if (value.length > MAX_COMPENSATION_NOTE) throw new ValidationError({ note: `Höchstens ${MAX_COMPENSATION_NOTE} Zeichen (nur die Sache, keine Namen)` });
  await writeText(db, NOTE_KEY, value || null);
  await audit(db, viewer.userId, "buecherei.compensation.note", "note", { set: !!value });
}
