// Jahrgang einer Schülerin/eines Schülers für die Jahrgangs-Schalter der Moduleinstellungen (Q5-14): Hausaufgaben für Eltern
// (Q5-02), Vertretungs-Info an Eltern (Q5-03). Maßgeblich ist die aktive Klasse; die Oberstufe zählt nie (F-02) – auch nicht,
// wenn ihr Jahrgang eine kleine Zahl hat (G8: EF = 10).
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { gradeLevels, groupMembers, groups } from "@/core/db/schema";

/** Jahrgang der Klasse je Schüler:in, nur Sek I. Wer in keiner Klasse oder in der Oberstufe ist, fehlt in der Map. */
export async function sek1GradeOf(db: Db, studentIds: readonly string[]): Promise<Map<string, number>> {
  if (studentIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: groupMembers.userId, level: groups.gradeLevel, stage: gradeLevels.stage })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .leftJoin(gradeLevels, eq(gradeLevels.level, groups.gradeLevel))
    .where(
      and(
        inArray(groupMembers.userId, [...studentIds]),
        eq(groupMembers.role, "member"),
        eq(groups.kind, "klasse"),
        isNull(groups.archivedAt),
        isNotNull(groups.gradeLevel),
      ),
    );
  const out = new Map<string, number>();
  for (const r of rows) {
    // ohne angelegte Jahrgänge (alte Instanz): bis 10 gilt als Sek I
    const sek1 = r.stage ? r.stage === "sek1" : r.level! <= 10;
    if (!sek1) continue;
    const prev = out.get(r.userId);
    out.set(r.userId, prev === undefined ? r.level! : Math.min(prev, r.level!));
  }
  return out;
}

/** Jahrgangs-Schalter (0 = aus): gilt für diesen Jahrgang? */
export function withinGradeSetting(grade: number | undefined, max: number): boolean {
  return max > 0 && grade !== undefined && grade <= max;
}
