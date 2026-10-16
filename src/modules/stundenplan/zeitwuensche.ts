// Zeitwünsche (P2b-21): je Lehrkraft, Gruppe, Raum und Fach −3 … +3 oder gesperrt je Slot.
import { and, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { groups, periods, rooms, subjects, timetableTimePrefs, users } from "@/core/db/schema";
import { TIME_PREF_KINDS, type TimePrefKind, type TimePrefSource } from "@/core/db/schema";
import { ValidationError } from "@/modules/verwaltung/users";
import { planningYear } from "./verteilung";

export const TIME_PREF_LABELS: Record<TimePrefKind, string> = { teacher: "Lehrkraft", group: "Klasse/Kurs", room: "Raum", subject: "Fach" };

/** Ein Slot-Wert: −3 … +3, `null` = gesperrt. */
export type PrefValue = number | null;
export type PrefGrid = Map<string, PrefValue>;

export const prefKey = (weekday: number, periodNr: number) => `${weekday}-${periodNr}`;

/** „+2“, „−1“, „gesperrt“ */
export function prefLabel(v: PrefValue): string {
  if (v === null) return "gesperrt";
  if (v === 0) return "egal";
  return v > 0 ? `+${v}` : `−${-v}`;
}

/** Rein: Formularwert („-3“…„3“, „x“) → Wert; ungültig → undefined. */
export function parsePref(raw: string): PrefValue | undefined {
  if (raw === "x") return null;
  if (raw === "" || raw === "0") return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= -3 && n <= 3 ? n : undefined;
}

export async function prefsOf(db: Db, kind: TimePrefKind, targetId: string): Promise<PrefGrid> {
  return new Map([...(await prefsWithSource(db, kind, targetId))].map(([k, x]) => [k, x.value]));
}

/** Raster mit Herkunft je Slot (GATE-4f C-07): Vorgabe der Planung oder Wunsch der Lehrkraft. */
export async function prefsWithSource(db: Db, kind: TimePrefKind, targetId: string): Promise<Map<string, { value: PrefValue; source: TimePrefSource }>> {
  const year = await planningYear(db);
  if (!year) return new Map();
  const rows = await db
    .select()
    .from(timetableTimePrefs)
    .where(and(eq(timetableTimePrefs.schoolYearId, year.id), eq(timetableTimePrefs.kind, kind), eq(timetableTimePrefs.targetId, targetId)));
  return new Map(rows.map((r) => [prefKey(r.weekday, r.periodNr), { value: r.blocked ? null : r.value, source: r.source }]));
}

/** Alle Zeitwünsche des Planungsjahres (für Setzhilfe und Solver): `${kind}:${id}` → Raster. */
export async function allPrefs(db: Db): Promise<Map<string, PrefGrid>> {
  const year = await planningYear(db);
  if (!year) return new Map();
  const rows = await db.select().from(timetableTimePrefs).where(eq(timetableTimePrefs.schoolYearId, year.id));
  const out = new Map<string, PrefGrid>();
  for (const r of rows) {
    const k = `${r.kind}:${r.targetId}`;
    if (!out.has(k)) out.set(k, new Map());
    out.get(k)!.set(prefKey(r.weekday, r.periodNr), r.blocked ? null : r.value);
  }
  return out;
}

async function targetExists(db: Db, kind: TimePrefKind, id: string): Promise<boolean> {
  if (kind === "teacher") return (await db.select({ role: users.role }).from(users).where(eq(users.id, id)))[0]?.role === "lehrkraft";
  if (kind === "group") return (await db.select({ id: groups.id }).from(groups).where(eq(groups.id, id))).length > 0;
  if (kind === "room") return (await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, id))).length > 0;
  return (await db.select({ id: subjects.id }).from(subjects).where(eq(subjects.id, id))).length > 0;
}

