// GT-05: Familienansicht – Schüler:innen sehen ihre eigenen Zeilen, Eltern die ihres Kindes nach den Regeln der Abwesenheiten
// (core/school/majority.ts: minderjährig oder eigenständig mit Einwilligung „Eltern weiter informieren“). Niemand sieht, wer sonst
// fehlt: gelesen wird ausschließlich über `ganztag_marks.student_id` (Index `ganztag_marks_student_idx`).
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne } from "drizzle-orm";
import { auditRead } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { ganztagMarks, ganztagSessions, groupFeatures, groupMembers, groups, type GanztagExcused, type GanztagMarkStatus } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import type { PermissionSet } from "@/core/permissions";
import { childrenOf } from "@/core/school/majority";
import { addDays, toBerlinDate } from "@/core/time";
import { currentYear, LIST_FEATURE } from "./service";

export interface FamilyMark {
  date: string;
  startsAt: string;
  endsAt: string;
  offer: string;
  status: GanztagMarkStatus;
  minutesLate: number | null;
  /** nur bei „fehlt“: Stand aus den Abwesenheiten */
  excused: GanztagExcused | null;
}

export interface FamilyChild {
  id: string;
  name: string;
  offers: { id: string; name: string; next: { date: string; startsAt: string; endsAt: string } | null; cancelled: { date: string; startsAt: string }[] }[];
  marks: FamilyMark[];
  counts: { anwesend: number; fehlt: number; verspaetet: number };
}

/** Wessen Zeilen darf die Person sehen? Schüler:in sich selbst, Eltern ihre Kinder (minderjährig bzw. mit Einwilligung). */
export async function familyTargets(db: Db, viewer: PermissionSet): Promise<{ id: string; name: string }[]> {
  if (viewer.role === "schueler") return [{ id: viewer.userId, name: "" }];
  if (viewer.role === "eltern") return (await childrenOf(db, viewer.userId, "inform")).map((c) => ({ id: c.id, name: c.name }));
  return [];
}

/** Ganztag der Familie: je Kind die Angebote mit Liste, nächste Termine bzw. Ausfälle und die eigenen Zeilen dieses Schuljahres. */
export async function familyView(db: Db, viewer: PermissionSet, now = new Date()): Promise<FamilyChild[]> {
  const targets = await familyTargets(db, viewer);
  if (targets.length === 0) return [];
  const today = toBerlinDate(now);
  const year = await currentYear(db, today);
  const from = year?.startsOn ?? addDays(today, -180);
  const out: FamilyChild[] = [];
  for (const t of targets) {
    const offers = await db
      .select({ id: groups.id, name: groups.name })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .innerJoin(groupFeatures, and(eq(groupFeatures.groupId, groups.id), eq(groupFeatures.feature, LIST_FEATURE)))
      .where(and(eq(groupMembers.userId, t.id), eq(groupMembers.role, "member"), isNull(groups.archivedAt)))
      .orderBy(de(groups.name));
    const offerIds = offers.map((o) => o.id);
    const [upcoming, marks] = await Promise.all([
      offerIds.length
        ? db
            .select({ groupId: ganztagSessions.groupId, date: ganztagSessions.date, startsAt: ganztagSessions.startsAt, endsAt: ganztagSessions.endsAt, status: ganztagSessions.status })
            .from(ganztagSessions)
            .where(and(inArray(ganztagSessions.groupId, offerIds), gte(ganztagSessions.date, today), lte(ganztagSessions.date, addDays(today, 28))))
            .orderBy(asc(ganztagSessions.date), asc(ganztagSessions.startsAt))
        : Promise.resolve([]),
      db
        .select({
          date: ganztagSessions.date,
          startsAt: ganztagSessions.startsAt,
          endsAt: ganztagSessions.endsAt,
          offer: groups.name,
          status: ganztagMarks.status,
          minutesLate: ganztagMarks.minutesLate,
          excused: ganztagMarks.excused,
        })
        .from(ganztagMarks)
        .innerJoin(ganztagSessions, eq(ganztagSessions.id, ganztagMarks.sessionId))
        .innerJoin(groups, eq(groups.id, ganztagSessions.groupId))
        .where(and(eq(ganztagMarks.studentId, t.id), gte(ganztagSessions.date, from), lte(ganztagSessions.date, today), ne(ganztagSessions.status, "ausgefallen")))
        .orderBy(desc(ganztagSessions.date), desc(ganztagSessions.startsAt)),
    ]);
    const counts = { anwesend: 0, fehlt: 0, verspaetet: 0 };
    for (const m of marks) counts[m.status]++;
    out.push({
      id: t.id,
      name: t.name,
      offers: offers.map((o) => {
        const own = upcoming.filter((s) => s.groupId === o.id);
        const next = own.find((s) => s.status === "geplant"); // ohne Ausfälle und schon erfasste (heute)
        return {
          ...o,
          next: next ? { date: next.date, startsAt: next.startsAt, endsAt: next.endsAt } : null,
          cancelled: own.filter((s) => s.status === "ausgefallen").map((s) => ({ date: s.date, startsAt: s.startsAt })),
        };
      }),
      marks: marks.map((m) => ({ ...m, excused: m.status === "fehlt" ? m.excused : null })),
      counts,
    });
    // Einsicht der Eltern wird protokolliert (wie bei den Fehlzeiten)
    if (viewer.role === "eltern") await auditRead(db, viewer.userId, "lesen.ganztag", t.id);
  }
  return out;
}
