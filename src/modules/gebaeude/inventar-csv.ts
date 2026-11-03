// INV-06: Inventarliste im Schulträgerformat – Export (CSV) und Import mit Spaltenzuordnung, Vorschau (Trockenlauf, nichts wird
// gespeichert) und Übernahme ganz oder gar nicht. Löst den CSV-Import aus INV-01 ab; dessen Kopfzeilen und die alte Spaltenfolge
// ohne Kopfzeile (Name;Kategorie;Raum;Inventarnummer;letzte Prüfung;Menge;Hersteller;Modell;Seriennummer) gelten weiter.
// Format und Regeln: docs/INVENTAR.md „Umgesetzt (INV-06)“. Kein Personenbezug; Freitext (Notiz, Ausmusterungsgrund) geht nicht
// mit, weil er Namen enthalten kann (wie bei den anderen Gebäude-Exporten). Zellen gegen Formeln entschärft (`toCsv`).
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import { csvBytes, detectSeparator, splitCsvLine, type CsvEncoding } from "@/core/csv";
import type { Db } from "@/core/db/client";
import { buildingFloors, buildings, gebaeudeAssetCategories, gebaeudeAssets, gebaeudeInspections, rooms } from "@/core/db/schema";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { canSeeInventory, ensureCategories, inventoryNoFormat, maintainableCategories, nextInventoryNo } from "./inventar";
import { matchCategory } from "./kategorien";
import { ASSET_CONDITIONS, parsePriceCents, type AssetCondition } from "./labels";
import { listAssets, listInspectionTypes, parseDay, planDue, takeOverInspection, type AssetFilter } from "./pruefungen";

export const MAX_ASSET_CSV_BYTES = 512 * 1024;
export const MAX_ASSET_CSV_ROWS = 2000;

/** Felder einer Zeile; `nextDue` nur im Export (SchulOS rechnet die nächste Prüfung selbst). */
export const CSV_FIELDS = [
  "inventoryNo",
  "name",
  "category",
  "manufacturer",
  "model",
  "serial",
  "quantity",
  "condition",
  "building",
  "floor",
  "roomId",
  "acquiredOn",
  "price",
  "supplier",
  "financing",
  "boundUntil",
  "warrantyUntil",
  "lastInspected",
  "nextDue",
  "retiredOn",
] as const;
export type CsvField = (typeof CSV_FIELDS)[number];

/** Kopfzeile des Exports (= dokumentiertes Schulträgerformat) und weitere beim Import erkannte Schreibweisen. */
export const CSV_COLUMNS: Record<CsvField, { header: string; aliases: readonly string[]; exportOnly?: true }> = {
  inventoryNo: { header: "Inventarnummer", aliases: ["inventar-nr", "inventar-nr.", "inventarnr", "inventarnr.", "inv.-nr.", "inv-nr", "inv.nr."] },
  name: { header: "Bezeichnung", aliases: ["name", "gegenstand"] },
  category: { header: "Kategorie", aliases: ["art", "gruppe", "warengruppe"] },
  manufacturer: { header: "Hersteller", aliases: ["marke"] },
  model: { header: "Modell", aliases: ["typ", "typbezeichnung"] },
  serial: { header: "Seriennummer", aliases: ["serien-nr", "serien-nr.", "seriennr", "seriennr.", "s/n"] },
  quantity: { header: "Menge", aliases: ["anzahl", "stueck", "stueckzahl"] },
  condition: { header: "Zustand", aliases: [] },
  building: { header: "Gebäude", aliases: ["standort gebaeude", "haus"] },
  floor: { header: "Etage", aliases: ["geschoss", "stockwerk"] },
  roomId: { header: "Raum", aliases: ["raumnummer", "raum-nr", "raum-nr.", "raumnr"] },
  acquiredOn: { header: "Anschaffungsdatum", aliases: ["anschaffung", "angeschafft am", "anschaffungstag", "beschaffungsdatum"] },
  price: { header: "Preis (EUR)", aliases: ["preis", "preis (euro)", "preis eur", "anschaffungspreis", "anschaffungswert", "wert"] },
  supplier: { header: "Lieferant", aliases: ["lieferfirma", "haendler"] },
  financing: { header: "Finanzierung", aliases: ["foerderung", "foerderprogramm", "finanzierungsquelle", "mittel"] },
  boundUntil: { header: "Zweckbindung bis", aliases: ["zweckbindung", "bindefrist", "zweckbindungsfrist"] },
  warrantyUntil: { header: "Garantie bis", aliases: ["garantie", "gewaehrleistung bis", "garantieende"] },
  lastInspected: { header: "Letzte Prüfung", aliases: ["letzte pruefung"] },
  nextDue: { header: "Nächste Prüfung", aliases: ["naechste pruefung"], exportOnly: true },
  retiredOn: { header: "Ausgemustert am", aliases: ["ausgemustert", "ausmusterung", "ausmusterungsdatum"] },
};