/**
 * Ersetzt das Raster eines Ziels; neutrale Slots (0) werden nicht gespeichert. GATE-4f C-07 – Herkunft je Slot:
 *  · Planung (`source: "planung"`, Vorgabe): ersetzt das ganze Raster. Unveränderte Wünsche der Lehrkraft bleiben deren
 *    Wünsche; was die Planung ändert, wird Vorgabe – auch „egal“ statt eines Wunsches (Zeile mit 0). Setzt die Planung eine
 *    eigene Vorgabe auf „egal“, fällt sie weg.
 *  · Lehrkraft (`source: "lehrkraft"`, Q5-10): ersetzt nur die eigenen Wünsche; Slots mit einer Vorgabe der Planung bleiben
 *    unverändert (ein anderer Wert dort wird ignoriert).
 */
export async function savePrefs(db: Db, actorId: string, kind: string, targetId: string, grid: PrefGrid, source: TimePrefSource = "planung"): Promise<number> {
  if (!(TIME_PREF_KINDS as readonly string[]).includes(kind)) throw new ValidationError({ kind: "Art wählen" });
  const k = kind as TimePrefKind;
  const year = await planningYear(db);
  if (!year) throw new ValidationError({ kind: "Zuerst ein Schuljahr anlegen" });
  if (!(await targetExists(db, k, targetId))) throw new ValidationError({ targetId: `${TIME_PREF_LABELS[k]} wählen` });
  const nrs = new Set((await db.select({ nr: periods.nr }).from(periods)).map((p) => p.nr));
  const slots: [string, number, number, PrefValue][] = [];
  for (const [key, v] of grid) {
    const [wd, p] = key.split("-").map(Number);
    if (!Number.isInteger(wd) || wd! < 0 || wd! > 4 || !nrs.has(p!)) throw new ValidationError({ grid: "Ungültiger Slot" });
    slots.push([prefKey(wd!, p!), wd!, p!, v]);
  }
  const target = and(eq(timetableTimePrefs.schoolYearId, year.id), eq(timetableTimePrefs.kind, k), eq(timetableTimePrefs.targetId, targetId));
  let count = 0;
  await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const prev = new Map(
      (await tx.select().from(timetableTimePrefs).where(target)).map((r) => [prefKey(r.weekday, r.periodNr), { value: r.blocked ? null : r.value, source: r.source }]),
    );
    const rows: (typeof timetableTimePrefs.$inferInsert)[] = [];
    const row = (wd: number, p: number, v: PrefValue, src: TimePrefSource) => ({ schoolYearId: year.id, kind: k, targetId, weekday: wd, periodNr: p, value: v ?? 0, blocked: v === null, source: src });
    if (source === "lehrkraft") {
      const fixed = new Set([...prev].filter(([, x]) => x.source === "planung").map(([key]) => key));
      for (const [key, wd, p, v] of slots) if (v !== 0 && !fixed.has(key)) rows.push(row(wd, p, v, "lehrkraft"));
      await tx.delete(timetableTimePrefs).where(and(target, eq(timetableTimePrefs.source, "lehrkraft")));
    } else {
      for (const [key, wd, p, v] of slots) {
        const old = prev.get(key);
        if (old && old.value === v) rows.push(row(wd, p, v, old.source));
        else if (v !== 0) rows.push(row(wd, p, v, "planung"));
        else if (old?.source === "lehrkraft") rows.push(row(wd, p, 0, "planung"));
      }
      await tx.delete(timetableTimePrefs).where(target);
    }
    if (rows.length) await tx.insert(timetableTimePrefs).values(rows);
    count = rows.filter((r) => r.source === source && (r.value !== 0 || r.blocked)).length;
    await audit(tx, actorId, "stundenplan.timepref.save", targetId, { kind: k, source, slots: count, blocked: rows.filter((r) => r.blocked && r.source === source).length });
  });
  return count;
}

/**
 * Rein: Gründe, warum ein Slot für diese Lehrkraft/Gruppe/Raum/Fach gesperrt ist (für die Setzhilfe),
 * z. B. „BRA: Zeit gesperrt“.
 */
export function blockedReasons(
  prefs: Map<string, PrefGrid>,
  targets: { kind: TimePrefKind; id: string | null; label: string }[],
  weekday: number,
  periodNr: number,
): string[] {
  const key = prefKey(weekday, periodNr);
  return targets.filter((t) => t.id && prefs.get(`${t.kind}:${t.id}`)?.get(key) === null).map((t) => `${t.label}: Zeit gesperrt`);
}
