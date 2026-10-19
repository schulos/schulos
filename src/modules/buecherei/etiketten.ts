// Schulbücherei – Etiketten (BU-05): Exemplar-Etiketten mit Code 128 (selbst erzeugtes SVG, BU-07) für A4-Etikettenbögen und
// Etikettendrucker, gedruckt über den Browser (`@page` in mm, kein PDF-Paket, kein Direktdruck vom Server – Entscheidung 9).
// Neue Exemplare stehen in der Druckwarteschlange, bis jemand sie „als gedruckt markiert“. Kein Personenbezug.
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { buechereiCopies, buechereiTitles } from "@/core/db/schema";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";

function requireStock(p: PermissionSet) {
  if (!hasPermission(p, "buecherei.stock")) throw new ForbiddenError("buecherei.stock");
}

// ---------------------------------------------------------------- Vorlagen (rein)

export interface LabelTemplate {
  id: string;
  label: string;
  /** A4-Bogen (mehrere Etiketten je Seite) oder Rolle (ein Etikett je Seite, Etikettendrucker) */
  kind: "bogen" | "rolle";
  cols: number;
  rows: number;
  widthMm: number;
  heightMm: number;
  /** Rand oben/links des ersten Etiketts und Abstand zwischen den Etiketten (nur Bögen) */
  topMm: number;
  leftMm: number;
  gapXMm: number;
  gapYMm: number;
}

/** Gängige Formate; Bögen füllen A4 (210 × 297 mm) bis auf einen schmalen Rand oben. */
export const LABEL_TEMPLATES: readonly LabelTemplate[] = [
  { id: "a4-3x8", label: "A4-Bogen 3 × 8 (70 × 37 mm)", kind: "bogen", cols: 3, rows: 8, widthMm: 70, heightMm: 37, topMm: 0.5, leftMm: 0, gapXMm: 0, gapYMm: 0 },
  { id: "a4-3x7", label: "A4-Bogen 3 × 7 (70 × 42,3 mm)", kind: "bogen", cols: 3, rows: 7, widthMm: 70, heightMm: 42.3, topMm: 0.4, leftMm: 0, gapXMm: 0, gapYMm: 0 },
  { id: "a4-4x10", label: "A4-Bogen 4 × 10 (52,5 × 29,7 mm)", kind: "bogen", cols: 4, rows: 10, widthMm: 52.5, heightMm: 29.7, topMm: 0, leftMm: 0, gapXMm: 0, gapYMm: 0 },
  { id: "a4-2x8", label: "A4-Bogen 2 × 8 (105 × 37 mm)", kind: "bogen", cols: 2, rows: 8, widthMm: 105, heightMm: 37, topMm: 0.5, leftMm: 0, gapXMm: 0, gapYMm: 0 },
  { id: "rolle-62x29", label: "Etikettendrucker 62 × 29 mm", kind: "rolle", cols: 1, rows: 1, widthMm: 62, heightMm: 29, topMm: 0, leftMm: 0, gapXMm: 0, gapYMm: 0 },
  { id: "rolle-54x25", label: "Etikettendrucker 54 × 25 mm", kind: "rolle", cols: 1, rows: 1, widthMm: 54, heightMm: 25, topMm: 0, leftMm: 0, gapXMm: 0, gapYMm: 0 },
];

export const DEFAULT_TEMPLATE = LABEL_TEMPLATES[0]!;

/** Rein: Vorlage zur ID, sonst die Vorgabe (3 × 8). */
export function labelTemplate(id: string | undefined): LabelTemplate {
  return LABEL_TEMPLATES.find((t) => t.id === id) ?? DEFAULT_TEMPLATE;
}

export const perSheet = (t: LabelTemplate) => t.cols * t.rows;

/** Rein: Position (in mm, links oben) eines Platzes 0 … n-1 auf dem Bogen, zeilenweise von links oben. */
export function slotPosition(t: LabelTemplate, slot: number): { xMm: number; yMm: number } {
  const col = slot % t.cols;
  const row = Math.floor(slot / t.cols);
  return { xMm: t.leftMm + col * (t.widthMm + t.gapXMm), yMm: t.topMm + row * (t.heightMm + t.gapYMm) };
}

/** Rein: gültige Startposition (1 … Etiketten je Bogen) – Bögen, von denen schon Etiketten abgezogen sind; Rollen immer 1. */
export function clampStart(t: LabelTemplate, raw: string | number | undefined): number {
  if (t.kind === "rolle") return 1;
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n >= 1 && n <= perSheet(t) ? n : 1;
}

/**
 * Rein: Etiketten auf Seiten verteilen. Auf der ersten Seite bleiben die Plätze vor der Startposition frei (`null`), damit ein
 * angebrochener Bogen weiterverwendet werden kann. Rolle: ein Etikett je Seite.
 */
export function layoutPages<T>(t: LabelTemplate, items: readonly T[], start = 1): (T | null)[][] {
  const size = perSheet(t);
  const skip = t.kind === "rolle" ? 0 : Math.min(Math.max(start, 1), size) - 1;
  const cells: (T | null)[] = [...Array.from({ length: skip }, () => null), ...items];
  const pages: (T | null)[][] = [];
  for (let i = 0; i < cells.length; i += size) pages.push(cells.slice(i, i + size));
  return pages;
}