/** Felder, die der Import liest (für die Spaltenzuordnung). */
export const IMPORT_FIELDS = CSV_FIELDS.filter((f) => !CSV_COLUMNS[f].exportOnly);

/** Spaltenfolge einer Datei ohne Kopfzeile (Format seit P4-16/INV-01). */
const LEGACY_ORDER: (CsvField | null)[] = ["name", "category", "roomId", "inventoryNo", "lastInspected", "quantity", "manufacturer", "model", "serial"];

/** Rein: Kopfzelle vergleichbar machen (klein, Umlaute ausgeschrieben, Leerraum zusammengezogen). */
export function normalizeHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ");
}

const HEADER_INDEX = new Map<string, CsvField>(
  CSV_FIELDS.flatMap((f) => [normalizeHeader(CSV_COLUMNS[f].header), normalizeHeader(f), ...CSV_COLUMNS[f].aliases.map(normalizeHeader)].map((h) => [h, f] as const)),
);

/** Rein: Feld zu einer Kopfzelle (oder null). */
export const fieldForHeader = (raw: string): CsvField | null => HEADER_INDEX.get(normalizeHeader(raw)) ?? null;

/** Spaltenzuordnung: ob die erste Zeile Kopfzeile ist und welches Feld jede Spalte füllt (null = ignorieren). */
export interface CsvLayout {
  header: boolean;
  columns: (CsvField | null)[];
}

const lines = (text: string) => text.replace(/^﻿/, "").split(/\r?\n/);

/** Rein: Kopfzeile und Zuordnung erkennen – Kopfzeile, wenn mindestens zwei Zellen bekannte Spaltennamen sind. */
export function detectLayout(text: string): CsvLayout & { firstCells: string[] } {
  const clean = text.replace(/^﻿/, "");
  const sep = detectSeparator(clean);
  const first = lines(clean).find((l) => l.trim()) ?? "";
  const cells = splitCsvLine(first, sep);
  const mapped = cells.map(fieldForHeader);
  if (mapped.filter(Boolean).length >= 2) return { header: true, columns: dedupe(mapped), firstCells: cells };
  // ohne Kopfzeile: alte feste Spaltenfolge (auch wenn die erste Zeile kürzer ist)
  return { header: false, columns: Array.from({ length: Math.max(cells.length, LEGACY_ORDER.length) }, (_, i) => LEGACY_ORDER[i] ?? null), firstCells: cells };
}

/** Jedes Feld höchstens einmal (die erste Spalte gewinnt). */
function dedupe(columns: (CsvField | null)[]): (CsvField | null)[] {
  const seen = new Set<CsvField>();
  return columns.map((c) => {
    if (!c || seen.has(c)) return null;
    seen.add(c);
    return c;
  });
}

export interface AssetCsvRow {
  line: number;
  name: string;
  categoryId: string;
  roomId: string | null;
  inventoryNo: string | null;
  lastInspected: string | null;
  quantity: number | null;
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  condition: AssetCondition | null;
  building: string | null;
  floor: string | null;
  acquiredOn: string | null;
  priceCents: number | null;
  supplier: string | null;
  financing: string | null;
  boundUntil: string | null;
  warrantyUntil: string | null;
  retiredOn: string | null;
}

export interface CsvRowError {
  line: number;
  message: string;
  name?: string;
  inventoryNo?: string | null;
}

/** Rein: Zustand als Schlüssel oder Beschriftung (ohne Groß-/Kleinschreibung). */
function parseCondition(raw: string): AssetCondition | null | undefined {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  return (ASSET_CONDITIONS as readonly string[]).includes(v) ? (v as AssetCondition) : undefined;
}

