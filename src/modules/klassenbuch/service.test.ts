import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { classbookAbsences, classbookEntries, schoolClosures, timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { saveSubstitution } from "@/modules/stundenplan/vertretung";
import { listUsers, ValidationError } from "@/modules/verwaltung/users";
import { absenceSummary, canRead, canReadClass, classWeek, lessonContext, mySlots, readableClasses, saveEntry } from "./service";

const MO = "2026-10-05";
const TODAY = "2026-10-07";

describe("Klassenbuch", () => {
  let h: DbHandle;
  const ids: Record<string, string> = {};
  let students: string[] = [];
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(classbookEntries); // Demo-Klassenbuch raus – eigener, überschaubarer Plan
    await h.db.delete(timetableLessons);
    const base = { weekday: 0, validFrom: "2026-08-01", validUntil: null };
    const rows = await h.db
      .insert(timetableLessons)
      .values([
        { ...base, groupId: "g-7b", periodNr: 1, subjectId: "D", teacherId: "u-jana.brandt", roomId: "106" },
        { ...base, groupId: "g-7b", periodNr: 2, subjectId: "M", teacherId: "u-tobias.kleine", roomId: "106" },
        { ...base, groupId: "g-7b", periodNr: 3, subjectId: "E", teacherId: "u-jana.brandt", roomId: "106" },
      ])
      .returning({ id: timetableLessons.id, periodNr: timetableLessons.periodNr });
    for (const r of rows) ids[`p${r.periodNr}`] = r.id;
    students = (await listUsers(h.db, { groupId: "g-7b", role: "schueler" })).rows.map((r) => r.id);
  }, 60_000);
  afterAll(() => h.close());

  it("Kontext: Schüler:innen der Gruppe, deutsch sortiert", async () => {
    const ctx = await lessonContext(h.db, ids.p1!, MO);
    expect(ctx.students).toHaveLength(25);
    expect(ctx.teacherId).toBe("u-jana.brandt");
    const names = ctx.students.map((s) => s.name.split(" ").at(-1)!);
    expect([...names].sort((a, b) => a.localeCompare(b, "de"))).toEqual(names);
  });

  it("Lehrkraft der Stunde trägt Thema, Hausaufgabe und Fehlzeiten ein", async () => {
    await saveEntry(
      h.db,
      await p("u-jana.brandt"),
      {
        lessonId: ids.p1!,
        date: MO,
        topic: "Erörterung: Argumente sammeln",
        homework: "Gliederung fertigstellen",
        absences: [
          { studentId: students[0]!, kind: "absent", minutesLate: null },
          { studentId: students[1]!, kind: "late", minutesLate: 10 },
        ],
      },
      TODAY,
    );
    const ctx = await lessonContext(h.db, ids.p1!, MO);
    expect(ctx.entry).toMatchObject({ topic: "Erörterung: Argumente sammeln", homework: "Gliederung fertigstellen", teacherId: "u-jana.brandt" });
    expect(ctx.absences.get(students[1]!)).toMatchObject({ kind: "late", minutesLate: 10 });
  });

  it("erneutes Speichern gleicht Fehlzeiten ab und behält „entschuldigt“", async () => {
    await h.db.update(classbookAbsences).set({ excused: true }).where(eq(classbookAbsences.studentId, students[0]!));
    await saveEntry(
      h.db,
      await p("u-jana.brandt"),
      { lessonId: ids.p1!, date: MO, topic: "Erörterung", homework: "", absences: [{ studentId: students[0]!, kind: "absent", minutesLate: null }] },
      TODAY,
    );
    const ctx = await lessonContext(h.db, ids.p1!, MO);
    expect([...ctx.absences.keys()]).toEqual([students[0]]);
    expect(ctx.absences.get(students[0]!)!.excused).toBe(true);
    expect(ctx.entry!.homework).toBeNull();
  });

  it("„fällig am“ (Q5-27): Schultag ab morgen, nach der Stunde; leer bzw. ohne Hausaufgabe = null", async () => {
    const jana = await p("u-jana.brandt");
    const keep = [{ studentId: students[0]!, kind: "absent" as const, minutesLate: null }];
    const save = (homework: string, homeworkDue: string) => saveEntry(h.db, jana, { lessonId: ids.p1!, date: MO, topic: "Erörterung", homework, homeworkDue, absences: keep }, TODAY);
    const due = async () => (await lessonContext(h.db, ids.p1!, MO)).entry!.homeworkDue;
    await h.db.insert(schoolClosures).values({ kind: "frei", name: "Pädagogischer Tag", startsOn: "2026-10-20", endsOn: "2026-10-20" });
    await save("Gliederung", "2026-10-09");
    expect(await due()).toBe("2026-10-09");
    // unverändert gespeichert bleibt das Datum, auch wenn es inzwischen nicht mehr „ab morgen“ wäre
    await saveEntry(h.db, jana, { lessonId: ids.p1!, date: MO, topic: "Erörterung", homework: "Gliederung", homeworkDue: "2026-10-09", absences: keep }, "2026-10-09");
    expect(await due()).toBe("2026-10-09");
    for (const [d, msg] of [
      ["2026-10-07", /frühestens morgen/],
      ["2026-10-05", /nach der Stunde/],
      ["2026-10-10", /Schultag/], // Samstag
      ["2026-10-20", /Schultag/], // unterrichtsfrei (unten eingetragen)
      ["2026-12-31", /Höchstens/],
      ["2026-02-30", /ungültig/],
    ] as const) {
      await expect(save("Gliederung", d)).rejects.toThrow(ValidationError);
      await save("Gliederung", d).catch((e: ValidationError) => expect(e.fieldErrors.homeworkDue).toMatch(msg));
    }
    await save("Gliederung", "");
    expect(await due()).toBeNull();
    await save("", "2026-10-09"); // ohne Hausaufgabe kein Datum
    expect(await due()).toBeNull();
  });

  it("nur die haltende Lehrkraft schreibt – bei Vertretung die Vertretung; Entfall und Zukunft gehen nicht", async () => {
    const input = { lessonId: ids.p2!, date: MO, topic: "Brüche", homework: "", absences: [] };
    await expect(saveEntry(h.db, await p("u-jana.brandt"), input, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    await saveSubstitution(h.db, "u-admin", { lessonId: ids.p2!, date: MO, kind: "substitute", substituteId: "u-jana.brandt", roomId: null, note: null });
    await saveEntry(h.db, await p("u-jana.brandt"), input, TODAY);
    await expect(saveEntry(h.db, await p("u-tobias.kleine"), input, TODAY)).rejects.toBeInstanceOf(ForbiddenError);

    await saveSubstitution(h.db, "u-admin", { lessonId: ids.p3!, date: MO, kind: "cancel", substituteId: null, roomId: null, note: null });
    await expect(lessonContext(h.db, ids.p3!, MO)).rejects.toBeInstanceOf(ValidationError);
    await expect(saveEntry(h.db, await p("u-jana.brandt"), { ...input, lessonId: ids.p1!, date: "2026-10-12" }, TODAY)).rejects.toBeInstanceOf(ValidationError);
  });

  it("validiert Thema und Verspätungsminuten", async () => {
    try {
      await saveEntry(h.db, await p("u-jana.brandt"), { lessonId: ids.p1!, date: MO, topic: " ", homework: "", absences: [{ studentId: students[2]!, kind: "late", minutesLate: null }] }, TODAY);
      throw new Error("erwartet ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(Object.keys((err as ValidationError).fieldErrors).sort()).toEqual([`late-${students[2]}`, "topic"]);
    }
  });

  it("Lesen: Klassenleitung ja, fremde Lehrkraft nein; meine Stunden mit Status", async () => {
    const ctx = await lessonContext(h.db, ids.p1!, MO);
    expect(canRead(await p("u-jana.brandt"), ctx)).toBe(true);
    expect(canRead(await p("u-daniel.okafor"), ctx)).toBe(false);
    const mine = await mySlots(h.db, "u-jana.brandt", MO);
    expect(mine.map((s) => `${s.periodNr} ${s.hasEntry}`)).toEqual(["1 true", "2 true"]); // 3. Std entfällt
  });

  it("Wochenraster der Klasse: eingetragen, fehlt, entfallen, Zukunft", async () => {
    const week = await classWeek(h.db, "g-7b", MO, "2026-10-05");
    expect(week.filter((c) => c.date === MO).map((c) => `${c.periodNr} ${c.status}`)).toEqual(["1 done", "2 done", "3 cancelled"]);
    expect(week.find((c) => c.periodNr === 1)!.entry!.topic).toBe("Erörterung");
    const next = await classWeek(h.db, "g-7b", "2026-10-12", "2026-10-05");
    expect(new Set(next.map((c) => c.status))).toEqual(new Set(["future"]));
    const past = await classWeek(h.db, "g-7b", "2026-09-28", "2026-10-05");
    expect(new Set(past.map((c) => c.status))).toEqual(new Set(["missing"]));
  });

  it("Fehlzeiten-Summen je Schüler:in, meiste zuerst", async () => {
    // zweite Stunde: students[0] fehlt (offen), students[3] verspätet
    await saveEntry(
      h.db,
      await p("u-jana.brandt"),
      {
        lessonId: ids.p2!,
        date: MO,
        topic: "Brüche",
        homework: "",
        absences: [
          { studentId: students[0]!, kind: "absent", minutesLate: null },
          { studentId: students[3]!, kind: "late", minutesLate: 5 },
        ],
      },
      TODAY,
    );
    const sums = await absenceSummary(h.db, "g-7b", "2026-08-01", TODAY);
    expect(sums).toHaveLength(25);
    expect(sums[0]).toMatchObject({ studentId: students[0], absent: 2, excused: 1, open: 1, unexcused: 0 });
    expect(sums.find((x) => x.studentId === students[3])).toMatchObject({ absent: 0, lateCount: 1, lateMinutes: 5 });
    expect((await absenceSummary(h.db, "g-7b", "2026-10-06", TODAY))[0]!.absent).toBe(0);
  });

  it("Klassenübersicht: Klassenleitung ihre Klasse, Schulleitung alle", async () => {
    const jana = await p("u-jana.brandt");
    expect((await readableClasses(h.db, jana)).map((g) => g.id)).toEqual(["g-7b"]);
    expect(canReadClass(jana, "g-9a")).toBe(false);
    const sl = await p("u-petra.lindner");
    expect((await readableClasses(h.db, sl)).length).toBe(15);
    expect(canReadClass(sl, "g-9a")).toBe(true);
  });

  it("Kopplung: Thema und Hausaufgabe auf Wunsch auch für die anderen Gruppen derselben Lehrkraft", async () => {
    const base = { weekday: 0, periodNr: 6, validFrom: "2026-08-01", validUntil: null, couplingId: "k-kb" };
    const rows = await h.db
      .insert(timetableLessons)
      .values([
        { ...base, groupId: "g-7b", subjectId: "REL", teacherId: "u-jonas.richter", roomId: "110" },
        { ...base, groupId: "g-7a", subjectId: "REL", teacherId: "u-jonas.richter", roomId: "110" },
        { ...base, groupId: "g-7b", subjectId: "D", teacherId: "u-petra.lindner", roomId: "112" },
      ])
      .returning({ id: timetableLessons.id, groupId: timetableLessons.groupId, subjectId: timetableLessons.subjectId });
    const own = rows.find((r) => r.groupId === "g-7b" && r.subjectId === "REL")!.id;
    const other = rows.find((r) => r.groupId === "g-7a")!.id;
    const ctx = await lessonContext(h.db, own, MO);
    expect(ctx.coupled.map((c) => c.groupName)).toEqual(["Klasse 7a"]);
    await saveEntry(h.db, await p("u-jonas.richter"), { lessonId: own, date: MO, topic: "Gleichnisse", homework: "S. 12", absences: [], alsoCoupled: true }, TODAY);
    const entries = await h.db.select().from(classbookEntries).where(eq(classbookEntries.topic, "Gleichnisse"));
    expect(entries.map((e) => e.lessonId).sort()).toEqual([own, other].sort());
    expect(entries.find((e) => e.lessonId === other)).toMatchObject({ groupId: "g-7a", homework: "S. 12", subjectId: "REL" });
    // ohne Häkchen bleibt der andere Eintrag unverändert; Teamteaching-Partner (andere Lehrkraft) nie
    await saveEntry(h.db, await p("u-jonas.richter"), { lessonId: own, date: MO, topic: "Gleichnisse II", homework: "", absences: [] }, TODAY);
    const [o] = await h.db.select().from(classbookEntries).where(eq(classbookEntries.lessonId, other));
    expect(o!.topic).toBe("Gleichnisse");
    expect((await h.db.select().from(classbookEntries).where(eq(classbookEntries.groupId, "g-7b"))).some((e) => e.subjectId === "D" && e.periodNr === 6)).toBe(false);
  });
});
