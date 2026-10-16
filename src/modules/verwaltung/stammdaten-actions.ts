"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import type { FormState } from "./actions";
import {
  addPeriod,
  applyCurriculumTemplate,
  applyGradeTemplate,
  applyTimeGrid,
  deleteSubject,
  listGradeLevels,
  listPeriods,
  listSubjects,
  saveCurriculum,
  moveSubject,
  removeLastPeriod,
  saveGradeLevels,
  savePeriods,
  saveSubjects,
} from "./stammdaten";
import { listClosures } from "@/core/school/calendar";
import { deleteClosure, saveClosures } from "./closures";
import { setHolidayAuto, syncHolidays } from "./ferien-abruf";
import { audit } from "@/core/audit";
import { toBerlinDate } from "@/core/time";
import { addNextSchoolYear, deleteSchoolYear, listSchoolYears, saveSchoolYears } from "./school-years";
import { ValidationError } from "./users";

const PERM = "verwaltung.school";

function values(form: FormData): Record<string, string> {
  return Object.fromEntries([...form.entries()].filter(([k]) => !k.startsWith("$")).map(([k, v]) => [k, String(v)]));
}

export async function saveGradeLevelsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  const db = await getDb();
  const levels = await listGradeLevels(db);
  const rows = levels.map((l) => ({
    level: l.level,
    code: String(form.get(`code-${l.level}`) ?? ""),
    name: String(form.get(`name-${l.level}`) ?? ""),
    stage: String(form.get(`stage-${l.level}`) ?? "") as "sek1" | "oberstufe",
  }));
  try {
    await saveGradeLevels(db, user.id, rows);
  } catch (err) {
    return failed(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

function failed(err: unknown, form: FormData): FormState {
  if (err instanceof ValidationError) return { error: Object.values(err.fieldErrors)[0] ?? "Eingaben prüfen", fieldErrors: err.fieldErrors, values: values(form) };
  throw err;
}

/**
 * Fächer-Tabelle: speichert immer zuerst alle Zeilen (keine Eingabe geht verloren) und führt dann die gewählte
 * Aktion aus – `intent` = save | add | delete:<Kürzel> | up:<Kürzel> | down:<Kürzel>.
 */
export async function saveSubjectsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  const db = await getDb();
  const intent = String(form.get("intent") ?? "save");
  const [verb, target] = intent.split(":") as [string, string | undefined];
  const rows = (await listSubjects(db)).map((s) => ({
    id: s.id,
    code: String(form.get(`code-${s.id}`) ?? s.id),
    name: String(form.get(`name-${s.id}`) ?? s.name),
    color: String(form.get(`color-${s.id}`) ?? s.color),
    roomKind: String(form.get(`roomKind-${s.id}`) ?? s.roomKind ?? ""),
  }));
  const newCode = String(form.get("code-new") ?? "").trim();
  const added =
    verb === "add" || newCode
      ? { code: newCode, name: String(form.get("name-new") ?? ""), color: String(form.get("color-new") ?? ""), roomKind: String(form.get("roomKind-new") ?? "") }
      : undefined;
  try {
    await saveSubjects(db, user.id, rows, added);
    // Ziel nach dem Speichern über das (evtl. umbenannte) Kürzel finden
    const id = rows.find((r) => r.id === target)?.code.trim();
    if (verb === "delete" && id) await deleteSubject(db, user.id, id);
    if ((verb === "up" || verb === "down") && id) await moveSubject(db, user.id, id, verb === "up" ? -1 : 1);
  } catch (err) {
    return failed(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Zeitraster: `intent` = save | add | remove (letzte Stunde); speichert immer zuerst die Zeiten. */
export async function savePeriodsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  const db = await getDb();
  const intent = String(form.get("intent") ?? "save");
  const rows = (await listPeriods(db)).map((p) => ({
    nr: p.nr,
    startsAt: String(form.get(`start-${p.nr}`) ?? p.startsAt),
    endsAt: String(form.get(`end-${p.nr}`) ?? p.endsAt),
  }));
  try {
    await savePeriods(db, user.id, rows);
    if (intent === "add") await addPeriod(db, user.id);
    if (intent === "remove") await removeLastPeriod(db, user.id);
  } catch (err) {
    return failed(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Schuljahre: `intent` = save | add | delete:<id>; speichert immer zuerst alle Zeilen. */
export async function saveSchoolYearsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  const db = await getDb();
  const [verb, target] = String(form.get("intent") ?? "save").split(":") as [string, string | undefined];
  const years = await listSchoolYears(db);
  const rows = years.map((y) => ({
    id: y.id,
    name: String(form.get(`name-${y.id}`) ?? y.name),
    startsOn: String(form.get(`start-${y.id}`) ?? y.startsOn),
    endsOn: String(form.get(`end-${y.id}`) ?? y.endsOn),
    term2StartsOn: String(form.get(`term2-${y.id}`) ?? y.term2StartsOn ?? ""),
  }));
  const current = String(form.get("current") ?? "") || (years.find((y) => y.isCurrent)?.id ?? null);
  try {
    if (rows.length) await saveSchoolYears(db, user.id, rows, current);
    if (verb === "add") await addNextSchoolYear(db, user.id);
    if (verb === "delete" && target) await deleteSchoolYear(db, user.id, target);
  } catch (err) {
    return failed(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Ferien/freie Tage: `intent` = save | add | delete:<id>; speichert immer zuerst alle Zeilen. */
export async function saveClosuresAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  const db = await getDb();
  const [verb, target] = String(form.get("intent") ?? "save").split(":") as [string, string | undefined];
  const rows = (await listClosures(db)).map((c) => ({
    id: c.id,
    kind: String(form.get(`kind-${c.id}`) ?? c.kind),
    name: String(form.get(`name-${c.id}`) ?? c.name),
    startsOn: String(form.get(`start-${c.id}`) ?? c.startsOn),
    endsOn: String(form.get(`end-${c.id}`) ?? c.endsOn),
  }));
  const newName = String(form.get("name-new") ?? "").trim();
  const added =
    verb === "add" || newName
      ? { kind: String(form.get("kind-new") ?? ""), name: newName, startsOn: String(form.get("start-new") ?? ""), endsOn: String(form.get("end-new") ?? "") }
      : undefined;
  try {
    await saveClosures(db, user.id, rows, added);
    if (verb === "delete" && target) await deleteClosure(db, user.id, target);
  } catch (err) {
    return failed(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Ferien jetzt aus der OpenHolidays API abrufen (Ergebnis steht danach auf der Seite). */
export async function syncHolidaysAction(): Promise<void> {
  const { user } = await requirePermission(PERM);
  const db = await getDb();
  const s = await syncHolidays(db, toBerlinDate(new Date()));
  await audit(db, user.id, "verwaltung.stammdaten.ferien_abruf", null, { ok: s.ok, added: s.added, updated: s.updated, removed: s.removed });
  revalidatePath("/", "layout");
}

/** Automatischen nächtlichen Abruf ein- bzw. ausschalten. */
export async function setHolidayAutoAction(form: FormData): Promise<void> {
  const { user } = await requirePermission(PERM);
  const db = await getDb();
  const on = form.get("auto") === "on";
  await setHolidayAuto(db, on);
  await audit(db, user.id, "verwaltung.stammdaten.ferien_auto", null, { on });
  revalidatePath("/verwaltung/stammdaten");
}

/** Stundentafel-Matrix: Felder `h-<Jahrgang>-<Fach>`; Jahrgänge kommen als `grades` (Sek I) mit. */
export async function saveCurriculumAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  const db = await getDb();
  const grades = String(form.get("grades") ?? "").split(",").filter(Boolean).map(Number);
  const subs = await listSubjects(db);
  const cells = grades.flatMap((g) => subs.map((s) => ({ gradeLevel: g, subjectId: s.id, hours: String(form.get(`h-${g}-${s.id}`) ?? "") })));
  try {
    await saveCurriculum(db, user.id, cells);
  } catch (err) {
    return failed(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function applyCurriculumTemplateAction(): Promise<void> {
  const { user } = await requirePermission(PERM);
  await applyCurriculumTemplate(await getDb(), user.id);
  revalidatePath("/", "layout");
}

export async function applyTimeGridAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requirePermission(PERM);
  try {
    await applyTimeGrid(await getDb(), user.id, String(form.get("grid") ?? ""));
  } catch (err) {
    return failed(err, form);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function applyGradeTemplateAction(): Promise<void> {
  const { user } = await requirePermission(PERM);
  await applyGradeTemplate(await getDb(), user.id);
  revalidatePath("/", "layout");
}