/**
 * Rein: Inventarliste lesen – mit oder ohne Kopfzeile, „;“ oder „,“, UTF-8 mit/ohne BOM. `layout` überschreibt die erkannte
 * Zuordnung (Spaltenzuordnung der Vorschau). Die Kategorie wird gegen die übergebene Liste aufgelöst (Schlüssel, Name, Präfix,
 * Kurzform – `matchCategory`). Freitexte werden auf die Feldlänge gekürzt, nicht abgelehnt.
 */
export function parseAssetCsv(
  text: string,
  categories: readonly { id: string; key: string; name: string; prefix: string }[],
  layout?: CsvLayout,
): { rows: AssetCsvRow[]; errors: CsvRowError[]; layout: CsvLayout } {
  const clean = text.replace(/^﻿/, "");
  const sep = detectSeparator(clean);
  const use = layout ?? detectLayout(clean);
  const columns = dedupe(use.columns);
  const rows: AssetCsvRow[] = [];
  const errors: CsvRowError[] = [];
  let first = true;
  const cut = (s: string | undefined, n: number) => s?.trim().slice(0, n) || null;
  lines(clean).forEach((raw, idx) => {
    const line = idx + 1;
    if (!raw.trim()) return;
    if (first) {
      first = false;
      if (use.header) return;
    }
    const cells = splitCsvLine(raw, sep);
    const rec: Partial<Record<CsvField, string>> = {};
    columns.forEach((c, i) => {
      // Hochkomma vor =, +, -, @ stammt aus dem Formel-Schutz des Exports (`csvCell`) und fällt beim Einlesen weg
      if (c && !CSV_COLUMNS[c].exportOnly) rec[c] = (cells[i] ?? "").trim().replace(/^'(?=[=+\-@])/, "");
    });
    const name = rec.name ?? "";
    const inventoryNo = rec.inventoryNo || null;
    const fail = (message: string) => errors.push({ line, message, name, inventoryNo });
    const day = (f: "lastInspected" | "acquiredOn" | "boundUntil" | "warrantyUntil" | "retiredOn") => (rec[f] ? parseDay(rec[f]) : null);
    const category = matchCategory(rec.category ?? "", categories);
    const quantity = rec.quantity ? Number(rec.quantity) : null;
    const condition = parseCondition(rec.condition ?? "");
    const priceCents = parsePriceCents(rec.price);
    const badDay = (["lastInspected", "acquiredOn", "boundUntil", "warrantyUntil", "retiredOn"] as const).find((f) => rec[f] && !day(f));
    if (name.length < 2) fail("Name fehlt");
    else if (name.length > 120) fail("Name zu lang (höchstens 120 Zeichen)");
    else if (!category) fail(`Kategorie „${rec.category ?? ""}“ unbekannt`);
    else if (badDay) fail(`Datum „${rec[badDay]}“ nicht lesbar (TT.MM.JJJJ)`);
    else if ((inventoryNo ?? "").length > 40) fail("Inventarnummer zu lang (höchstens 40 Zeichen)");
    else if (quantity !== null && (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999)) fail(`Menge „${rec.quantity}“ nicht lesbar (1 bis 9999)`);
    else if (condition === undefined) fail(`Zustand „${rec.condition}“ unbekannt (neu, gut, gebraucht, defekt)`);
    else if (Number.isNaN(priceCents) || (priceCents !== null && priceCents > 99_999_999_00)) fail(`Preis „${rec.price}“ nicht lesbar (z. B. 1234,56)`);
    else
      rows.push({
        line,
        name,
        categoryId: category.id,
        roomId: rec.roomId || null,
        inventoryNo,
        lastInspected: day("lastInspected"),
        quantity,
        manufacturer: cut(rec.manufacturer, 80),
        model: cut(rec.model, 80),
        serial: cut(rec.serial, 80),
        condition,
        building: cut(rec.building, 120),
        floor: cut(rec.floor, 120),
        acquiredOn: day("acquiredOn"),
        priceCents,
        supplier: cut(rec.supplier, 120),
        financing: cut(rec.financing, 120),
        boundUntil: day("boundUntil"),
        warrantyUntil: day("warrantyUntil"),
        retiredOn: day("retiredOn"),
      });
  });
  return { rows, errors, layout: { header: use.header, columns } };
}

// ---------------------------------------------------------------- Vorschau und Übernahme

export const IMPORT_STATUSES = ["neu", "aendern", "gleich", "uebersprungen", "fehler"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export interface ImportPreviewRow {
  line: number;
  inventoryNo: string | null;
  name: string;
  category: string | null;
  status: ImportStatus;
  notes: string[];
}

export interface ImportPreview {
  layout: CsvLayout;
  /** Zellen der ersten Zeile (Spaltenköpfe bzw. erste Datenzeile) für die Zuordnung */
  firstCells: string[];
  rows: ImportPreviewRow[];
  counts: Record<ImportStatus, number>;
  fileErrors: string[];
  /** Übernehmen möglich: keine Fehler und mindestens eine Änderung */
  ok: boolean;
}

type AssetPatch = Partial<typeof gebaeudeAssets.$inferInsert>;
interface ImportOp {
  line: number;
  id: string | null;
  categoryId: string;
  patch: AssetPatch;
  lastInspected: string | null;
}

export interface ImportPlan {
  preview: ImportPreview;
  ops: ImportOp[];
  /** eine Zeile betrifft eine Kategorie, die die Person nicht pflegt */
  forbidden: boolean;
}

const FIELD_LABELS: Partial<Record<keyof AssetPatch, string>> = {
  name: "Bezeichnung",
  categoryId: "Kategorie",
  roomId: "Raum",
  buildingId: "Gebäude",
  floorId: "Etage",
  manufacturer: "Hersteller",
  model: "Modell",
  serial: "Seriennummer",
  quantity: "Menge",
  condition: "Zustand",
  acquiredOn: "Anschaffungsdatum",
  priceCents: "Preis",
  supplier: "Lieferant",
  financing: "Finanzierung",
  boundUntil: "Zweckbindung",
  warrantyUntil: "Garantie",
};

/**
 * Trockenlauf: Datei lesen, gegen Stammdaten, Rechte und Bestand prüfen – nichts wird gespeichert. Gleiche Inventarnummer →
 * Eintrag wird aktualisiert, **leere Zellen lassen den bisherigen Wert stehen**; ohne Nummer vergibt der Zähler eine. Gebäude/
 * Etage gelten nur für Zeilen ohne Raum (sonst ergibt sich der Ort aus dem Raum). Ausgemustertes bleibt unverändert, Zeilen mit
 * „Ausgemustert am“ werden nicht neu angelegt.
 */
export async function planAssetImport(db: Db, viewer: PermissionSet, text: string, layout?: CsvLayout): Promise<ImportPlan> {
  const empty = { neu: 0, aendern: 0, gleich: 0, uebersprungen: 0, fehler: 0 };
  const own = await maintainableCategories(db, viewer);
  if (own && own.size === 0) throw new ForbiddenError("gebaeude.inventory");
  await ensureCategories(db);
  const detected = detectLayout(text);
  const fileErrors: string[] = [];
  if (text.length > MAX_ASSET_CSV_BYTES) fileErrors.push("Datei zu groß (höchstens 512 KB)");
  // alle Kategorien erkennen (auch ausgeschaltete, damit ein Export wieder passt); neu anlegen nur in eingeschalteten
  const categories = await db.select().from(gebaeudeAssetCategories);
  const inactiveCats = new Set(categories.filter((c) => !c.active).map((c) => c.id));
  const { rows, errors, layout: used } = parseAssetCsv(fileErrors.length ? "" : text, categories, layout);
  if (rows.length + errors.length > MAX_ASSET_CSV_ROWS) fileErrors.push(`Höchstens ${MAX_ASSET_CSV_ROWS} Zeilen je Import`);
  if (!fileErrors.length && rows.length + errors.length === 0) fileErrors.push("Keine Einträge in der Datei");
  const catName = new Map(categories.map((c) => [c.id, c.name]));

  const roomRows = await db.select({ id: rooms.id }).from(rooms);
  const knownRooms = new Set(roomRows.map((r) => r.id));
  const buildingRows = await db.select({ id: buildings.id, name: buildings.name }).from(buildings);
  const buildingByName = new Map(buildingRows.map((b) => [b.name.trim().toLowerCase(), b.id]));
  const floorRows = await db.select({ id: buildingFloors.id, name: buildingFloors.name, buildingId: buildingFloors.buildingId }).from(buildingFloors);
  const floorByName = new Map(floorRows.map((f) => [`${f.buildingId}|${f.name.trim().toLowerCase()}`, f.id]));

  const numbers = rows.map((r) => r.inventoryNo).filter((n): n is string => !!n);
  const existing = new Map(
    numbers.length ? (await db.select().from(gebaeudeAssets).where(inArray(gebaeudeAssets.inventoryNo, numbers))).map((a) => [a.inventoryNo!, a]) : [],
  );
  // Inventar ohne Nummer (Altbestand): Zeile ohne Nummer mit gleicher Bezeichnung, Kategorie und gleichem Raum ist derselbe Eintrag
  // (nur wenn eindeutig), sonst würde ein Re-Import des Exports doppeln
  const unnumbered = await db.select().from(gebaeudeAssets).where(isNull(gebaeudeAssets.inventoryNo));
  const sameKey = (a: { name: string; categoryId: string; roomId: string | null }) => `${a.name.trim().toLowerCase()}|${a.categoryId}|${a.roomId ?? ""}`;
  const byKey = new Map<string, (typeof unnumbered)[number] | null>();
  for (const a of unnumbered) byKey.set(sameKey(a), byKey.has(sameKey(a)) ? null : a);
  for (const a of unnumbered) existing.set(`#${a.id}`, a);
  const ids = [...existing.values()].map((a) => a.id);
  const types = await listInspectionTypes(db, { activeOnly: true });
  const typed = new Set(types.map((t) => t.categoryId));
  const done = new Set(
    ids.length
      ? (
          await db
            .select({ assetId: gebaeudeInspections.assetId, doneOn: gebaeudeInspections.doneOn })
            .from(gebaeudeInspections)
            .where(and(inArray(gebaeudeInspections.assetId, ids), isNotNull(gebaeudeInspections.doneOn)))
        ).map((i) => `${i.assetId}|${i.doneOn}`)
      : [],
  );

  const out: ImportPreviewRow[] = errors.map((e) => ({ line: e.line, inventoryNo: e.inventoryNo ?? null, name: e.name ?? "", category: null, status: "fehler" as const, notes: [e.message] }));
  const ops: ImportOp[] = [];
  const seen = new Set<string>();
  let forbidden = false;
  for (const r of rows) {
    const notes: string[] = [];
    const row: ImportPreviewRow = { line: r.line, inventoryNo: r.inventoryNo, name: r.name, category: catName.get(r.categoryId) ?? null, status: "fehler", notes };
    out.push(row);
    const old = r.inventoryNo ? existing.get(r.inventoryNo) : (byKey.get(sameKey(r)) ?? undefined);
    if (own && (!own.has(r.categoryId) || (old && !own.has(old.categoryId)))) {
      forbidden = true;
      notes.push(`Kategorie „${catName.get(old && !own.has(old.categoryId) ? old.categoryId : r.categoryId) ?? "?"}“ pflegst du nicht`);
    }
    if (inactiveCats.has(r.categoryId) && (!old || old.categoryId !== r.categoryId)) notes.push(`Kategorie „${catName.get(r.categoryId)}“ ist ausgeschaltet`);
    if (r.roomId && !knownRooms.has(r.roomId)) notes.push(`Raum „${r.roomId}“ gibt es nicht`);
    let buildingId: string | null = null;
    let floorId: string | null = null;
    if (!r.roomId && r.building) {
      buildingId = buildingByName.get(r.building.toLowerCase()) ?? null;
      if (!buildingId) notes.push(`Gebäude „${r.building}“ gibt es nicht`);
    }
    if (!r.roomId && r.floor) {
      if (!r.building) notes.push("Etage ohne Gebäude");
      else if (buildingId) {
        floorId = floorByName.get(`${buildingId}|${r.floor.toLowerCase()}`) ?? null;
        if (!floorId) notes.push(`Etage „${r.floor}“ gibt es im Gebäude „${r.building}“ nicht`);
      }
    }
    if (r.inventoryNo) {
      if (seen.has(r.inventoryNo)) notes.push(`Inventarnummer „${r.inventoryNo}“ doppelt`);
      seen.add(r.inventoryNo);
    }
    if (notes.length) continue;

    // nur gefüllte Zellen schreiben
    const patch: AssetPatch = { name: r.name, categoryId: r.categoryId };
    const set = <K extends keyof AssetPatch>(k: K, v: AssetPatch[K] | null) => {
      if (v !== null && v !== undefined) patch[k] = v;
    };
    set("inventoryNo", r.inventoryNo);
    set("roomId", r.roomId);
    set("buildingId", buildingId);
    set("floorId", floorId);
    set("manufacturer", r.manufacturer);
    set("model", r.model);
    set("serial", r.serial);
    set("quantity", r.quantity);
    set("condition", r.condition);
    set("acquiredOn", r.acquiredOn);
    set("priceCents", r.priceCents);
    set("supplier", r.supplier);
    set("financing", r.financing);
    set("boundUntil", r.boundUntil);
    set("warrantyUntil", r.warrantyUntil);
    // Etage aus einem anderen Gebäude als bisher → Etage leeren, damit beides zusammenpasst
    if (old && buildingId && !floorId && old.floorId && old.buildingId !== buildingId) patch.floorId = null;
    const takesInspection = !!r.lastInspected && typed.has(r.categoryId);

    if (old) {
      if (!old.active) {
        row.status = "uebersprungen";
        notes.push("ausgemustert – bleibt unverändert");
        continue;
      }
      const changed = (Object.keys(patch) as (keyof AssetPatch)[]).filter((k) => (old as unknown as Record<string, unknown>)[k] !== patch[k]);
      const inspection = takesInspection && !done.has(`${old.id}|${r.lastInspected}`);
      if (changed.length === 0 && !inspection) {
        row.status = "gleich";
        continue;
      }
      row.status = "aendern";
      notes.push(`ändert: ${[...changed.map((k) => FIELD_LABELS[k] ?? k), ...(inspection ? ["letzte Prüfung"] : [])].join(", ")}`);
      ops.push({ line: r.line, id: old.id, categoryId: r.categoryId, patch, lastInspected: takesInspection ? r.lastInspected : null });
    } else {
      if (r.retiredOn) {
        row.status = "uebersprungen";
        notes.push("ausgemustert – wird nicht neu angelegt");
        continue;
      }
      row.status = "neu";
      if (!r.inventoryNo) notes.push("Inventarnummer wird vergeben");
      ops.push({ line: r.line, id: null, categoryId: r.categoryId, patch, lastInspected: takesInspection ? r.lastInspected : null });
    }
  }
  out.sort((a, b) => a.line - b.line);
  const counts = { ...empty };
  for (const r of out) counts[r.status]++;
  return {
    preview: {
      layout: used,
      firstCells: detected.firstCells,
      rows: out,
      counts,
      fileErrors,
      ok: fileErrors.length === 0 && counts.fehler === 0 && counts.neu + counts.aendern > 0,
    },
    ops,
    forbidden,
  };
}

/** Übernahme eines fehlerfreien Plans in einer Transaktion (ganz oder gar nicht); Audit ohne Inhalte, nur Zahlen. */
export async function executeAssetImport(db: Db, viewer: PermissionSet, plan: ImportPlan, today: string): Promise<{ created: number; updated: number; skipped: number }> {
  if (!plan.preview.ok) throw new ValidationError({ file: "Die Datei hat Fehler bzw. nichts zu übernehmen – nichts übernommen" });
  const own = await maintainableCategories(db, viewer);
  for (const op of plan.ops) if (own && !own.has(op.categoryId)) throw new ForbiddenError("gebaeude.inventory");
  const types = await listInspectionTypes(db, { activeOnly: true });
  const format = await inventoryNoFormat(db);
  const prefixOf = new Map((await db.select({ id: gebaeudeAssetCategories.id, prefix: gebaeudeAssetCategories.prefix }).from(gebaeudeAssetCategories)).map((c) => [c.id, c.prefix]));
  const skipped = plan.preview.counts.gleich + plan.preview.counts.uebersprungen;
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    let created = 0;
    let updated = 0;
    for (const op of plan.ops) {
      let id = op.id;
      if (id) {
        await tx.update(gebaeudeAssets).set(op.patch).where(eq(gebaeudeAssets.id, id));
        updated++;
      } else {
        const inventoryNo = op.patch.inventoryNo ?? (await nextInventoryNo(tx, prefixOf.get(op.categoryId) ?? "INV", format, today));
        const [ins] = await tx
          .insert(gebaeudeAssets)
          .values({ ...op.patch, name: op.patch.name!, categoryId: op.categoryId, inventoryNo })
          .returning({ id: gebaeudeAssets.id });
        id = ins!.id;
        created++;
      }
      if (op.lastInspected) for (const t of types.filter((x) => x.categoryId === op.categoryId)) await takeOverInspection(tx, t, id, op.lastInspected);
    }
    await audit(tx, viewer.userId, "gebaeude.asset.import", null, { created, updated, skipped });
    await planDue(tx, today);
    return { created, updated, skipped };
  });
}

