// INV-11: Auswertung Ersatzbedarf/Bestand – Alter des Inventars gegen die Nutzungsdauer der Kategorie (INV-10, Richtwert), je
// Kategorie, Raum und Jahr, mit CSV und Druck. Grundlage fürs Gespräch mit dem Schulträger (inf-4) – keine Abschreibung, kein
// Restwert (inf-3), kein Bestellwesen. Sicht wie die Inventarliste (`listAssets`: verantwortliche Gruppen nur ihre Kategorien);
// Preise und Werte nur mit `gebaeude.configure` oder `view_all` (inf-5). Kein Personenbezug; der Export loggt nur Zahlen.
import { audit } from "@/core/audit";
import { csvBytes, type CsvEncoding } from "@/core/csv";
import type { Db } from "@/core/db/client";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { canConfigure, canSeeInventory } from "./inventar";
import { assetPlace, listAssets, type AssetFilter } from "./pruefungen";


/** Vorausschau in Jahren (Auswahl auf der Seite). */
export const REPLACEMENT_HORIZONS = [3, 5, 10] as const;
export const DEFAULT_HORIZON = 5;

/** Stand eines Eintrags: Ersatz fällig (Nutzungsdauer erreicht), in der Vorausschau, später, ohne Anschaffungsdatum, ohne Richtwert. */
export const REPLACEMENT_STATES = ["faellig", "bald", "spaeter", "ohne_datum", "ohne_richtwert"] as const;
export type ReplacementState = (typeof REPLACEMENT_STATES)[number];
export const REPLACEMENT_STATE_LABELS: Record<ReplacementState, string> = {
  faellig: "Ersatz fällig",
  bald: "in der Vorausschau",
  spaeter: "später",
  ohne_datum: "ohne Anschaffungsdatum",
  ohne_richtwert: "ohne Richtwert",
};

/**
 * Preise/Werte sehen nur `configure` und das Recht `view_all` selbst (inf-5) – `inventory`, `manage` (Hausmeisterei) und
 * verantwortliche Gruppen nur Stückzahlen (bewusst enger als `canViewAll`, das `manage` einschließt).
 */
export const canSeeValues = (p: PermissionSet) => canConfigure(p) || hasPermission(p, "gebaeude.view_all");

export interface ReplacementAsset {
  id: string;
  name: string;
  inventoryNo: string | null;
  categoryId: string;
  categoryName: string;
  categorySort: number;
  categoryLifetimeYears: number | null;
  roomId: string | null;
  building: string | null;
  floor: string | null;
  quantity: number;
  acquiredOn: string | null;
  priceCents: number | null;
}

/** Rein: volle Jahre zwischen Anschaffung und `today` (Geburtstagsregel), null ohne Datum. */
export function ageYears(acquiredOn: string | null, today: string): number | null {
  if (!acquiredOn) return null;
  const years = Number(today.slice(0, 4)) - Number(acquiredOn.slice(0, 4));
  return Math.max(0, today.slice(5) < acquiredOn.slice(5) ? years - 1 : years);
}

/** Rein: Jahr, in dem die Nutzungsdauer erreicht ist (Anschaffungsjahr + Nutzungsdauer), null ohne Datum oder Richtwert. */
export function replacementYear(acquiredOn: string | null, lifetimeYears: number | null): number | null {
  return acquiredOn && lifetimeYears ? Number(acquiredOn.slice(0, 4)) + lifetimeYears : null;
}

/** Rein: Stand im Jahr `year` mit `horizon` Jahren Vorausschau (fällig = Ersatzjahr erreicht oder vorbei). */
export function replacementState(a: { acquiredOn: string | null; categoryLifetimeYears: number | null }, year: number, horizon: number): ReplacementState {
  if (!a.categoryLifetimeYears) return "ohne_richtwert";
  const ry = replacementYear(a.acquiredOn, a.categoryLifetimeYears);
  if (ry === null) return "ohne_datum";
  if (ry <= year) return "faellig";
  return ry <= year + horizon ? "bald" : "spaeter";
}

type Counts = { entries: number; pieces: number; valueCents: number | null };
const zero = (values: boolean): Counts => ({ entries: 0, pieces: 0, valueCents: values ? 0 : null });
function add(c: Counts, a: ReplacementAsset) {
  c.entries++;
  c.pieces += a.quantity;
  if (c.valueCents !== null && a.priceCents !== null) c.valueCents += a.priceCents;
}

export interface ReplacementItem extends ReplacementAsset {
  place: string;
  age: number | null;
  year: number | null;
  state: ReplacementState;
}

export interface ReplacementReport {
  year: number;
  horizon: number;
  /** Preise/Werte enthalten (sonst `valueCents` null und keine Preise an den Einträgen) */
  values: boolean;
  totals: Record<ReplacementState, Counts>;
  /** je Kategorie: Nutzungsdauer, Bestand, fällig, Vorausschau, ohne Datum */
  byCategory: { categoryId: string; name: string; lifetimeYears: number | null; total: Counts; faellig: Counts; bald: Counts; ohneDatum: number }[];
  /** je Jahr der Vorausschau (erstes Jahr = „bis einschließlich“, enthält Überfälliges) */
  byYear: { year: number; overdue: boolean; counts: Counts }[];
  /** je Raum/Standort (nur mit Fälligem oder Vorausschau) */
  byPlace: { place: string; roomId: string | null; faellig: Counts; bald: Counts }[];
  /** fällige Einträge und die der Vorausschau, nach Ersatzjahr */
  items: ReplacementItem[];
}

