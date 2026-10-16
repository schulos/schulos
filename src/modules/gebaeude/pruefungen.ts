// Gebäude & Technik (P4-15/P4-16/P4-18): Anlagen/Geräte, Prüfarten (Vorlage pruefarten.ts, Q-23), Prüfungen mit
// Fälligkeiten, Fristen-Job „gebaeude-fristen“, Prüfliste/CSV/Statistik. Kein Personenbezug: Prüfungen nennen eine Firma,
// wer erfasst hat, steht nur im Audit-Log; Auswertungen nur je Kategorie/Monat (DATENSCHUTZ §5).
import { scanUpload } from "@/modules/upload-scan";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { MailConfig, MailMessage, Sender } from "@schulos/server/mail";
import { smtpSender } from "@schulos/server/mail";
import { audit } from "@/core/audit";
import { toCsv, detectSeparator, splitCsvLine } from "@/core/csv";
import type { Db } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { gebaeudeAssets, gebaeudeInspectionTypes, gebaeudeInspections, gebaeudeTickets, rooms } from "@/core/db/schema";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasPermission, usersWithPermission, type PermissionSet } from "@/core/permissions";
import { TZ, addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  ASSET_KIND_LABELS,
  ASSET_KINDS,
  CATEGORY_LABELS,
  INSPECTION_RESPONSIBLES,
  INSPECTION_RESULTS,
  INSPECTION_STATE_LABELS,
  INSPECTION_TARGETS,
  MAX_REPORT_MB,
  PRIORITY_LABELS,
  RESULT_LABELS,
  STATUS_LABELS,
  TICKET_CATEGORIES,
  ticketNumber,
  type AssetKind,
  type InspectionResponsible,
  type InspectionResult,
  type InspectionState,
  type InspectionTarget,
  type TicketCategory,
} from "./labels";
import { INSPECTION_TEMPLATE } from "./pruefarten";
import { canManage, canViewAll, createTicket, placeLabel } from "./service";

const MODULE = "gebaeude";
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const canConfigure = (p: PermissionSet) => hasPermission(p, "gebaeude.configure");

function requireViewAll(p: PermissionSet) {
  if (!canViewAll(p)) throw new ForbiddenError("gebaeude.view_all");
}
/** Anlagen lesen: wer alles lesen oder Anlagen einrichten darf (Code-Review Gate 4a N5). */
export const canSeeAssets = (p: PermissionSet) => canViewAll(p) || canConfigure(p);
function requireManage(p: PermissionSet) {
  if (!canManage(p)) throw new ForbiddenError("gebaeude.manage");
}
function requireConfigure(p: PermissionSet) {
  if (!canConfigure(p)) throw new ForbiddenError("gebaeude.configure");
}

// ---------------------------------------------------------------- Fristen (rein)

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Rein: Kalendermonate addieren; fehlt der Tag im Zielmonat, gilt der Monatsletzte
 * (31.01. + 1 Monat = 28./29.02., 29.02.2024 + 12 Monate = 28.02.2025).
 */
