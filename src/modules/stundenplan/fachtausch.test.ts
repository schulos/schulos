// SP-12: Vertretung mit abweichendem Fach („Fachtausch“, Plan §6.4) – Speichern, Anzeige, Gong, Klassenbuch, Statistik, Vorschläge.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { classbookEntries, exams, notifications, timetableLessons, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { lessonContext, saveEntry } from "@/modules/klassenbuch/service";
import { ValidationError } from "@/modules/verwaltung/users";
import { slotDisplay } from "./display";
import { ownSubstitutions } from "./mein-deputat";
import { listSlots } from "./service";
import { examSubjectsOn, saveSubstitution, substitutionsOn } from "./vertretung";
import { substitutionStats, suggestSubstitutes } from "./vorschlaege";

const MO = "2026-10-05";
const DI = "2026-10-06";

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("SP-12 Fachtausch", () => {
  let h: DbHandle;
  let sport = "";
  let deutsch = "";
  const day = (target: Parameters<typeof listSlots>[1]) => listSlots(h.db, target, MO, DI);

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(timetableLessons);
    const mo = { weekday: 0, validFrom: "2026-08-01", validUntil: null };
    const di = { ...mo, weekday: 1 };
    const rows = await h.db
      .insert(timetableLessons)
      .values([
        // ausfallende Sportstunde der 7b bei KLE
        { ...mo, groupId: "g-7b", periodNr: 3, subjectId: "SP", teacherId: "u-tobias.kleine", roomId: "106" },
        // BRA kennt die 7b (Mathe 2 Std., Deutsch 1 Std.), aber kein Sport; am Montag 1. und 5. Std → Hohlstunde
        { ...mo, groupId: "g-7b", periodNr: 1, subjectId: "M", teacherId: "u-jana.brandt", roomId: "106" },
        { ...mo, groupId: "g-7b", periodNr: 5, subjectId: "D", teacherId: "u-jana.brandt", roomId: "106" },
        { ...di, groupId: "g-7b", periodNr: 2, subjectId: "M", teacherId: "u-jana.brandt", roomId: "106" },
        // WAG kennt das Fach (Sport in der 9a), nicht die Klasse
        { ...mo, groupId: "g-9a", periodNr: 1, subjectId: "SP", teacherId: "u-sophie.wagner", roomId: "201" },
        { ...mo, groupId: "g-9a", periodNr: 5, subjectId: "SP", teacherId: "u-sophie.wagner", roomId: "201" },
        // RIC kennt Klasse und Fach → kein Fachtausch nötig
        { ...di, groupId: "g-7b", periodNr: 4, subjectId: "SP", teacherId: "u-jonas.richter", roomId: "106" },
      ])
      .returning({ id: timetableLessons.id, groupId: timetableLessons.groupId, periodNr: timetableLessons.periodNr, weekday: timetableLessons.weekday });
    sport = rows.find((r) => r.groupId === "g-7b" && r.periodNr === 3)!.id;
    deutsch = rows.find((r) => r.groupId === "g-7b" && r.periodNr === 5)!.id;
  }, 60_000);
  afterAll(() => h.close());

  it("SP-15: ist eine fachgleiche Vertretung frei (WAG und RIC unterrichten Sport), gibt es keinen Fachtausch-Vorschlag", async () => {
    const s = await suggestSubstitutes(h.db, sport, MO);
    const bra = s.find((c) => c.id === "u-jana.brandt")!;
    expect(bra.suggestedSubject).toBeNull();
    expect(bra.reasons.map((r) => r.label)).not.toContain("kann eigenes Fach geben: Mathematik");
    expect(s.every((c) => c.suggestedSubject === null)).toBe(true);
    // fachgleich und frei: oben in der Liste (unterrichtet das Fach)
    expect(s.find((c) => c.id === "u-sophie.wagner")!.reasons.map((r) => r.label)).toContain("unterrichtet das Fach");
  });

  it("Vorschlag: kennt die Klasse, nicht das Fach, und niemand mit Sport ist frei → „kann eigenes Fach geben“ (+10) mit dem Fach der meisten Wochenstunden", async () => {
    // WAG und RIC sind in der 3. Stunde belegt
    const busy = await h.db
      .insert(timetableLessons)
      .values([
        { weekday: 0, validFrom: "2026-08-01", validUntil: null, groupId: "g-9a", periodNr: 3, subjectId: "SP", teacherId: "u-sophie.wagner", roomId: "201" },
        { weekday: 0, validFrom: "2026-08-01", validUntil: null, groupId: "g-9b", periodNr: 3, subjectId: "SP", teacherId: "u-jonas.richter", roomId: "202" },
      ])
      .returning({ id: timetableLessons.id });
    const s = await suggestSubstitutes(h.db, sport, MO);
    await h.db.delete(timetableLessons).where(inArray(timetableLessons.id, busy.map((b) => b.id)));
    const bra = s.find((c) => c.id === "u-jana.brandt")!;
    expect(s[0]!.id).toBe("u-jana.brandt");
    expect(bra.reasons).toContainEqual({ label: "kann eigenes Fach geben: Mathematik", points: 10 });
    expect(bra.suggestedSubject).toEqual({ id: "M", name: "Mathematik" });
    // die fachgleichen sind belegt und stehen nicht in der Liste
    expect(s.find((c) => c.id === "u-sophie.wagner")).toBeUndefined();
    expect(s.find((c) => c.id === "u-jonas.richter")).toBeUndefined();
  });

  it("Speichern: anderes Fach nur bei Vertretung, gleiches Fach → leer, unbekanntes Fach → Fehler, Check in der DB", async () => {
    expect(await fieldErrors(saveSubstitution(h.db, "u-admin", { lessonId: sport, date: MO, kind: "substitute", substituteId: "u-jana.brandt", roomId: null, note: null, subjectId: "XX" }))).toEqual({
      subjectId: "Fach gibt es nicht",
    });
    await saveSubstitution(h.db, "u-admin", { lessonId: sport, date: MO, kind: "substitute", substituteId: "u-jana.brandt", roomId: null, note: null, subjectId: "SP" });
    expect((await h.db.select().from(timetableSubstitutions).where(eq(timetableSubstitutions.lessonId, sport)))[0]!.subjectId).toBeNull();
    await saveSubstitution(h.db, "u-admin", { lessonId: deutsch, date: MO, kind: "room", substituteId: null, roomId: "202", note: null, subjectId: "M" });
    expect((await h.db.select().from(timetableSubstitutions).where(eq(timetableSubstitutions.lessonId, deutsch)))[0]!.subjectId).toBeNull();
    await expect(h.db.update(timetableSubstitutions).set({ subjectId: "M" }).where(eq(timetableSubstitutions.lessonId, deutsch))).rejects.toThrow();

    await saveSubstitution(h.db, "u-admin", { lessonId: sport, date: MO, kind: "substitute", substituteId: "u-jana.brandt", roomId: null, note: "Hefte mitbringen", subjectId: "M" });
    expect((await h.db.select().from(timetableSubstitutions).where(eq(timetableSubstitutions.lessonId, sport)))[0]!.subjectId).toBe("M");
  });

  it("Anzeige: Klasse und Vertretung sehen „Mathematik statt Sport“, die abgebende Lehrkraft ihre Sportstunde", async () => {
    const lea = (await day({ kind: "user", id: "u-lea.schaefer" })).find((s) => s.periodNr === 3)!;
    expect(lea).toMatchObject({ subjectId: "M", subjectName: "Mathematik", change: { insteadOf: "Sport", subjectId: "M" } });
    expect(slotDisplay(lea, "student").detail).toBe("statt Sport · BRA · R 106");
    const bra = (await day({ kind: "teacher", id: "u-jana.brandt" })).find((s) => s.periodNr === 3)!;
    expect(bra).toMatchObject({ perspective: "covering", subjectName: "Mathematik" });
    expect(slotDisplay(bra, "teacher").detail).toBe("statt Sport · Klasse 7b · R 106 · für KLE");
    const kle = (await day({ kind: "teacher", id: "u-tobias.kleine" })).find((s) => s.periodNr === 3)!;
    expect(kle).toMatchObject({ perspective: "away", subjectName: "Sport", change: { subjectName: "Mathematik" } });
    expect(kle.change!.insteadOf).toBeNull();

    const list = await substitutionsOn(h.db, [MO]);
    expect(list.find((x) => x.lessonId === sport)).toMatchObject({ subjectName: "Mathematik", insteadOf: "Sport" });
    expect(list.find((x) => x.lessonId === deutsch)).toMatchObject({ subjectName: "Deutsch", insteadOf: null });
  });

  it("Gong nennt das Fach mit „statt“", async () => {
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, "u-lea.schaefer"), eq(notifications.moduleId, "stundenplan")));
    expect(gong).toHaveLength(1);
    expect(`${gong[0]!.title} ${gong[0]!.body}`).toContain("3. Std Mathematik statt Sport (7b): Vertretung – bei Jana Brandt");
  });

  it("Klassenbuch: Eintrag der Vertretungsstunde trägt das tatsächliche Fach", async () => {
    const ctx = await lessonContext(h.db, sport, MO);
    expect(ctx).toMatchObject({ subjectId: "M", subjectName: "Mathematik", teacherId: "u-jana.brandt" });
    const id = await saveEntry(h.db, await loadPermissions(h.db, "u-jana.brandt"), { lessonId: sport, date: MO, topic: "Bruchrechnung", homework: "", absences: [] }, MO);
    expect((await h.db.select().from(classbookEntries).where(eq(classbookEntries.id, id)))[0]!.subjectId).toBe("M");
  });

  it("Statistik und Mein Deputat zählen „davon mit eigenem Fach“", async () => {
    const st = await substitutionStats(h.db, "2026-08-01", "2027-07-31");
    expect(st.teachers.find((t) => t.id === "u-jana.brandt")).toMatchObject({ substitutions: 1, ownSubject: 1 });
    expect(st.groups.find((g) => g.id === "g-7b")).toMatchObject({ substituted: 1, ownSubject: 1 });
    expect(await ownSubstitutions(h.db, "u-jana.brandt", "2026-08-01", MO)).toMatchObject({ covered: 1, coveredOwnSubject: 1 });
  });

  it("Klausur-Hinweis: Arbeiten der Gruppe an dem Tag je Fach", async () => {
    await h.db.insert(exams).values({ groupId: "g-7b", subjectId: "M", kind: "klassenarbeit", title: "2. Klassenarbeit", date: MO, periodFrom: 1, periodTo: 2 });
    const byGroup = await examSubjectsOn(h.db, ["g-7b", "g-9a"], MO);
    expect(byGroup.get("g-7b")).toEqual([{ subjectId: "M", subjectName: "Mathematik", kind: "klassenarbeit" }]);
    expect(byGroup.has("g-9a")).toBe(false);
    expect((await examSubjectsOn(h.db, ["g-7b"], DI)).size).toBe(0);
  });

  it("Wechsel zurück auf Entfall löscht das Fach", async () => {
    await saveSubstitution(h.db, "u-admin", { lessonId: sport, date: MO, kind: "cancel", substituteId: null, roomId: null, note: null, subjectId: "M" });
    expect((await h.db.select().from(timetableSubstitutions).where(eq(timetableSubstitutions.lessonId, sport)))[0]).toMatchObject({ kind: "cancel", subjectId: null });
  });
});