/** Rein: Auswertung über eine Liste von Einträgen (aktive Inventar-Einträge, schon nach Sicht gefiltert). */
export function buildReplacementReport(assets: readonly ReplacementAsset[], today: string, horizon: number, values: boolean): ReplacementReport {
  const year = Number(today.slice(0, 4));
  const totals = Object.fromEntries(REPLACEMENT_STATES.map((s) => [s, zero(values)])) as Record<ReplacementState, Counts>;
  const cats = new Map<string, ReplacementReport["byCategory"][number] & { sort: number }>();
  const years = new Map<number, Counts>();
  for (let y = year; y <= year + horizon; y++) years.set(y, zero(values));
  const places = new Map<string, ReplacementReport["byPlace"][number]>();
  const items: ReplacementItem[] = [];
  for (const raw of assets) {
    const a = values ? raw : { ...raw, priceCents: null };
    const state = replacementState(a, year, horizon);
    const ry = replacementYear(a.acquiredOn, a.categoryLifetimeYears);
    add(totals[state], a);
    let c = cats.get(a.categoryId);
    if (!c) {
      c = { categoryId: a.categoryId, name: a.categoryName, sort: a.categorySort, lifetimeYears: a.categoryLifetimeYears, total: zero(values), faellig: zero(values), bald: zero(values), ohneDatum: 0 };
      cats.set(a.categoryId, c);
    }
    add(c.total, a);
    if (state === "faellig") add(c.faellig, a);
    if (state === "bald") add(c.bald, a);
    if (state === "ohne_datum") c.ohneDatum += a.quantity;
    if (state !== "faellig" && state !== "bald") continue;
    add(years.get(Math.max(year, ry!))!, a);
    const place = assetPlace(a);
    let p = places.get(place);
    if (!p) {
      p = { place, roomId: a.roomId, faellig: zero(values), bald: zero(values) };
      places.set(place, p);
    }
    add(state === "faellig" ? p.faellig : p.bald, a);
    items.push({ ...a, place, age: ageYears(a.acquiredOn, today), year: ry, state });
  }
  return {
    year,
    horizon,
    values,
    totals,
    byCategory: [...cats.values()]
      .sort((x, y) => x.sort - y.sort || x.name.localeCompare(y.name, "de"))
      .map((c) => ({ categoryId: c.categoryId, name: c.name, lifetimeYears: c.lifetimeYears, total: c.total, faellig: c.faellig, bald: c.bald, ohneDatum: c.ohneDatum })),
    byYear: [...years.entries()].map(([y, counts]) => ({ year: y, overdue: y === year, counts })),
    byPlace: [...places.values()].sort((x, y) => y.faellig.pieces - x.faellig.pieces || y.bald.pieces - x.bald.pieces || x.place.localeCompare(y.place, "de", { numeric: true })),
    items: items.sort((x, y) => x.year! - y.year! || x.categoryName.localeCompare(y.categoryName, "de") || x.name.localeCompare(y.name, "de", { numeric: true })),
  };
}

export type ReplacementFilter = Pick<AssetFilter, "categoryId" | "buildingId" | "roomId">;

/** Rein: Vorausschau aus der Adresse (nur erlaubte Werte, sonst Vorgabe). */
export function parseHorizon(raw: string | null | undefined): number {
  const n = Number(raw);
  return (REPLACEMENT_HORIZONS as readonly number[]).includes(n) ? n : DEFAULT_HORIZON;
}

/** Auswertung für eine Person – Sicht wie die Inventarliste (ohne Leserecht `ForbiddenError` → 404), nur Einträge in Betrieb. */
export async function replacementReport(db: Db, viewer: PermissionSet, filter: ReplacementFilter, today: string, horizon = DEFAULT_HORIZON): Promise<ReplacementReport> {
  if (!(await canSeeInventory(db, viewer))) throw new ForbiddenError("gebaeude.view_all");
  const assets = await listAssets(db, viewer, { categoryId: filter.categoryId, buildingId: filter.buildingId, roomId: filter.roomId });
  return buildReplacementReport(assets, today, horizon, canSeeValues(viewer));
}

const de = (ymd: string | null) => (ymd ? `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}` : "");
const euro = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2).replace(".", ","));

/**
 * CSV der fälligen Einträge und der Vorausschau (eine Zeile je Eintrag, Zellen gegen Formeln entschärft); Preise nur mit
 * `configure`/`view_all`. Audit `gebaeude.replacement.export` nur mit Zahlen.
 */
export async function replacementCsv(db: Db, viewer: PermissionSet, filter: ReplacementFilter, today: string, horizon: number, encoding: CsvEncoding = "utf8"): Promise<Uint8Array> {
  const r = await replacementReport(db, viewer, filter, today, horizon);
  const head = ["Ersatz im Jahr", "Stand", "Inventarnummer", "Bezeichnung", "Kategorie", "Standort", "Menge", "Anschaffungsdatum", "Alter (Jahre)", "Nutzungsdauer (Jahre)", ...(r.values ? ["Preis (EUR)"] : [])];
  const rows = r.items.map((i) => [
    i.year,
    REPLACEMENT_STATE_LABELS[i.state],
    i.inventoryNo,
    i.name,
    i.categoryName,
    i.place,
    i.quantity,
    de(i.acquiredOn),
    i.age,
    i.categoryLifetimeYears,
    ...(r.values ? [euro(i.priceCents)] : []),
  ]);
  await audit(db, viewer.userId, "gebaeude.replacement.export", null, { count: r.items.length, horizon });
  return csvBytes([head, ...rows], encoding);
}