// ---------------------------------------------------------------- Daten

/** Höchstens so viele Etiketten in einem Druckauftrag (Browser bleibt bedienbar). */
export const MAX_LABELS_PER_PRINT = 400;

export interface PrintLabel {
  copyId: string;
  barcode: string;
  signature: string | null;
  title: string;
  printed: boolean;
}

export type LabelSource = { kind: "warteschlange" } | { kind: "titel"; titleId: string } | { kind: "exemplar"; copyId: string };

/** Etiketten zum Drucken: Druckwarteschlange, alle Exemplare im Bestand eines Titels oder ein einzelnes Exemplar (Recht `stock`). */
export async function labelsToPrint(db: Db, viewer: PermissionSet, src: LabelSource): Promise<PrintLabel[]> {
  requireStock(viewer);
  const where =
    src.kind === "warteschlange"
      ? and(isNull(buechereiCopies.labelPrintedAt), isNull(buechereiCopies.withdrawnOn))
      : src.kind === "titel"
        ? and(eq(buechereiCopies.titleId, src.titleId), isNull(buechereiCopies.withdrawnOn))
        : eq(buechereiCopies.id, src.copyId);
  const rows = await db
    .select({
      copyId: buechereiCopies.id,
      barcode: buechereiCopies.barcode,
      signature: buechereiCopies.signature,
      title: buechereiTitles.title,
      printedAt: buechereiCopies.labelPrintedAt,
    })
    .from(buechereiCopies)
    .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiCopies.titleId))
    .where(where)
    .orderBy(asc(buechereiCopies.seq))
    .limit(MAX_LABELS_PER_PRINT);
  return rows.map((r) => ({ copyId: r.copyId, barcode: r.barcode, signature: r.signature, title: r.title, printed: !!r.printedAt }));
}

/** Druckwarteschlange: Zahl der Exemplare ohne gedrucktes Etikett und die ersten davon zur Ansicht. */
export async function labelQueue(db: Db, viewer: PermissionSet, limit = 50) {
  requireStock(viewer);
  const open = and(isNull(buechereiCopies.labelPrintedAt), isNull(buechereiCopies.withdrawnOn));
  const [[c], rows] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(buechereiCopies).where(open),
    db
      .select({ copyId: buechereiCopies.id, barcode: buechereiCopies.barcode, signature: buechereiCopies.signature, title: buechereiTitles.title, titleId: buechereiTitles.id })
      .from(buechereiCopies)
      .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiCopies.titleId))
      .where(open)
      .orderBy(asc(buechereiCopies.seq))
      .limit(limit),
  ]);
  return { count: c?.n ?? 0, rows };
}

/** Exemplare als gedruckt markieren (aus der Druckansicht – genau die gedruckten). Liefert die Zahl der geänderten. */
export async function markLabelsPrinted(db: Db, viewer: PermissionSet, copyIds: readonly string[], now: Date): Promise<number> {
  requireStock(viewer);
  const ids = [...new Set(copyIds)].slice(0, MAX_LABELS_PER_PRINT);
  if (!ids.length) throw new ValidationError({ labels: "Keine Etiketten ausgewählt" });
  const done = await db
    .update(buechereiCopies)
    .set({ labelPrintedAt: now })
    .where(and(inArray(buechereiCopies.id, ids), isNull(buechereiCopies.labelPrintedAt)))
    .returning({ id: buechereiCopies.id });
  if (done.length) await audit(db, viewer.userId, "buecherei.labels.printed", null, { count: done.length });
  return done.length;
}

/** Ganze Warteschlange als gedruckt markieren (Altbestand, der schon Etiketten hat). */
export async function markQueuePrinted(db: Db, viewer: PermissionSet, now: Date): Promise<number> {
  requireStock(viewer);
  const done = await db
    .update(buechereiCopies)
    .set({ labelPrintedAt: now })
    .where(and(isNull(buechereiCopies.labelPrintedAt), isNull(buechereiCopies.withdrawnOn)))
    .returning({ id: buechereiCopies.id });
  if (done.length) await audit(db, viewer.userId, "buecherei.labels.printed", null, { count: done.length, all: true });
  return done.length;
}

/** Exemplar wieder in die Warteschlange (Etikett beschädigt oder verloren). */
export async function requeueLabel(db: Db, viewer: PermissionSet, copyId: string): Promise<void> {
  requireStock(viewer);
  const [r] = await db
    .update(buechereiCopies)
    .set({ labelPrintedAt: null })
    .where(and(eq(buechereiCopies.id, copyId), isNotNull(buechereiCopies.labelPrintedAt), isNull(buechereiCopies.withdrawnOn)))
    .returning({ id: buechereiCopies.id });
  if (!r) throw new ValidationError({ labels: "Exemplar gibt es nicht, ist ausgesondert oder steht schon in der Warteschlange" });
}
