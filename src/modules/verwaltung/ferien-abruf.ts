// Ferien automatisch je Bundesland (B-20, Entscheidung 2026-10-04): Quelle OpenHolidays API
// (https://www.openholidaysapi.org, Daten unter ODbL-1.0 → Namensnennung auf der Ferienseite).
// Regeln: Handpflege hat Vorrang – von Hand angelegte oder geänderte Einträge fasst der Abruf nie an, überlappende
// Ferien aus der Quelle werden dann übersprungen; von Hand gelöschte importierte Einträge kommen nicht wieder.
import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { appSettings, schoolClosures } from "@/core/db/schema";
import { readSchoolSettings } from "@/core/settings";
import { addDays } from "@/core/time";

export const HOLIDAY_SOURCE = "openholidays";
export const HOLIDAY_SOURCE_LABEL = "OpenHolidays API";
export const HOLIDAY_SOURCE_URL = "https://www.openholidaysapi.org";
export const HOLIDAY_LICENSE = "ODbL-1.0";
const API = "https://openholidaysapi.org/SchoolHolidays";

const AUTO_KEY = "holidays.auto";
const STATUS_KEY = "holidays.lastSync";
const IGNORED_KEY = "holidays.ignored";

export interface FetchedHoliday {
  externalId: string;
  name: string;
  startsOn: string;
  endsOn: string;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Antwort der API → saubere Einträge (unbrauchbare Zeilen fallen weg, Name bevorzugt deutsch). */
export function parseHolidays(data: unknown): FetchedHoliday[] {
  if (!Array.isArray(data)) throw new Error("Unerwartete Antwort der Ferien-Quelle");
  const out: FetchedHoliday[] = [];
  for (const item of data as Record<string, unknown>[]) {
    const id = typeof item.id === "string" ? item.id : "";
    const start = typeof item.startDate === "string" ? item.startDate : "";
    const end = typeof item.endDate === "string" ? item.endDate : "";
    const names = Array.isArray(item.name) ? (item.name as { language?: string; text?: string }[]) : [];
    const name = (names.find((n) => n.language === "DE") ?? names[0])?.text?.trim() ?? "";
    if (!id || !name || !ISO_RE.test(start) || !ISO_RE.test(end) || end < start) continue;
    if ((Date.parse(end) - Date.parse(start)) / 86_400_000 > 70) continue; // wie die Handpflege: kein Block über zehn Wochen
    out.push({ externalId: id, name, startsOn: start, endsOn: end });
  }
  return out;
}

export async function fetchHolidays(state: string, from: string, to: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<FetchedHoliday[]> {
  const base = process.env.SCHULOS_HOLIDAYS_URL ?? API;
  const url = `${base}?countryIsoCode=DE&subdivisionCode=DE-${encodeURIComponent(state)}&languageIsoCode=DE&validFrom=${from}&validTo=${to}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Ferien-Quelle antwortet mit HTTP ${res.status}`);
  return parseHolidays(await res.json());
}

interface Existing {
  id: string;
  kind: string;
  name: string;
  startsOn: string;
  endsOn: string;
  source: string | null;
  externalId: string | null;
}

export interface SyncPlan {
  insert: FetchedHoliday[];
  update: (FetchedHoliday & { id: string })[];
  remove: { id: string; name: string }[];
  /** übersprungen, weil von Hand gepflegte Ferien sich überschneiden bzw. der Eintrag von Hand geändert/gelöscht wurde */
  skipped: { name: string; reason: string }[];
}

const overlaps = (a: { startsOn: string; endsOn: string }, b: { startsOn: string; endsOn: string }) => a.startsOn <= b.endsOn && b.startsOn <= a.endsOn;

/** Reiner Abgleich: was ist einzufügen, zu ändern, zu entfernen (nur Einträge im Abrufzeitraum). */
export function planHolidaySync(existing: readonly Existing[], fetched: readonly FetchedHoliday[], ignored: readonly string[], range: { from: string; to: string }): SyncPlan {
  const plan: SyncPlan = { insert: [], update: [], remove: [], skipped: [] };
  const byExt = new Map(existing.filter((e) => e.externalId).map((e) => [e.externalId!, e]));
  const manualFerien = existing.filter((e) => e.source === null && e.kind === "ferien");
  for (const f of fetched) {
    const e = byExt.get(f.externalId);
    if (e) {
      if (e.source === null) plan.skipped.push({ name: f.name, reason: "von Hand geändert" });
      else if (e.name !== f.name || e.startsOn !== f.startsOn || e.endsOn !== f.endsOn) plan.update.push({ ...f, id: e.id });
      continue;
    }
    if (ignored.includes(f.externalId)) {
      plan.skipped.push({ name: f.name, reason: "von Hand gelöscht" });
      continue;
    }
    const clash = manualFerien.find((m) => overlaps(m, f));
    if (clash) {
      plan.skipped.push({ name: f.name, reason: `überschneidet sich mit „${clash.name}“ (von Hand)` });
      continue;
    }
    plan.insert.push(f);
  }
  const fetchedIds = new Set(fetched.map((f) => f.externalId));
  for (const e of existing) {
    if (e.source === HOLIDAY_SOURCE && e.externalId && !fetchedIds.has(e.externalId) && e.startsOn >= range.from && e.startsOn <= range.to) {
      plan.remove.push({ id: e.id, name: e.name });
    }
  }
  return plan;
}

/** Abrufzeitraum: aktuelles und nächstes Schuljahr (Wechsel am 1. 8.). */
export function syncRange(todayYmd: string): { from: string; to: string } {
  const [y, m] = todayYmd.split("-").map(Number) as [number, number];
  const start = m >= 8 ? y : y - 1;
  return { from: `${start}-08-01`, to: `${start + 2}-07-31` };
}

export interface SyncStatus {
  at: string;
  ok: boolean;
  state: string;
  added: number;
  updated: number;
  removed: number;
  skipped: { name: string; reason: string }[];
  error?: string;
}

async function getSetting<T>(db: Db, key: string): Promise<T | undefined> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return row?.value as T | undefined;
}

