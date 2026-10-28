// SP3-06: **nur für Tests** – Schritt 7 des Fahrplans für Testdaten erfüllen, damit Tests des Veröffentlichens (SP3-04/05) weiter den
// Übertrag prüfen statt der Diagnose. Fehler „mehr verplant als beauftragt“ (die Tests legen Stunden ohne Lehrauftrag an) werden über
// mehr beauftragte Stunden behoben, alle Warnungen mit einer Begründung quittiert. Andere Fehler bleiben – dann scheitert der Test zu Recht.
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { acknowledgeOpenWarnings, gateProblem, publishGate } from "./fahrplan";
import { getVersion } from "./planversionen";
import { timetableAssignments } from "./schema";

export async function clearPublishGate(db: Db, actorId: string, versionId: string, today: string): Promise<void> {
  for (let round = 0; round < 6; round++) {
    const gate = await publishGate(db, (await getVersion(db, versionId))!, today);
    const over = gate.errors.filter((e) => e.category === "open" && e.assignmentId);
    if (!over.length) break;
    for (const e of over) await db.update(timetableAssignments).set({ hours: sql`${timetableAssignments.hours} + 1` }).where(eq(timetableAssignments.id, e.assignmentId!));
  }
  await acknowledgeOpenWarnings(db, actorId, versionId, "im Test bekannt", today);
  const problem = gateProblem(await publishGate(db, (await getVersion(db, versionId))!, today));
  if (problem) throw new Error(`Testdaten: ${problem}`);
}
