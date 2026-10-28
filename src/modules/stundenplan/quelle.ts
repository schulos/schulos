// SP3-02 (docs/STUNDENPLAN-LEBENSZYKLUS.md §7.2): Quellen-Wähler für Stundenplan, Unterrichtsverteilung, Diagnose und Solver – „Gültiger
// Plan“ oder ein offener Entwurf („Entwurf 2.0“). Seiten reichen nur den URL-Wert (`?quelle=<Version>`) weiter; welche Tabelle gelesen
// wird, entscheidet die Planquelle (`plan-quelle.ts`) im Modul.
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { timetablePlanVersions, type TimetablePlanVersion } from "./schema";
import { draftOf, LIVE, requireWritable, type PlanSource } from "./plan-quelle";
import { OPEN_STATUSES, STATUS_LABELS, versionNumber } from "./planversionen";
import { requireWritableYear, yearOfVersion } from "./planungsjahr";

/** URL-Wert des gültigen Plans (Vorgabe, steht nicht in der URL). */
export const QUELLE_LIVE = "gueltig";

export interface QuelleOption {
  value: string;
  label: string;
  /** Stichtag des Entwurfs */
  validFrom: string | null;
  /** nur Entwürfe im Status `entwurf` sind bearbeitbar */
  editable: boolean;
}

export interface Quelle {
  /** URL-Wert (`gueltig` oder Versions-id) */
  value: string;
  source: PlanSource;
  label: string;
  version: TimetablePlanVersion | null;
  /** Schreiben erlaubt (gültiger Plan oder Entwurf im Status `entwurf`) */
  editable: boolean;
  options: QuelleOption[];
}

export const draftLabel = (v: Pick<TimetablePlanVersion, "major" | "minor" | "name" | "status">) =>
  `Entwurf ${versionNumber(v)} „${v.name}“${v.status === "entwurf" ? "" : ` (${STATUS_LABELS[v.status]})`}`;

/** Offene Entwürfe eines Schuljahrs (neueste zuerst) als Auswahl hinter „Gültiger Plan“. */
export async function quelleOptions(db: Db, schoolYearId: string | null): Promise<QuelleOption[]> {
  const live: QuelleOption = { value: QUELLE_LIVE, label: "Gültiger Plan", validFrom: null, editable: true };
  if (!schoolYearId) return [live];
  const rows = await db
    .select()
    .from(timetablePlanVersions)
    .where(and(eq(timetablePlanVersions.schoolYearId, schoolYearId), inArray(timetablePlanVersions.status, [...OPEN_STATUSES])))
    .orderBy(desc(timetablePlanVersions.major), desc(timetablePlanVersions.minor), desc(timetablePlanVersions.createdAt), desc(timetablePlanVersions.id));
  return [live, ...rows.map((v) => ({ value: v.id, label: draftLabel(v), validFrom: v.validFrom, editable: v.status === "entwurf" }))];
}

/** Quelle aus dem URL-Wert; Unbekanntes (verworfen, veröffentlicht, anderes Schuljahr) fällt still auf den gültigen Plan zurück. */
export async function resolveQuelle(db: Db, raw: string | null | undefined, schoolYearId: string | null): Promise<Quelle> {
  const options = await quelleOptions(db, schoolYearId);
  const hit = raw && raw !== QUELLE_LIVE ? options.find((o) => o.value === raw) : undefined;
  if (!hit) return { value: QUELLE_LIVE, source: LIVE, label: "Gültiger Plan", version: null, editable: true, options };
  const [version] = await db.select().from(timetablePlanVersions).where(eq(timetablePlanVersions.id, hit.value));
  return { value: hit.value, source: draftOf(hit.value), label: hit.label, version: version ?? null, editable: hit.editable, options };
}

/**
 * Für Server Actions: Quelle zum Schreiben – leer/`gueltig` = gültiger Plan, sonst ein Entwurf im Status `entwurf` (sonst Fehler).
 * SP3-09a: Entwürfe auch im Folgejahr; Entwürfe abgeschlossener Schuljahre sind nur lesbar.
 */
export async function writableSource(db: Db, raw: string | null | undefined): Promise<PlanSource> {
  if (!raw || raw === QUELLE_LIVE) return LIVE;
  const source = draftOf(raw);
  await requireWritable(db, source);
  await requireWritableYear(db, (await yearOfVersion(db, raw))?.id);
  return source;
}

/** Query-Anhang für Links (`&quelle=…`), leer beim gültigen Plan. */
export const quelleQuery = (value: string | null | undefined) => (value && value !== QUELLE_LIVE ? `&quelle=${encodeURIComponent(value)}` : "");