export function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const total = y! * 12 + (m! - 1) + months;
  const ty = Math.floor(total / 12);
  const tm = total - ty * 12; // 0-basiert
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${pad(tm + 1)}-${pad(Math.min(d!, last))}`;
}

/** Rein: Stand einer Prüfung am Tag `today` – überfällig (Termin vorbei), bald fällig (in der Vorwarnzeit), geplant, erledigt. */
export function inspectionState(i: { dueOn: string; doneOn: string | null }, warnDays: number, today: string): InspectionState {
  if (i.doneOn) return "erledigt";
  if (i.dueOn < today) return "ueberfaellig";
  if (i.dueOn <= addDays(today, warnDays)) return "faellig";
  return "geplant";
}

/** Erinnerung „bald fällig“ höchstens einmal je Woche, „überfällig“ einmal je Kalendertag. */
export const REMIND_DUE_EVERY_DAYS = 7;

/** Rein: braucht die offene Prüfung jetzt eine Erinnerung? */
export function reminderDue(state: InspectionState, remindedAt: Date | null, now: Date): boolean {
  if (state === "ueberfaellig") return !remindedAt || toBerlinDate(remindedAt) < toBerlinDate(now);
  if (state === "faellig") return !remindedAt || now.getTime() - remindedAt.getTime() >= REMIND_DUE_EVERY_DAYS * 86_400_000 - 60 * 60_000;
  return false;
}

/** Rein: echtes PDF? Prüft die Signatur „%PDF-“ am Dateianfang (Magic Bytes), nicht Endung oder Browser-Typ. */
export function isPdf(bytes: Uint8Array): boolean {
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d];
  return bytes.length > sig.length && sig.every((b, i) => bytes[i] === b);
}

// ---------------------------------------------------------------- Prüfarten

/** Vorlage einspielen (fehlende Einträge, ausgeschaltet). Bestehende – auch angepasste – bleiben unverändert. */
export async function ensureTemplate(db: Db): Promise<void> {
  await db
    .insert(gebaeudeInspectionTypes)
    .values(
      INSPECTION_TEMPLATE.map((t) => ({
        templateKey: t.key,
        name: t.name,
        appliesTo: t.appliesTo,
        assetKind: t.assetKind,
        intervalMonths: t.intervalMonths,
        warnDays: t.warnDays,
        source: t.source,
        responsible: t.responsible,
        note: t.note,
        active: false,
      })),
    )
    .onConflictDoNothing({ target: gebaeudeInspectionTypes.templateKey });
}

export async function listInspectionTypes(db: Db, opts: { activeOnly?: boolean } = {}) {
  await ensureTemplate(db);
  return db
    .select()
    .from(gebaeudeInspectionTypes)
    .where(opts.activeOnly ? eq(gebaeudeInspectionTypes.active, true) : undefined)
    .orderBy(desc(gebaeudeInspectionTypes.active), asc(gebaeudeInspectionTypes.createdAt), asc(gebaeudeInspectionTypes.name));
}

export interface InspectionTypeInput {
  name: string;
  appliesTo: string;
  assetKind: string | null;
  intervalMonths: number;
  warnDays: number;
  source: string;
  responsible: string;
  note: string | null;
  active: boolean;
}

function validateType(input: InspectionTypeInput) {
  const fe: Record<string, string> = {};
  const name = input.name.trim();
  if (name.length < 3 || name.length > 120) fe.name = "Name mit 3 bis 120 Zeichen";
  if (!(INSPECTION_TARGETS as readonly string[]).includes(input.appliesTo)) fe.appliesTo = "Bezug wählen";
  const assetKind = input.appliesTo === "anlage" && input.assetKind ? input.assetKind : null;
  if (assetKind && !(ASSET_KINDS as readonly string[]).includes(assetKind)) fe.assetKind = "Art wählen";
  if (!Number.isInteger(input.intervalMonths) || input.intervalMonths < 1 || input.intervalMonths > 120) fe.intervalMonths = "Intervall 1 bis 120 Monate";
  if (!Number.isInteger(input.warnDays) || input.warnDays < 0 || input.warnDays > 365) fe.warnDays = "Vorwarnzeit 0 bis 365 Tage";
  if (input.source.trim().length > 300) fe.source = "höchstens 300 Zeichen";
  if (!(INSPECTION_RESPONSIBLES as readonly string[]).includes(input.responsible)) fe.responsible = "Zuständigkeit wählen";
  const note = input.note?.trim() || null;
  if (note && note.length > 500) fe.note = "höchstens 500 Zeichen";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return {
    name,
    appliesTo: input.appliesTo as InspectionTarget,
    assetKind: assetKind as AssetKind | null,
    intervalMonths: input.intervalMonths,
    warnDays: input.warnDays,
    source: input.source.trim(),
    responsible: input.responsible as InspectionResponsible,
    note,
    active: input.active,
  };
}

/** Prüfart anpassen bzw. ein-/ausschalten (Recht `gebaeude.configure`). Eingeschaltet → Prüfungen für passende Anlagen planen. */
export async function updateInspectionType(db: Db, viewer: PermissionSet, id: string, input: InspectionTypeInput, today: string): Promise<void> {
  requireConfigure(viewer);
  const row = validateType(input);
  const [old] = await db.select().from(gebaeudeInspectionTypes).where(eq(gebaeudeInspectionTypes.id, id));
  if (!old) throw new ValidationError({ name: "Prüfart gibt es nicht" });
  // Bezug ändert sich nicht, sobald es Prüfungen gibt (sonst passen Ziele nicht mehr)
  if (old.appliesTo !== row.appliesTo) {
    const [any] = await db.select({ id: gebaeudeInspections.id }).from(gebaeudeInspections).where(eq(gebaeudeInspections.typeId, id)).limit(1);
    if (any) throw new ValidationError({ appliesTo: "Es gibt schon Prüfungen dieser Art – Bezug bleibt" });
  }
  await db.update(gebaeudeInspectionTypes).set(row).where(eq(gebaeudeInspectionTypes.id, id));
  await audit(db, viewer.userId, "gebaeude.inspection_type.update", id, { name: row.name, active: row.active, intervalMonths: row.intervalMonths });
  await planDue(db, today);
}

/** Eigene Prüfart anlegen (Recht `gebaeude.configure`), gleich eingeschaltet. */
export async function createInspectionType(db: Db, viewer: PermissionSet, input: InspectionTypeInput, today: string): Promise<string> {
  requireConfigure(viewer);
  const row = validateType(input);
  const [r] = await db.insert(gebaeudeInspectionTypes).values(row).returning({ id: gebaeudeInspectionTypes.id });
  await audit(db, viewer.userId, "gebaeude.inspection_type.create", r!.id, { name: row.name });
  await planDue(db, today);
  return r!.id;
}

// ---------------------------------------------------------------- Anlagen

export interface AssetInput {
  name: string;
  kind: string;
  roomId: string | null;
  building: string | null;
  inventoryNo: string | null;
  manufacturer?: string | null;
  serial?: string | null;
  acquiredOn?: string | null;
  note?: string | null;
}

async function validateAsset(db: Db, input: AssetInput, selfId?: string) {
  const fe: Record<string, string> = {};
  const t = (s: string | null | undefined) => s?.trim() || null;
  const name = input.name.trim();
  const roomId = t(input.roomId);
  const inventoryNo = t(input.inventoryNo);
  const acquiredOn = t(input.acquiredOn);
  if (name.length < 2 || name.length > 120) fe.name = "Bezeichnung mit 2 bis 120 Zeichen";
  if (!(ASSET_KINDS as readonly string[]).includes(input.kind)) fe.kind = "Art wählen";
  for (const [k, v, n] of [
    ["building", t(input.building), 60],
    ["inventoryNo", inventoryNo, 40],
    ["manufacturer", t(input.manufacturer), 80],
    ["serial", t(input.serial), 80],
    ["note", t(input.note), 500],
  ] as const)
    if (v && v.length > n) fe[k] = `höchstens ${n} Zeichen`;
  if (acquiredOn && !YMD.test(acquiredOn)) fe.acquiredOn = "Datum angeben";
  if (roomId) {
    const [r] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId));
    if (!r) fe.roomId = "Raum gibt es nicht";
  }
  if (inventoryNo) {
    const [dup] = await db.select({ id: gebaeudeAssets.id }).from(gebaeudeAssets).where(eq(gebaeudeAssets.inventoryNo, inventoryNo));
    if (dup && dup.id !== selfId) fe.inventoryNo = "Inventarnummer ist schon vergeben";
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return {
    name,
    kind: input.kind as AssetKind,
    roomId,
    building: t(input.building),
    inventoryNo,
    manufacturer: t(input.manufacturer),
    serial: t(input.serial),
    acquiredOn,
    note: t(input.note),
  };
}

export async function createAsset(db: Db, viewer: PermissionSet, input: AssetInput, today: string): Promise<string> {
  requireConfigure(viewer);
  const row = await validateAsset(db, input);
  const [r] = await db.insert(gebaeudeAssets).values(row).returning({ id: gebaeudeAssets.id });
  await audit(db, viewer.userId, "gebaeude.asset.create", r!.id, { name: row.name, kind: row.kind });
  await planDue(db, today);
  return r!.id;
}

/** Anlage außer Betrieb nehmen (offene Prüfungen entfallen) bzw. wieder in Betrieb (Prüfungen werden neu geplant). */
export async function setAssetActive(db: Db, viewer: PermissionSet, id: string, active: boolean, today: string): Promise<void> {
  requireConfigure(viewer);
  const [a] = await db.update(gebaeudeAssets).set({ active }).where(eq(gebaeudeAssets.id, id)).returning({ id: gebaeudeAssets.id });
  if (!a) throw new ValidationError({ asset: "Anlage gibt es nicht" });
  if (!active) await db.delete(gebaeudeInspections).where(and(eq(gebaeudeInspections.assetId, id), isNull(gebaeudeInspections.doneOn)));
  await audit(db, viewer.userId, active ? "gebaeude.asset.activate" : "gebaeude.asset.deactivate", id);
  if (active) await planDue(db, today);
}

const assetBuilding = sql<string | null>`coalesce(${gebaeudeAssets.building}, ${rooms.building})`;

export async function listAssets(db: Db, viewer: PermissionSet, f: { kind?: AssetKind; building?: string; inactive?: boolean } = {}) {
  if (!canSeeAssets(viewer)) throw new ForbiddenError("gebaeude.view_all");
  const rows = await db
    .select({
      id: gebaeudeAssets.id,
      name: gebaeudeAssets.name,
      kind: gebaeudeAssets.kind,
      roomId: gebaeudeAssets.roomId,
      building: assetBuilding,
      inventoryNo: gebaeudeAssets.inventoryNo,
      manufacturer: gebaeudeAssets.manufacturer,
      acquiredOn: gebaeudeAssets.acquiredOn,
      active: gebaeudeAssets.active,
      nextDue: sql<string | null>`(select min(i.due_on)::text from gebaeude_inspections i where i.asset_id = ${gebaeudeAssets.id} and i.done_on is null)`,
    })
    .from(gebaeudeAssets)
    .leftJoin(rooms, eq(rooms.id, gebaeudeAssets.roomId))
    .where(and(f.inactive ? undefined : eq(gebaeudeAssets.active, true), f.kind ? eq(gebaeudeAssets.kind, f.kind) : undefined, f.building ? sql`${assetBuilding} = ${f.building}` : undefined))
    .orderBy(asc(gebaeudeAssets.kind), asc(gebaeudeAssets.name));
  return rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, "de", { numeric: true }));
}

// ---------------------------------------------------------------- CSV-Import (Name;Art;Raum;Inventarnummer[;letzte Prüfung])

export interface AssetCsvRow {
  line: number;
  name: string;
  kind: AssetKind;
  roomId: string | null;
  inventoryNo: string | null;
  lastInspected: string | null;
}

const KIND_ALIASES: Record<string, AssetKind> = {
  elektro: "elektro_ortsveraenderlich",
  elektrogerät: "elektro_ortsveraenderlich",
  "elektrogerät (ortsveränderlich)": "elektro_ortsveraenderlich",
  feuerlöscher: "feuerloescher",
  spielgerät: "spielgeraet",
  sportgerät: "sportgeraet",
  tor: "tor_tuer",
  tür: "tor_tuer",
  leiter: "leiter",
  tritt: "leiter",
  "erste hilfe": "erste_hilfe",
  "erste-hilfe": "erste_hilfe",
  verbandkasten: "erste_hilfe",
};

/** Rein: Art aus Schlüssel, Beschriftung oder Kurzform („Feuerlöscher“, „elektro“). */
export function parseAssetKind(raw: string): AssetKind | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  const direct = ASSET_KINDS.find((k) => k === v || ASSET_KIND_LABELS[k].toLowerCase() === v);
  return direct ?? KIND_ALIASES[v] ?? null;
}

/** Rein: „2025-03-01“ oder „01.03.2025“ → „2025-03-01“; sonst null. */
export function parseDay(raw: string): string | null {
  const v = raw.trim();
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
  const ymd = YMD.test(v) ? v : m ? `${m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}` : null;
  if (!ymd) return null;
  // echtes Datum? (32.13. oder 30.02. fallen durch)
  const [y, mo, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, mo! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo! - 1 && dt.getUTCDate() === d ? ymd : null;
}

const CSV_HEADERS: Record<string, keyof Omit<AssetCsvRow, "line">> = {
  name: "name",
  bezeichnung: "name",
  art: "kind",
  raum: "roomId",
  inventarnummer: "inventoryNo",
  "inventar-nr": "inventoryNo",
  "inventar-nr.": "inventoryNo",
  "letzte prüfung": "lastInspected",
  "letzte pruefung": "lastInspected",
};

export const MAX_ASSET_CSV_BYTES = 512 * 1024;
export const MAX_ASSET_CSV_ROWS = 2000;

/** Rein: Inventarliste des Schulträgers lesen – mit oder ohne Kopfzeile, „;“ oder „,“, UTF-8 mit/ohne BOM. */
export function parseAssetCsv(text: string): { rows: AssetCsvRow[]; errors: { line: number; message: string }[] } {
  const clean = text.replace(/^﻿/, "");
  const sep = detectSeparator(clean);
  let columns: (keyof Omit<AssetCsvRow, "line"> | null)[] = ["name", "kind", "roomId", "inventoryNo", "lastInspected"];
  const rows: AssetCsvRow[] = [];
  const errors: { line: number; message: string }[] = [];
  let first = true;
  clean.split(/\r?\n/).forEach((raw, idx) => {
    const line = idx + 1;
    if (!raw.trim()) return;
    const cells = splitCsvLine(raw, sep);
    if (first) {
      first = false;
      const mapped = cells.map((c) => CSV_HEADERS[c.toLowerCase()] ?? null);
      if (mapped.filter(Boolean).length >= 2) {
        columns = mapped;
        return;
      }
    }
    const rec: Record<string, string> = {};
    columns.forEach((c, i) => {
      if (c) rec[c] = cells[i] ?? "";
    });
    const kind = parseAssetKind(rec.kind ?? "");
    const lastInspected = rec.lastInspected ? parseDay(rec.lastInspected) : null;
    if (!rec.name || rec.name.length < 2) errors.push({ line, message: "Name fehlt" });
    else if (rec.name.length > 120) errors.push({ line, message: "Name zu lang (höchstens 120 Zeichen)" });
    else if (!kind) errors.push({ line, message: `Art „${rec.kind ?? ""}“ unbekannt` });
    else if (rec.lastInspected && !lastInspected) errors.push({ line, message: `Datum „${rec.lastInspected}“ nicht lesbar (TT.MM.JJJJ)` });
    else if ((rec.inventoryNo ?? "").length > 40) errors.push({ line, message: "Inventarnummer zu lang (höchstens 40 Zeichen)" });
    else rows.push({ line, name: rec.name, kind, roomId: rec.roomId?.trim() || null, inventoryNo: rec.inventoryNo?.trim() || null, lastInspected });
  });
  if (rows.length > MAX_ASSET_CSV_ROWS) errors.push({ line: 0, message: `Höchstens ${MAX_ASSET_CSV_ROWS} Zeilen je Import` });
  return { rows, errors };
}

/**
 * Inventarliste importieren (Recht `gebaeude.configure`): alles oder nichts. Gleiche Inventarnummer → Anlage wird
 * aktualisiert. „letzte Prüfung“ wird als übernommener Nachweis (ohne Ergebnis) eingetragen; die nächste Prüfung
 * rechnet SchulOS daraus – ohne Angabe ist sie sofort fällig.
 */
export async function importAssets(db: Db, viewer: PermissionSet, text: string, today: string): Promise<{ created: number; updated: number }> {
  requireConfigure(viewer);
  if (text.length > MAX_ASSET_CSV_BYTES) throw new ValidationError({ file: "Datei zu groß (höchstens 512 KB)" });
  const { rows, errors } = parseAssetCsv(text);
  const known = new Set((await db.select({ id: rooms.id }).from(rooms)).map((r) => r.id));
  for (const r of rows) if (r.roomId && !known.has(r.roomId)) errors.push({ line: r.line, message: `Raum „${r.roomId}“ gibt es nicht` });
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.inventoryNo) continue;
    if (seen.has(r.inventoryNo)) errors.push({ line: r.line, message: `Inventarnummer „${r.inventoryNo}“ doppelt` });
    seen.add(r.inventoryNo);
  }
  if (errors.length) {
    errors.sort((a, b) => a.line - b.line);
    throw new ValidationError({ file: errors.slice(0, 5).map((e) => (e.line ? `Zeile ${e.line}: ${e.message}` : e.message)).join(" · ") + (errors.length > 5 ? ` (und ${errors.length - 5} weitere)` : "") });
  }
  if (!rows.length) throw new ValidationError({ file: "Keine Anlagen in der Datei" });
  const types = await listInspectionTypes(db, { activeOnly: true });
  // alles oder nichts – auch beim Schreiben (Code-Review Gate 4a M1)
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const numbers = rows.map((r) => r.inventoryNo).filter((n): n is string => !!n);
    const byNumber = new Map(
      numbers.length
        ? (await tx.select({ id: gebaeudeAssets.id, inventoryNo: gebaeudeAssets.inventoryNo }).from(gebaeudeAssets).where(inArray(gebaeudeAssets.inventoryNo, numbers))).map((a) => [a.inventoryNo!, a.id])
        : [],
    );
    let created = 0;
    let updated = 0;
    for (const r of rows) {
      let id = r.inventoryNo ? byNumber.get(r.inventoryNo) : undefined;
      if (id) {
        await tx.update(gebaeudeAssets).set({ name: r.name, kind: r.kind, roomId: r.roomId }).where(eq(gebaeudeAssets.id, id));
        updated++;
      } else {
        const [ins] = await tx.insert(gebaeudeAssets).values({ name: r.name, kind: r.kind, roomId: r.roomId, inventoryNo: r.inventoryNo }).returning({ id: gebaeudeAssets.id });
        id = ins!.id;
        created++;
      }
      if (r.lastInspected) for (const t of types.filter((x) => x.assetKind === r.kind)) await takeOverInspection(tx, t, id, r.lastInspected);
    }
    await audit(tx, viewer.userId, "gebaeude.asset.import", null, { created, updated });
    await planDue(tx, today);
    return { created, updated };
  });
}

/**
 * „letzte Prüfung“ aus der Inventarliste übernehmen: Nachweis nur einmal (gleiches Datum → nichts Neues), und eine schon
 * geplante offene Prüfung rückt auf „letzte Prüfung + Intervall“, wenn sie früher lag – sonst bliebe sie nach einem ersten
 * Import ohne Datum dauerhaft überfällig (täglicher Alarm).
 */
async function takeOverInspection(db: Db, t: { id: string; intervalMonths: number }, assetId: string, lastInspected: string) {
  const pair = and(eq(gebaeudeInspections.typeId, t.id), eq(gebaeudeInspections.assetId, assetId));
  const [same] = await db.select({ id: gebaeudeInspections.id }).from(gebaeudeInspections).where(and(pair, eq(gebaeudeInspections.doneOn, lastInspected)));
  if (!same) await db.insert(gebaeudeInspections).values({ typeId: t.id, assetId, dueOn: lastInspected, doneOn: lastInspected, note: "aus Inventarliste übernommen" });
  const [latest] = await db
    .select({ doneOn: gebaeudeInspections.doneOn })
    .from(gebaeudeInspections)
    .where(and(pair, isNotNull(gebaeudeInspections.doneOn)))
    .orderBy(desc(gebaeudeInspections.doneOn))
    .limit(1);
  const due = addMonths(latest?.doneOn ?? lastInspected, t.intervalMonths);
  await db
    .update(gebaeudeInspections)
    .set({ dueOn: due, remindedAt: null })
    .where(and(pair, isNull(gebaeudeInspections.doneOn), lt(gebaeudeInspections.dueOn, due)));
}

// ---------------------------------------------------------------- Planen

/**
 * Für jede eingeschaltete Prüfart mit Anlagen-Art und jede aktive Anlage dieser Art eine offene Prüfung sicherstellen:
 * fällig = letzte Prüfung + Intervall, sonst Anschaffung + Intervall, sonst sofort (heute).
 */
export async function planDue(db: Db, today: string): Promise<number> {
  const types = (await db.select().from(gebaeudeInspectionTypes).where(and(eq(gebaeudeInspectionTypes.active, true), isNotNull(gebaeudeInspectionTypes.assetKind)))).filter(
    (t) => t.appliesTo === "anlage",
  );
  if (!types.length) return 0;
  const assets = await db
    .select({ id: gebaeudeAssets.id, kind: gebaeudeAssets.kind, acquiredOn: gebaeudeAssets.acquiredOn })
    .from(gebaeudeAssets)
    .where(and(eq(gebaeudeAssets.active, true), inArray(gebaeudeAssets.kind, [...new Set(types.map((t) => t.assetKind!))])));
  if (!assets.length) return 0;
  const existing = await db
    .select({ typeId: gebaeudeInspections.typeId, assetId: gebaeudeInspections.assetId, doneOn: gebaeudeInspections.doneOn })
    .from(gebaeudeInspections)
    .where(inArray(gebaeudeInspections.typeId, types.map((t) => t.id)));
  const open = new Set(existing.filter((e) => !e.doneOn).map((e) => `${e.typeId}:${e.assetId}`));
  const lastDone = new Map<string, string>();
  for (const e of existing) {
    if (!e.doneOn) continue;
    const k = `${e.typeId}:${e.assetId}`;
    if (!lastDone.has(k) || lastDone.get(k)! < e.doneOn) lastDone.set(k, e.doneOn);
  }
  const values: (typeof gebaeudeInspections.$inferInsert)[] = [];
  for (const t of types) {
    for (const a of assets.filter((x) => x.kind === t.assetKind)) {
      const k = `${t.id}:${a.id}`;
      if (open.has(k)) continue;
      const base = lastDone.get(k) ?? a.acquiredOn;
      values.push({ typeId: t.id, assetId: a.id, dueOn: base ? addMonths(base, t.intervalMonths) : today });
    }
  }
  if (values.length) await db.insert(gebaeudeInspections).values(values);
  return values.length;
}

export interface PlanInput {
  typeId: string;
  assetId?: string | null;
  roomId?: string | null;
  building?: string | null;
  dueOn: string;
}

/** Prüfung von Hand planen (Recht `gebaeude.manage`) – für Raum- und Gebäudeprüfungen oder einen abweichenden Termin. */
export async function planInspection(db: Db, viewer: PermissionSet, input: PlanInput): Promise<string> {
  requireManage(viewer);
  const fe: Record<string, string> = {};
  const [type] = await db.select().from(gebaeudeInspectionTypes).where(eq(gebaeudeInspectionTypes.id, input.typeId));
  if (!type) fe.typeId = "Prüfart wählen";
  else if (!type.active) fe.typeId = "Prüfart ist ausgeschaltet";
  if (!YMD.test(input.dueOn)) fe.dueOn = "Fälligkeit angeben";
  const assetId = input.assetId?.trim() || null;
  const roomId = input.roomId?.trim() || null;
  const building = input.building?.trim() || null;
  const target = { assetId: null as string | null, roomId: null as string | null, building: null as string | null };
  if (type?.appliesTo === "anlage") {
    if (!assetId) fe.assetId = "Anlage wählen";
    else {
      const [a] = await db.select({ kind: gebaeudeAssets.kind, active: gebaeudeAssets.active }).from(gebaeudeAssets).where(eq(gebaeudeAssets.id, assetId));
      if (!a || !a.active) fe.assetId = "Anlage gibt es nicht (oder außer Betrieb)";
      else if (type.assetKind && a.kind !== type.assetKind) fe.assetId = `Prüfart gilt für ${ASSET_KIND_LABELS[type.assetKind]}`;
    }
    target.assetId = assetId;
  } else if (type?.appliesTo === "raum") {
    if (!roomId) fe.roomId = "Raum wählen";
    else {
      const [r] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId));
      if (!r) fe.roomId = "Raum gibt es nicht";
    }
    target.roomId = roomId;
  } else if (type) {
    if (!building) fe.building = "Gebäude angeben";
    else if (building.length > 60) fe.building = "höchstens 60 Zeichen";
    target.building = building;
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const sameTarget = and(
    eq(gebaeudeInspections.typeId, input.typeId),
    isNull(gebaeudeInspections.doneOn),
    target.assetId ? eq(gebaeudeInspections.assetId, target.assetId) : isNull(gebaeudeInspections.assetId),
    target.roomId ? eq(gebaeudeInspections.roomId, target.roomId) : isNull(gebaeudeInspections.roomId),
    target.building ? eq(gebaeudeInspections.building, target.building) : isNull(gebaeudeInspections.building),
  );
  const [dup] = await db.select({ id: gebaeudeInspections.id }).from(gebaeudeInspections).where(sameTarget);
  if (dup) throw new ValidationError({ dueOn: "Diese Prüfung ist schon geplant" });
  const [r] = await db
    .insert(gebaeudeInspections)
    .values({ typeId: input.typeId, ...target, dueOn: input.dueOn })
    .returning({ id: gebaeudeInspections.id });
  return r!.id;
}

/** Offene Prüfung streichen (Recht `gebaeude.manage`), z. B. falsch geplant. Erledigte bleiben als Nachweis. */
export async function cancelInspection(db: Db, viewer: PermissionSet, id: string): Promise<void> {
  requireManage(viewer);
  const [r] = await db
    .delete(gebaeudeInspections)
    .where(and(eq(gebaeudeInspections.id, id), isNull(gebaeudeInspections.doneOn)))
    .returning({ id: gebaeudeInspections.id });
  if (!r) throw new ValidationError({ inspection: "Nur offene Prüfungen lassen sich streichen" });
  await audit(db, viewer.userId, "gebaeude.inspection.cancel", id);
}

// ---------------------------------------------------------------- Lesen

const roomOfInspection = sql`coalesce(${gebaeudeAssets.roomId}, ${gebaeudeInspections.roomId})`;
const buildingOfInspection = sql<string | null>`coalesce(${gebaeudeInspections.building}, ${gebaeudeAssets.building}, ${rooms.building})`;

/** offene Prüfungen ausgeschalteter Prüfarten bzw. außer Betrieb genommener Anlagen ruhen */
const RESTING_EXCLUDED = sql`(${gebaeudeInspectionTypes.active} and coalesce(${gebaeudeAssets.active}, true))`;

const inspectionColumns = {
  id: gebaeudeInspections.id,
  typeId: gebaeudeInspections.typeId,
  typeName: gebaeudeInspectionTypes.name,
  appliesTo: gebaeudeInspectionTypes.appliesTo,
  warnDays: gebaeudeInspectionTypes.warnDays,
  intervalMonths: gebaeudeInspectionTypes.intervalMonths,
  responsible: gebaeudeInspectionTypes.responsible,
  assetId: gebaeudeInspections.assetId,
  assetName: gebaeudeAssets.name,
  assetKind: gebaeudeAssets.kind,
  inventoryNo: gebaeudeAssets.inventoryNo,
  roomId: sql<string | null>`${roomOfInspection}`,
  building: buildingOfInspection,
  dueOn: gebaeudeInspections.dueOn,
  doneOn: gebaeudeInspections.doneOn,
  result: gebaeudeInspections.result,
  company: gebaeudeInspections.company,
  hasReport: sql<boolean>`${gebaeudeInspections.reportKey} is not null`,
  note: gebaeudeInspections.note,
  ticketId: gebaeudeInspections.ticketId,
  remindedAt: gebaeudeInspections.remindedAt,
};

function inspectionQuery(db: Db) {
  return db
    .select(inspectionColumns)
    .from(gebaeudeInspections)
    .innerJoin(gebaeudeInspectionTypes, eq(gebaeudeInspectionTypes.id, gebaeudeInspections.typeId))
    .leftJoin(gebaeudeAssets, eq(gebaeudeAssets.id, gebaeudeInspections.assetId))
    .leftJoin(rooms, sql`${rooms.id} = ${roomOfInspection}`);
}

/** Rein: Gegenstand einer Prüfung – Anlage (mit Inventarnummer), Raum oder Gebäude. */
export function targetLabel(i: { assetName: string | null; inventoryNo: string | null; roomId: string | null; building: string | null; appliesTo: InspectionTarget }): string {
  if (i.assetName) return i.inventoryNo ? `${i.assetName} (${i.inventoryNo})` : i.assetName;
  if (i.appliesTo === "raum" && i.roomId) return `Raum ${i.roomId}`;
  return i.building ?? "ganze Schule";
}

export type InspectionRow = Awaited<ReturnType<typeof listInspections>>[number];

export interface InspectionFilter {
  /** offen (Vorgabe), überfällig, bald fällig, erledigt oder alle */
  state?: "offen" | "ueberfaellig" | "faellig" | "erledigt" | "alle";
  typeId?: string;
  building?: string;
  limit?: number;
}

/** Prüfungen mit Stand (Recht `gebaeude.manage` oder `gebaeude.view_all`). Offene nach Fälligkeit, erledigte neueste zuerst. */
export async function listInspections(db: Db, viewer: PermissionSet, f: InspectionFilter, today: string) {
  requireViewAll(viewer);
  const state = f.state ?? "offen";
  const parts: (SQL | undefined)[] = [
    state === "erledigt" ? isNotNull(gebaeudeInspections.doneOn) : state === "alle" ? undefined : isNull(gebaeudeInspections.doneOn),
    // offene Prüfungen ausgeschalteter Prüfarten bzw. außer Betrieb genommener Anlagen ruhen
    state === "erledigt" ? undefined : sql`(${gebaeudeInspections.doneOn} is not null or ${RESTING_EXCLUDED})`,
    f.typeId ? eq(gebaeudeInspections.typeId, f.typeId) : undefined,
    f.building ? sql`${buildingOfInspection} = ${f.building}` : undefined,
  ];
  // Stand als SQL-Bedingung vor dem Limit (sonst fehlen bei großen Beständen Einträge, Code-Review Gate 4a N9)
  if (state === "ueberfaellig") parts.push(OVERDUE(today));
  if (state === "faellig") parts.push(DUE_SOON(today));
  const rows = await inspectionQuery(db)
    .where(and(...parts))
    .orderBy(state === "erledigt" ? desc(gebaeudeInspections.doneOn) : asc(gebaeudeInspections.dueOn), asc(gebaeudeInspectionTypes.name))
    .limit(f.limit ?? 1000);
  return rows.map((r) => ({ ...r, state: inspectionState(r, r.warnDays, today), target: targetLabel(r) }));
}

/** überfällig: Termin vor heute */
const OVERDUE = (today: string) => lt(gebaeudeInspections.dueOn, today);
/** bald fällig: ab heute bis heute + Vorwarnzeit der Prüfart (wie inspectionState) */
const DUE_SOON = (today: string) => and(gte(gebaeudeInspections.dueOn, today), sql`${gebaeudeInspections.dueOn} <= ${today}::date + ${gebaeudeInspectionTypes.warnDays}`);

/** Überblick für Widget und Kopf der Prüfungsseite – per SQL gezählt, ohne Obergrenze. */
export async function inspectionSummary(db: Db, viewer: PermissionSet, today: string) {
  requireViewAll(viewer);
  const [r] = await db
    .select({
      open: count(),
      overdue: sql<number>`count(*) filter (where ${OVERDUE(today)})`.mapWith(Number),
      due: sql<number>`count(*) filter (where ${DUE_SOON(today)})`.mapWith(Number),
    })
    .from(gebaeudeInspections)
    .innerJoin(gebaeudeInspectionTypes, eq(gebaeudeInspectionTypes.id, gebaeudeInspections.typeId))
    .leftJoin(gebaeudeAssets, eq(gebaeudeAssets.id, gebaeudeInspections.assetId))
    .where(and(isNull(gebaeudeInspections.doneOn), RESTING_EXCLUDED));
  return { overdue: r?.overdue ?? 0, due: r?.due ?? 0, open: r?.open ?? 0 };
}

/** Gebäude aus Räumen, Anlagen und Prüfungen (Filter). */
export async function inspectionBuildings(db: Db): Promise<string[]> {
  const res = await db.execute(
    sql`select building as b from rooms where building is not null union select building from gebaeude_assets where building is not null union select building from gebaeude_inspections where building is not null`,
  );
  return rowsOf<{ b: string }>(res)
    .map((r) => r.b)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "de"));
}

// ---------------------------------------------------------------- Erfassen

export interface RecordInput {
  doneOn: string;
  result: string;
  company: string | null;
  note: string | null;
  /** Protokoll als PDF (leer = keins) */
  report?: Uint8Array | null;
}

/** Rein: welche Meldung entsteht bei einem Mangel? Kategorie nach Art der Anlage, Priorität nach Ergebnis. */
export function defectTicket(i: { typeName: string; target: string; assetKind: AssetKind | null }, result: InspectionResult): { category: TicketCategory; priority: "normal" | "hoch"; title: string } {
  const category: TicketCategory =
    i.assetKind === "elektro_ortsveraenderlich" || i.assetKind === "aufzug" || i.assetKind === "lueftung" || i.assetKind === "tor_tuer"
      ? "technik"
      : i.assetKind === "feuerloescher" || i.assetKind === "erste_hilfe"
        ? "sicherheit"
        : "gebaeude";
  const what = result === "ausser_betrieb" ? "außer Betrieb" : "Mangel";
  return { category, priority: result === "ausser_betrieb" ? "hoch" : "normal", title: `Prüfung ${i.typeName}: ${what} – ${i.target}`.slice(0, 120) };
}

/**
 * Prüfung erfassen (Recht `gebaeude.manage`): Datum, Ergebnis, Firma, optional Protokoll-PDF. Bei Mangel bzw. „außer
 * Betrieb“ entsteht eine Meldung; danach plant SchulOS die nächste Prüfung (Prüfdatum + Intervall).
 */
export async function recordInspection(
  db: Db,
  storage: FileStorage,
  viewer: PermissionSet,
  id: string,
  input: RecordInput,
  opts: { today: string; now?: Date },
): Promise<{ ticketId: string | null; nextId: string | null }> {
  requireManage(viewer);
  const [row] = await inspectionQuery(db).where(eq(gebaeudeInspections.id, id));
  if (!row) throw new ValidationError({ inspection: "Prüfung gibt es nicht" });
  if (row.doneOn) throw new ValidationError({ inspection: "Prüfung ist schon erfasst" });
  const fe: Record<string, string> = {};
  const company = input.company?.trim() || null;
  const note = input.note?.trim() || null;
  if (!YMD.test(input.doneOn)) fe.doneOn = "Prüfdatum angeben";
  else if (input.doneOn > opts.today) fe.doneOn = "Prüfdatum liegt in der Zukunft";
  if (!(INSPECTION_RESULTS as readonly string[]).includes(input.result)) fe.result = "Ergebnis wählen";
  if (company && company.length > 120) fe.company = "höchstens 120 Zeichen";
  if (note && note.length > 2000) fe.note = "höchstens 2000 Zeichen";
  const report = input.report && input.report.length > 0 ? input.report : null;
  if (report && report.length > MAX_REPORT_MB * 1024 * 1024) fe.report = `Protokoll zu groß (höchstens ${MAX_REPORT_MB} MB)`;
  else if (report && !isPdf(report)) fe.report = "Protokoll nur als PDF";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const result = input.result as InspectionResult;

  let reportKey: string | null = null;
  if (report) {
    await scanUpload(report, "Prüfprotokoll", "report"); // P4-72
    reportKey = newStorageKey();
    await storage.put(reportKey, report);
  }
  // Erfassen atomar: nur wer die offene Prüfung als Erste:r abschließt, legt Meldung und Folgeprüfung an (Code-Review
  // Gate 4a N2) – ein doppeltes Absenden scheitert hier, ein ungenutztes Protokoll räumt der Aufräumlauf weg.
  const [claimed] = await db
    .update(gebaeudeInspections)
    .set({ doneOn: input.doneOn, result, company, note, reportKey, reportSize: report?.length ?? null })
    .where(and(eq(gebaeudeInspections.id, id), isNull(gebaeudeInspections.doneOn)))
    .returning({ assetId: gebaeudeInspections.assetId, roomId: gebaeudeInspections.roomId, building: gebaeudeInspections.building });
  if (!claimed) throw new ValidationError({ inspection: "Prüfung ist schon erfasst" });

  let ticketId: string | null = null;
  if (result !== "ok") {
    const t = defectTicket({ typeName: row.typeName, target: targetLabel(row), assetKind: row.assetKind }, result);
    const created = await createTicket(
      db,
      storage,
      viewer,
      {
        ...t,
        roomId: row.roomId,
        location: row.roomId ? null : (row.building ?? targetLabel(row)).slice(0, 120),
        description: [`Bei der Prüfung am ${input.doneOn} festgestellt${company ? ` (${company})` : ""}.`, note].filter(Boolean).join("\n\n"),
        photos: [],
      },
      { now: opts.now, rateLimit: false },
    );
    ticketId = created.id;
    await db.update(gebaeudeInspections).set({ ticketId }).where(eq(gebaeudeInspections.id, id));
  }
  await audit(db, viewer.userId, "gebaeude.inspection.record", id, { type: row.typeName, result, report: Boolean(report) });

  // nächste Prüfung: gleiche Art, gleicher Gegenstand – solange Art eingeschaltet und Anlage in Betrieb
  const [type] = await db.select().from(gebaeudeInspectionTypes).where(eq(gebaeudeInspectionTypes.id, row.typeId));
  const [asset] = claimed.assetId ? await db.select({ active: gebaeudeAssets.active }).from(gebaeudeAssets).where(eq(gebaeudeAssets.id, claimed.assetId)) : [{ active: true }];
  let nextId: string | null = null;
  if (type?.active && asset?.active) {
    const [next] = await db
      .insert(gebaeudeInspections)
      .values({ typeId: row.typeId, ...claimed, dueOn: addMonths(input.doneOn, type.intervalMonths) })
      .returning({ id: gebaeudeInspections.id });
    nextId = next!.id;
  }
  return { ticketId, nextId };
}

/** Protokoll-PDF für die Auslieferung – nur mit `gebaeude.manage`/`gebaeude.view_all`. */
export async function reportFor(db: Db, viewer: PermissionSet, id: string) {
  if (!canViewAll(viewer)) return null;
  const [r] = await db
    .select({ key: gebaeudeInspections.reportKey, size: gebaeudeInspections.reportSize, doneOn: gebaeudeInspections.doneOn })
    .from(gebaeudeInspections)
    .where(eq(gebaeudeInspections.id, id));
  return r?.key ? { key: r.key, size: r.size, doneOn: r.doneOn } : null;
}

// ---------------------------------------------------------------- Fristen-Job „gebaeude-fristen“

export interface ReminderMail {
  config: MailConfig | null;
  sender?: Sender;
  server?: string;
}

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
export const formatDay = (ymd: string) => dayFmt.format(fromBerlinLocal(ymd));

/** Rein: Alarm-Mail zu überfälligen Prüfungen – nur Prüfart, Gegenstand, Ort und Termin, keine Personen. */
export function overdueMessage(server: string, to: string[], items: { typeName: string; target: string; building: string | null; dueOn: string }[]): MailMessage {
  const lines = items.slice(0, 50).map((i) => `- ${i.typeName}: ${i.target}${i.building ? ` (${i.building})` : ""}, fällig seit ${formatDay(i.dueOn)}`);
  return {
    to,
    subject: `[${server}] ${items.length === 1 ? "1 Prüfung überfällig" : `${items.length} Prüfungen überfällig`}`,
    text: [
      `In ${server} sind wiederkehrende Prüfungen überfällig:`,
      "",
      ...lines,
      ...(items.length > 50 ? [`… und ${items.length - 50} weitere`] : []),
      "",
      "Details und Erfassen in SchulOS unter Gebäude & Technik → Prüfungen.",
    ].join("\n"),
  };
}

/**
 * Nächtlicher Lauf: „bald fällig“ (in der Vorwarnzeit der Prüfart) → Gong an alle mit `gebaeude.manage`, je Prüfung
 * höchstens einmal je Woche; „überfällig“ → täglich Gong und Alarm-Mail (nur mit SMTP). Ein Gong fasst alles zusammen.
 */
export async function runInspectionReminders(db: Db, opts: { now?: Date; mail?: ReminderMail } = {}) {
  const now = opts.now ?? new Date();
  const today = toBerlinDate(now);
  // erst planen: gestrichene oder fehlende Prüfungen von Anlagen kommen so spätestens nachts zurück (Code-Review Gate 4a N3)
  await planDue(db, today);
  const rows = await inspectionQuery(db).where(
    and(isNull(gebaeudeInspections.doneOn), eq(gebaeudeInspectionTypes.active, true), sql`coalesce(${gebaeudeAssets.active}, true)`),
  );
  const items = rows.map((r) => ({ ...r, state: inspectionState(r, r.warnDays, today), target: targetLabel(r) })).filter((r) => reminderDue(r.state, r.remindedAt, now));
  const overdue = items.filter((i) => i.state === "ueberfaellig");
  const due = items.filter((i) => i.state === "faellig");
  if (!items.length) return { overdue: 0, due: 0, notified: 0, mailed: false, mailError: null as string | null };
  const recipients = await usersWithPermission(db, "gebaeude.manage");
  const parts = [overdue.length ? `${overdue.length} überfällig` : null, due.length ? `${due.length} bald fällig` : null].filter(Boolean).join(", ");
  const sample = [...overdue, ...due]
    .slice(0, 3)
    .map((i) => `${i.typeName}: ${i.target} (${formatDay(i.dueOn)})`)
    .join(" · ");
  const notified = await notify(db, recipients, { moduleId: MODULE, title: `Prüfungen: ${parts}`, body: sample, href: overdue.length ? "/gebaeude/pruefungen?stand=ueberfaellig" : "/gebaeude/pruefungen?stand=faellig" });
  await db.update(gebaeudeInspections).set({ remindedAt: now }).where(inArray(gebaeudeInspections.id, items.map((i) => i.id)));
  let mailed = false;
  let mailError: string | null = null;
  if (overdue.length && opts.mail?.config) {
    const cfg = opts.mail.config;
    try {
      await (opts.mail.sender ?? smtpSender(cfg))(overdueMessage(opts.mail.server ?? "SchulOS", cfg.to, overdue));
      mailed = true;
    } catch (err) {
      // Gong ist raus; der Fehler wird gemeldet (Job rot bzw. Hinweis beim manuellen Lauf) statt die Erinnerung abzubrechen
      mailError = err instanceof Error ? err.message : String(err);
      console.error("[gebaeude] Alarm-Mail zu überfälligen Prüfungen fehlgeschlagen:", err);
    }
  }
  return { overdue: overdue.length, due: due.length, notified, mailed, mailError };
}

// ---------------------------------------------------------------- Prüfliste, CSV, Statistik (P4-18)

export interface ChecklistRow {
  key: string;
  typeId: string;
  typeName: string;
  source: string;
  responsible: InspectionResponsible;
  intervalMonths: number;
  target: string;
  roomId: string | null;
  building: string | null;
  last: { doneOn: string; result: InspectionResult | null; company: string | null; ticketId: string | null } | null;
  next: { dueOn: string; state: InspectionState } | null;
}

/** Prüfliste je Gegenstand: letzte Prüfung (Datum, Ergebnis, Firma) und nächste Fälligkeit – Nachweis für den Schulträger. */
export async function checklist(db: Db, viewer: PermissionSet, f: { building?: string; typeId?: string }, today: string): Promise<ChecklistRow[]> {
  requireViewAll(viewer);
  const rows = await inspectionQuery(db)
    .where(and(f.typeId ? eq(gebaeudeInspections.typeId, f.typeId) : undefined, f.building ? sql`${buildingOfInspection} = ${f.building}` : undefined))
    .orderBy(asc(gebaeudeInspectionTypes.name), desc(gebaeudeInspections.dueOn));
  const types = new Map((await db.select({ id: gebaeudeInspectionTypes.id, source: gebaeudeInspectionTypes.source, active: gebaeudeInspectionTypes.active }).from(gebaeudeInspectionTypes)).map((t) => [t.id, t]));
  const map = new Map<string, ChecklistRow>();
  for (const r of rows) {
    const key = `${r.typeId}|${r.assetId ?? ""}|${r.assetId ? "" : (r.roomId ?? "")}|${r.assetId ? "" : (r.building ?? "")}`;
    const target = targetLabel(r);
    const entry =
      map.get(key) ??
      ({
        key,
        typeId: r.typeId,
        typeName: r.typeName,
        source: types.get(r.typeId)?.source ?? "",
        responsible: r.responsible,
        intervalMonths: r.intervalMonths,
        target,
        roomId: r.roomId,
        building: r.building,
        last: null,
        next: null,
      } satisfies ChecklistRow);
    if (r.doneOn) {
      if (!entry.last || entry.last.doneOn < r.doneOn) entry.last = { doneOn: r.doneOn, result: r.result, company: r.company, ticketId: r.ticketId };
    } else if (types.get(r.typeId)?.active !== false && (!entry.next || r.dueOn < entry.next.dueOn)) {
      entry.next = { dueOn: r.dueOn, state: inspectionState(r, r.warnDays, today) };
    }
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => a.typeName.localeCompare(b.typeName, "de") || a.target.localeCompare(b.target, "de", { numeric: true }));
}

/** CSV der Prüfungen – ohne Personennamen und ohne Freitext (Bemerkungen können Namen enthalten). */
export async function inspectionsCsv(db: Db, viewer: PermissionSet, today: string): Promise<string> {
  const rows = await listInspections(db, viewer, { state: "alle", limit: 50_000 }, today);
  rows.sort((a, b) => a.typeName.localeCompare(b.typeName, "de") || a.target.localeCompare(b.target, "de") || a.dueOn.localeCompare(b.dueOn));
  const tickets = new Map(
    (await db.select({ id: gebaeudeTickets.id, year: gebaeudeTickets.year, seq: gebaeudeTickets.seq }).from(gebaeudeTickets)).map((t) => [t.id, ticketNumber(t.year, t.seq)]),
  );
  return toCsv([
    ["Prüfart", "Gegenstand", "Inventarnummer", "Raum", "Gebäude", "fällig am", "geprüft am", "Ergebnis", "Firma", "Stand", "Meldung"],
    ...rows.map((r) => [
      r.typeName,
      r.assetName ?? r.target,
      r.inventoryNo,
      r.roomId,
      r.building,
      r.dueOn,
      r.doneOn,
      r.result ? RESULT_LABELS[r.result] : r.doneOn ? "übernommen" : "",
      r.company,
      INSPECTION_STATE_LABELS[r.state],
      r.ticketId ? (tickets.get(r.ticketId) ?? "") : "",
    ]),
  ]);
}

/** CSV der Meldungen – ohne Personennamen und ohne Beschreibung (Freitext). */
export async function ticketsCsv(db: Db, viewer: PermissionSet): Promise<string> {
  requireViewAll(viewer);
  const rows = await db
    .select({
      year: gebaeudeTickets.year,
      seq: gebaeudeTickets.seq,
      category: gebaeudeTickets.category,
      priority: gebaeudeTickets.priority,
      status: gebaeudeTickets.status,
      roomId: gebaeudeTickets.roomId,
      building: rooms.building,
      location: gebaeudeTickets.location,
      title: gebaeudeTickets.title,
      createdAt: gebaeudeTickets.createdAt,
      closedAt: gebaeudeTickets.closedAt,
    })
    .from(gebaeudeTickets)
    .leftJoin(rooms, eq(rooms.id, gebaeudeTickets.roomId))
    .orderBy(asc(gebaeudeTickets.year), asc(gebaeudeTickets.seq));
  return toCsv([
    ["Nummer", "Kategorie", "Priorität", "Status", "Ort", "Gebäude", "Titel", "gemeldet am", "abgeschlossen am"],
    ...rows.map((r) => [
      ticketNumber(r.year, r.seq),
      CATEGORY_LABELS[r.category],
      PRIORITY_LABELS[r.priority],
      STATUS_LABELS[r.status],
      placeLabel(r),
      r.building,
      r.title,
      toBerlinDate(r.createdAt),
      r.closedAt ? toBerlinDate(r.closedAt) : "",
    ]),
  ]);
}

/** Rein: die letzten `n` Monate bis einschließlich des Monats von `today` („2026-10“, absteigend). */
export function lastMonths(today: string, n: number): string[] {
  const first = `${today.slice(0, 7)}-01`;
  return Array.from({ length: n }, (_, i) => addMonths(first, -i).slice(0, 7));
}

/** Meldungen je Monat und Kategorie (nach Meldedatum) plus Durchschnitt bis zum Abschluss – ohne Personenbezug. */
export async function ticketStats(db: Db, viewer: PermissionSet, now: Date, months = 12) {
  requireViewAll(viewer);
  const today = toBerlinDate(now);
  const list = lastMonths(today, months);
  const since = fromBerlinLocal(`${list[list.length - 1]}-01`);
  const rows = await db
    .select({ category: gebaeudeTickets.category, createdAt: gebaeudeTickets.createdAt, closedAt: gebaeudeTickets.closedAt })
    .from(gebaeudeTickets)
    .where(gte(gebaeudeTickets.createdAt, since));
  const byMonth = new Map(list.map((m) => [m, Object.fromEntries(TICKET_CATEGORIES.map((c) => [c, 0])) as Record<TicketCategory, number>]));
  const byCategory = Object.fromEntries(TICKET_CATEGORIES.map((c) => [c, { count: 0, closed: 0, days: 0 }])) as Record<TicketCategory, { count: number; closed: number; days: number }>;
  for (const r of rows) {
    const m = byMonth.get(toBerlinDate(r.createdAt).slice(0, 7));
    if (!m) continue;
    m[r.category]++;
    const c = byCategory[r.category];
    c.count++;
    if (r.closedAt) {
      c.closed++;
      c.days += (r.closedAt.getTime() - r.createdAt.getTime()) / 86_400_000;
    }
  }
  return {
    months: list.map((m) => ({ month: m, counts: byMonth.get(m)! })),
    categories: TICKET_CATEGORIES.map((c) => ({ category: c, count: byCategory[c].count, avgDays: byCategory[c].closed ? Math.round((byCategory[c].days / byCategory[c].closed) * 10) / 10 : null })),
    total: rows.length,
  };
}

/** Aktive Räume als Auswahl („Raum 112 · Hauptgebäude“). */
export async function roomOptions(db: Db): Promise<{ value: string; label: string }[]> {
  const list = await db.select({ id: rooms.id, name: rooms.name, building: rooms.building }).from(rooms).where(eq(rooms.active, true));
  return list
    .sort((a, b) => a.id.localeCompare(b.id, "de", { numeric: true }))
    .map((r) => ({ value: r.id, label: [r.id === r.name || r.name === `Raum ${r.id}` ? `Raum ${r.id}` : `${r.id} – ${r.name}`, r.building].filter(Boolean).join(" · ") }));
}
