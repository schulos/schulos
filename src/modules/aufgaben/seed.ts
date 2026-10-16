import { and, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groupMembers, taskGroups, tasks, taskSubmissions, users } from "@/core/db/schema";

const H = 3_600_000;

/** Zwei Demo-Aufgaben der 7b: eine laufende (viele Abgaben, ohne Feedback) und eine bewertete. */
export async function seedAufgaben(db: Db, now = new Date()) {
  const students = (
    await db
      .select({ id: users.id })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groupMembers.groupId, "g-7b"), eq(users.role, "schueler")))
      .orderBy(users.id)
  ).map((s) => s.id);
  const others = students.filter((s) => s !== "u-lea.schaefer");

  await db.insert(tasks).values([
    {
      id: "task-eroerterung",
      title: "Erörterung „Handyverbot an Schulen“",
      description: "Schreibe eine **dialektische Erörterung** (ca. 1–2 Seiten).\n\n- Einleitung mit Hinführung\n- Pro- und Contra-Argumente mit Beispielen\n- Eigene Stellungnahme",
      authorId: "u-jana.brandt",
      startsAt: new Date(now.getTime() - 96 * H),
      dueAt: new Date(now.getTime() + 72 * H),
      submissionType: "text",
    },
    {
      id: "task-lektuere",
      title: "Lesetagebuch Kapitel 1–3",
      description: "Fasse jedes Kapitel in 3–5 Sätzen zusammen.",
      authorId: "u-jana.brandt",
      startsAt: new Date(now.getTime() - 14 * 24 * H),
      dueAt: new Date(now.getTime() - 7 * 24 * H),
      submissionType: "text",
    },
  ]);
  await db.insert(taskGroups).values([
    { taskId: "task-eroerterung", groupId: "g-7b" },
    { taskId: "task-lektuere", groupId: "g-7b" },
  ]);

  // Laufende Aufgabe: 18 Abgaben (Lea noch nicht – sie sieht sie unter „Fällig")
  await db.insert(taskSubmissions).values(
    others.slice(0, 18).map((studentId, i) => ({
      taskId: "task-eroerterung",
      studentId,
      text: "Meine Erörterung …",
      submittedAt: new Date(now.getTime() - (40 - i) * H),
    })),
  );
  // Bewertete Aufgabe: alle außer zwei, Lea mit Feedback
  const grades = ["1-", "2+", "2", "2-", "3+", "3"];
  await db.insert(taskSubmissions).values(
    students
      .filter((_, i) => i < students.length - 2)
      .map((studentId, i) => ({
        taskId: "task-lektuere",
        studentId,
        text: "Kapitel 1: …",
        submittedAt: new Date(now.getTime() - (8 * 24 + i) * H),
        feedback: studentId === "u-lea.schaefer" ? "Sehr genau gelesen – Kapitel 3 etwas knapp." : "Gut zusammengefasst.",
        grade: grades[i % grades.length]!,
        returnedAt: new Date(now.getTime() - 5 * 24 * H),
      })),
  );
}