/**
 * Import in einem Schritt (ohne Vorschau, für Skripte und Tests): erkannte Zuordnung, fremde Kategorie → `ForbiddenError`,
 * sonst Fehler gesammelt als `ValidationError` („Zeile n: …“, höchstens 5).
 */
export async function importAssets(db: Db, viewer: PermissionSet, text: string, today: string): Promise<{ created: number; updated: number }> {
  if (text.length > MAX_ASSET_CSV_BYTES) throw new ValidationError({ file: "Datei zu groß (höchstens 512 KB)" });
  const plan = await planAssetImport(db, viewer, text);
  if (plan.forbidden) throw new ForbiddenError("gebaeude.inventory");
  const p = plan.preview;
  const errs = [...p.fileErrors.filter((e) => e !== "Keine Einträge in der Datei"), ...p.rows.filter((r) => r.status === "fehler").flatMap((r) => r.notes.map((n) => `Zeile ${r.line}: ${n}`))];
  if (errs.length) throw new ValidationError({ file: errs.slice(0, 5).join(" · ") + (errs.length > 5 ? ` (und ${errs.length - 5} weitere)` : "") });
  if (p.rows.length === 0) throw new ValidationError({ file: "Keine Anlagen in der Datei" });
  if (!p.ok) return { created: 0, updated: 0 };
  const r = await executeAssetImport(db, viewer, plan, today);
  return { created: r.created, updated: r.updated };
}

