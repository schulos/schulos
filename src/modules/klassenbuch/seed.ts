// Demo-Klassenbuch der 7b: Einträge für die vergangenen Schultage (Vorwoche + diese Woche bis gestern),
// ein paar bewusst fehlende Einträge und typische Fehlzeiten.
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { classbookAbsences, classbookEntries, groupMembers, users } from "@/core/db/schema";
import { addDays, mondayOf, toBerlinDate } from "@/core/time";
import { listSlots } from "@/modules/stundenplan/service";

const TOPICS: Record<string, string[]> = {
  D: ["Erörterung: Argumente sammeln", "Erörterung: Gliederung", "Kurzgeschichte „Das Brot“", "Kommasetzung bei Nebensätzen"],
  M: ["Brüche erweitern und kürzen", "Prozentrechnung: Grundwert", "Terme vereinfachen", "Übung: Textaufgaben"],
  E: ["Simple past vs. present perfect", "Unit 2: Text „A new school“", "Vocabulary test", "Writing an email"],
  F: ["Les verbes en -er", "Dialog: Au café", "Vokabeln Unité 2"],
  BI: ["Der Feldhase: Steckbrief", "Wirbeltiere im Vergleich", "Mikroskopieren: Zwiebelhaut"],
  PH: ["Optik: Licht und Schatten", "Reflexionsgesetz", "Versuch: Lochkamera"],
  GE: ["Das Leben im Mittelalter", "Burgen und Ritter", "Die Stadt im Mittelalter"],
  EK: ["Klimazonen der Erde", "Arbeit mit dem Atlas"],
  SP: ["Ballspiele: Basketball", "Zirkeltraining", "Leichtathletik: Weitsprung"],
  KU: ["Farbenlehre: Komplementärfarben", "Collage"],
  MU: ["Instrumentenkunde", "Rhythmus-Übungen"],
  REL: ["Gerechtigkeit", "Weltreligionen: Judentum"],
};

export async function seedKlassenbuch(db: Db, now = new Date()) {
  const today = toBerlinDate(now);
  // Letzte Woche mit Unterricht (Ferien: bis zu acht Wochen zurück), sonst fehlt das Demo-Klassenbuch nach den Ferien
  let slots: Awaited<ReturnType<typeof listSlots>> = [];
  for (let back = 1; back <= 8 && slots.length === 0; back++) {
    const from = addDays(mondayOf(today), -7 * back);
    slots = (await listSlots(db, { kind: "group", id: "g-7b" }, from, back === 1 ? today : addDays(from, 7))).filter((s) => s.change?.kind !== "cancel");
  }
  if (slots.length === 0) return;
  const students = await db
    .select({ id: users.id })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, "g-7b"), eq(users.role, "schueler")))
    .orderBy(asc(users.lastName));
  const sick = students.find((s) => s.id !== "u-lea.schaefer")!.id; // zwei Tage krank, entschuldigt
  const skipped = students.filter((s) => s.id !== "u-lea.schaefer")[3]!.id; // ein Tag, noch offen
  const late = students.filter((s) => s.id !== "u-lea.schaefer")[5]!.id;
  const days = [...new Set(slots.map((s) => s.date))].sort();
  const counter = new Map<string, number>();

  for (const [i, s] of slots.entries()) {
    if (i % 13 === 7) continue; // ein paar Einträge fehlen – so sieht die Klassenleitung, wo nachzutragen ist
    const n = counter.get(s.subjectId) ?? 0;
    counter.set(s.subjectId, n + 1);
    const list = TOPICS[s.subjectId] ?? ["Unterricht"];
    const teacherId = s.change?.kind === "substitute" ? s.change.substituteId : s.teacherId;
    const [entry] = await db
      .insert(classbookEntries)
      .values({
        lessonId: s.lessonId,
        date: s.date,
        groupId: s.groupId,
        periodNr: s.periodNr,
        subjectId: s.subjectId,
        teacherId,
        topic: list[n % list.length]!,
        homework: n % 3 === 0 ? "Aufgaben im Heft fertigstellen" : null,
      })
      .returning({ id: classbookEntries.id });
    const absences: (typeof classbookAbsences.$inferInsert)[] = [];
    if (s.date === days[0] || s.date === days[1]) absences.push({ entryId: entry!.id, studentId: sick, kind: "absent", excused: true });
    if (s.date === days.at(-1)) absences.push({ entryId: entry!.id, studentId: skipped, kind: "absent" });
    if (s.date === days[2] && s.periodNr === Math.min(...slots.filter((x) => x.date === days[2]).map((x) => x.periodNr))) {
      absences.push({ entryId: entry!.id, studentId: late, kind: "late", minutesLate: 10 });
    }
    if (absences.length) await db.insert(classbookAbsences).values(absences);
  }
}
