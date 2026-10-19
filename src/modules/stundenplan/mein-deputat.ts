// „Mein Deputat / meine Vertretungsstunden“ (Q5-09, I-20): die eigenen Zahlen einer Lehrkraft, nur lesend.
// Datenschutz: jede Funktion rechnet nur für die übergebene Person – Aufrufer übergeben immer die angemeldete Lehrkraft.
// Kein Vergleich mit anderen, keine Ranglisten (Mitbestimmung, DATENSCHUTZ §5); die Planung sieht weiter alles unter
// Stundenplanung → Unterrichtsverteilung bzw. Vertretungen → Statistik.
import { and, eq, gte, lte, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { timetableLessons, timetableSubstitutions } from "@/core/db/schema";
import { readSchoolSettings } from "@/core/settings";
import { defaultObligation, deputyAccounts, type DeputyAccount } from "./deputate";
import { distribution, planningYear } from "./verteilung";
import { draftDaysBetween } from "./freigabe";

export interface OwnSubstitutions {
  /** Mehrarbeit: Stunden, die die Person vertreten hat */
  covered: number;
  /** SP-12: davon mit eigenem (abweichendem) Fach – rein informativ */
  coveredOwnSubject: number;
  /** eigene Stunden, die jemand anderes vertreten hat */
  given: number;
  /** eigene Stunden, die entfallen sind */
  cancelled: number;
}

/** Vertretungszähler einer Person in [from, to] (wie die Vertretungsstatistik, aber nur diese Person). */
export async function ownSubstitutions(db: Db, teacherId: string, from: string, to: string): Promise<OwnSubstitutions> {
  const rows = await db
    .select({ date: timetableSubstitutions.date, kind: timetableSubstitutions.kind, substituteId: timetableSubstitutions.substituteId, subjectId: timetableSubstitutions.subjectId, teacherId: timetableLessons.teacherId })
    .from(timetableSubstitutions)
    .innerJoin(timetableLessons, eq(timetableLessons.id, timetableSubstitutions.lessonId))
    .where(
      and(
        gte(timetableSubstitutions.date, from),
        lte(timetableSubstitutions.date, to),
        or(eq(timetableSubstitutions.substituteId, teacherId), eq(timetableLessons.teacherId, teacherId)),
      ),
    );
  const out: OwnSubstitutions = { covered: 0, coveredOwnSubject: 0, given: 0, cancelled: 0 };
  // Q5-11: Entwürfe zählen erst, wenn sie veröffentlicht sind
  const drafts = rows.length ? await draftDaysBetween(db, from, to) : new Set<string>();
  for (const r of rows) {
    if (r.kind === "room" || drafts.has(r.date)) continue;
    if (r.kind === "cancel") {
      if (r.teacherId === teacherId) out.cancelled++;
    } else {
      if (r.substituteId === teacherId) {
        out.covered++;
        if (r.subjectId) out.coveredOwnSubject++;
      }
      if (r.teacherId === teacherId) out.given++;
    }
  }
  return out;
}

export interface MyDeputy {
  year: { id: string; name: string; startsOn: string; endsOn: string };
  account: DeputyAccount | null;
  inYear: OwnSubstitutions;
  inMonth: OwnSubstitutions;
  monthFrom: string;
}

/** Deputatskonto + Vertretungszähler (Schuljahr bis heute, laufender Monat) der Person; null ohne Schuljahr. */
export async function myDeputy(db: Db, teacherId: string, today: string): Promise<MyDeputy | null> {
  const year = await planningYear(db);
  if (!year) return null;
  const [d, school] = await Promise.all([distribution(db, year, today), readSchoolSettings(db)]);
  const own = d.teachers.filter((t) => t.id === teacherId);
  const [account] = own.length ? await deputyAccounts(db, year.id, own, defaultObligation(school.profile.form)) : [];
  const yearTo = today < year.endsOn ? today : year.endsOn;
  const monthFrom = `${today.slice(0, 8)}01`;
  const [y, m] = await Promise.all([ownSubstitutions(db, teacherId, year.startsOn, yearTo), ownSubstitutions(db, teacherId, monthFrom, today)]);
  return { year: { id: year.id, name: year.name, startsOn: year.startsOn, endsOn: year.endsOn }, account: account ?? null, inYear: y, inMonth: m, monthFrom };
}