// ---------------------------------------------------------------- Export

const de = (ymd: string | null) => (ymd ? `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}` : "");
const euro = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2).replace(".", ","));

/**
 * Bestandsliste im Schulträgerformat (Kopfzeile = `CSV_COLUMNS`, Datum TT.MM.JJJJ, Preis „1234,56“) mit den Filtern der Liste.
 * Lesen wie die Liste (`view_all`/Pflegende; verantwortliche Gruppen nur ihre Kategorien). Ohne Notiz und Ausmusterungsgrund.
 * Ausgemustertes nur mit Filter „auch ausgemusterte“. Der Export lässt sich unverändert wieder importieren.
 */
export async function assetListCsv(db: Db, viewer: PermissionSet, filter: AssetFilter, encoding: CsvEncoding = "utf8"): Promise<Uint8Array> {
  if (!(await canSeeInventory(db, viewer))) throw new ForbiddenError("gebaeude.view_all");
  const assets = await listAssets(db, viewer, filter);
  const ids = assets.map((a) => a.id);
  const last = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const part = await db
      .select({ assetId: gebaeudeInspections.assetId, last: sql<string>`max(${gebaeudeInspections.doneOn})::text` })
      .from(gebaeudeInspections)
      .where(and(inArray(gebaeudeInspections.assetId, ids.slice(i, i + 500)), isNotNull(gebaeudeInspections.doneOn)))
      .groupBy(gebaeudeInspections.assetId);
    for (const p of part) if (p.assetId) last.set(p.assetId, p.last);
  }
  const value = (a: (typeof assets)[number], f: CsvField): string | number | null => {
    switch (f) {
      case "inventoryNo":
        return a.inventoryNo;
      case "name":
        return a.name;
      case "category":
        return a.categoryName;
      case "manufacturer":
        return a.manufacturer;
      case "model":
        return a.model;
      case "serial":
        return a.serial;
      case "quantity":
        return a.quantity;
      case "condition":
        return a.condition;
      case "building":
        return a.building;
      case "floor":
        return a.floor;
      case "roomId":
        return a.roomId;
      case "acquiredOn":
        return de(a.acquiredOn);
      case "price":
        return euro(a.priceCents);
      case "supplier":
        return a.supplier;
      case "financing":
        return a.financing;
      case "boundUntil":
        return de(a.boundUntil);
      case "warrantyUntil":
        return de(a.warrantyUntil);
      case "lastInspected":
        return de(last.get(a.id) ?? null);
      case "nextDue":
        return de(a.nextDue);
      case "retiredOn":
        return de(a.retiredOn);
    }
  };
  await audit(db, viewer.userId, "gebaeude.asset.export", null, { count: assets.length });
  return csvBytes([CSV_FIELDS.map((f) => CSV_COLUMNS[f].header), ...assets.map((a) => CSV_FIELDS.map((f) => value(a, f)))], encoding);
}
