// SP3-04 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.1, R2): „Plan am Tag X“ – welche veröffentlichte Version an einem Tag gilt – und der
// Hinweis für die Vertretungsplanung auf freigegebene, noch nicht veröffentlichte Versionen. Liest nur die Hülle der Versionen (Nummer,
// Name, Status, Zeitraum), nie Entwurfsstunden: der Plan selbst bleibt `timetable_lessons` mit `valid_from`/`valid_until` (seine eigene
// Historie), die Leser (Stundenplan, Druck) lesen ihn wie bisher am gewählten Tag.
import { and, asc, eq, gt, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { schoolYears } from "@/core/db/schema";
import { timetablePlanVersions } from "./schema";

const label = (v: { major: number; minor: number }) => `${v.major}.${v.minor}`;

export interface VersionOnDay {
  id: string;
  label: string;
  name: string;
  status: "gueltig" | "archiviert";
  validFrom: string | null;
  validUntil: string | null;
}

/**
 * Die veröffentlichte Version (gültig oder archiviert), die am Tag `ymd` gilt – im Schuljahr dieses Tages, Zeitraum `valid_from` …
 * `valid_until` (offen = bis Schuljahresende). `null`, wenn es dafür keine Version gibt (z. B. vor SP3-01 bzw. außerhalb eines Schuljahrs).
 */
export async function versionOn(db: Db, ymd: string): Promise<VersionOnDay | null> {
  const [year] = await db
    .select({ id: schoolYears.id, endsOn: schoolYears.endsOn })
    .from(schoolYears)
    .where(and(lte(schoolYears.startsOn, ymd), gte(schoolYears.endsOn, ymd)));
  if (!year) return null;
  const [v] = await db
    .select()
    .from(timetablePlanVersions)
    .where(
      and(
        eq(timetablePlanVersions.schoolYearId, year.id),
        inArray(timetablePlanVersions.status, ["gueltig", "archiviert"]),
        lte(timetablePlanVersions.validFrom, ymd),
        or(isNull(timetablePlanVersions.validUntil), gte(timetablePlanVersions.validUntil, ymd)),
      ),
    )
    .orderBy(asc(timetablePlanVersions.validFrom))
    .limit(1);
  if (!v || (v.status !== "gueltig" && v.status !== "archiviert")) return null;
  return { id: v.id, label: label(v), name: v.name, status: v.status, validFrom: v.validFrom, validUntil: v.validUntil };
}

/**
 * R2: freigegebene Versionen mit Stichtag in der Zukunft – die Vertretungsplanung arbeitet bis zum Veröffentlichen im gültigen Plan; was ab
 * dann gilt, kann sich noch ändern. Nur Nummer, Name und Stichtag (keine Stunden).
 */
export async function pendingPublications(db: Db, today: string): Promise<{ id: string; label: string; name: string; validFrom: string }[]> {
  const rows = await db
    .select({ id: timetablePlanVersions.id, major: timetablePlanVersions.major, minor: timetablePlanVersions.minor, name: timetablePlanVersions.name, validFrom: timetablePlanVersions.validFrom })
    .from(timetablePlanVersions)
    .where(and(eq(timetablePlanVersions.status, "freigegeben"), gt(timetablePlanVersions.validFrom, today)))
    .orderBy(asc(timetablePlanVersions.validFrom), asc(timetablePlanVersions.id));
  return rows.map((r) => ({ id: r.id, label: label(r), name: r.name, validFrom: r.validFrom! }));
}

/** Zeitstrahl der veröffentlichten Versionen eines Schuljahrs (älteste zuerst) – für die Versionsliste. */
export async function publishedTimeline(db: Db, schoolYearId: string): Promise<VersionOnDay[]> {
  const rows = await db
    .select()
    .from(timetablePlanVersions)
    .where(and(eq(timetablePlanVersions.schoolYearId, schoolYearId), inArray(timetablePlanVersions.status, ["gueltig", "archiviert"])))
    .orderBy(asc(timetablePlanVersions.validFrom), asc(timetablePlanVersions.major), asc(timetablePlanVersions.minor));
  return rows.flatMap((v) => (v.status === "gueltig" || v.status === "archiviert" ? [{ id: v.id, label: label(v), name: v.name, status: v.status, validFrom: v.validFrom, validUntil: v.validUntil }] : []));
}