async function setSetting(db: Db, key: string, value: unknown) {
  await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
}

export async function holidayAutoEnabled(db: Db): Promise<boolean> {
  return (await getSetting<boolean>(db, AUTO_KEY)) !== false;
}

export async function setHolidayAuto(db: Db, on: boolean): Promise<void> {
  await setSetting(db, AUTO_KEY, on);
}

export async function lastHolidaySync(db: Db): Promise<SyncStatus | null> {
  return (await getSetting<SyncStatus>(db, STATUS_KEY)) ?? null;
}

/** Merkt sich importierte Einträge, die von Hand gelöscht wurden (kommen beim nächsten Abruf nicht wieder). */
export async function rememberDeletedImport(db: Db, externalId: string): Promise<void> {
  const ignored = (await getSetting<string[]>(db, IGNORED_KEY)) ?? [];
  if (!ignored.includes(externalId)) await setSetting(db, IGNORED_KEY, [...ignored, externalId].slice(-200));
}

/** Ruft die Ferien des eingestellten Bundeslandes ab und gleicht sie ab. Fehler (offline) ändern nichts an den Ferien. */
export async function syncHolidays(db: Db, todayYmd: string, fetchImpl?: FetchLike): Promise<SyncStatus> {
  const { profile } = await readSchoolSettings(db);
  const range = syncRange(todayYmd);
  const base: SyncStatus = { at: new Date().toISOString(), ok: false, state: profile.state, added: 0, updated: 0, removed: 0, skipped: [] };
  let status: SyncStatus;
  try {
    const fetched = await fetchHolidays(profile.state, range.from, range.to, fetchImpl);
    const existing = await db
      .select()
      .from(schoolClosures)
      .where(and(lte(schoolClosures.startsOn, addDays(range.to, 70)), gte(schoolClosures.endsOn, addDays(range.from, -70))));
    const plan = planHolidaySync(existing, fetched, (await getSetting<string[]>(db, IGNORED_KEY)) ?? [], range);
    await db.transaction(async (tx) => {
      for (const r of plan.remove) await tx.delete(schoolClosures).where(and(eq(schoolClosures.id, r.id), isNotNull(schoolClosures.source)));
      for (const u of plan.update)
        await tx.update(schoolClosures).set({ name: u.name, startsOn: u.startsOn, endsOn: u.endsOn }).where(and(eq(schoolClosures.id, u.id), isNotNull(schoolClosures.source)));
      if (plan.insert.length)
        await tx
          .insert(schoolClosures)
          .values(plan.insert.map((f) => ({ kind: "ferien" as const, name: f.name, startsOn: f.startsOn, endsOn: f.endsOn, source: HOLIDAY_SOURCE, externalId: f.externalId })));
    });
    status = { ...base, ok: true, added: plan.insert.length, updated: plan.update.length, removed: plan.remove.length, skipped: plan.skipped };
  } catch (err) {
    status = { ...base, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
  await setSetting(db, STATUS_KEY, status);
  return status;
}
