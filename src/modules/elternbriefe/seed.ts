// Demo-Elternbrief an die 7b (wie im Mockup): Elternabend mit Ja/Nein-Rückmeldung, 18 Familien haben bestätigt.
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groupMembers, parentChild, parentLetterGroups, parentLetterReceipts, parentLetters, users } from "@/core/db/schema";

export async function seedElternbriefe(db: Db, now = new Date()) {
  const students = await db
    .select({ id: users.id })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, "g-7b"), eq(users.role, "schueler")))
    .orderBy(asc(users.lastName));
  const parents = await db.select().from(parentChild);
  const sent = new Date(now.getTime() - 3 * 86_400_000);
  const due = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  const [letter] = await db
    .insert(parentLetters)
    .values({
      title: "Elternabend der 7b",
      body: "Liebe Eltern der 7b,\n\nwir laden Sie herzlich zum **Elternabend** ein.\n\n- Rückblick auf die ersten Wochen\n- Klassenfahrt im Frühjahr\n- Wahl der Klassenpflegschaft\n\nViele Grüße\nJana Brandt",
      authorId: "u-jana.brandt",
      responseType: "yesno",
      question: "Nehmen Sie am Elternabend teil?",
      dueDate: due,
      createdAt: sent,
    })
    .returning({ id: parentLetters.id });
  await db.insert(parentLetterGroups).values({ letterId: letter!.id, groupId: "g-7b" });
  // Lea ist die Demo-Schülerin: ihre Familie hat noch nicht reagiert
  const others = students.filter((s) => s.id !== "u-lea.schaefer");
  await db.insert(parentLetterReceipts).values(
    students.map((s) => {
      const i = others.findIndex((o) => o.id === s.id);
      const confirmed = i >= 0 && i < 18;
      const parent = parents.find((p) => p.childId === s.id)?.parentId ?? null;
      return {
        letterId: letter!.id,
        studentId: s.id,
        readAt: confirmed || i % 4 === 0 ? sent : null,
        confirmedAt: confirmed ? new Date(sent.getTime() + (i + 1) * 3_600_000) : null,
        confirmedBy: confirmed ? parent : null,
        answerYes: confirmed ? i % 5 !== 0 : null,
      };
    }),
  );
}
