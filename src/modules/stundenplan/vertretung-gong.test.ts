import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { notifications, parentChild, timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { listUsers } from "@/modules/verwaltung/users";
import { PARENTS_SUBSTITUTION } from "./settings";
import { deleteSubstitution, saveSubstitution, substitutionsOn } from "./vertretung";
import { dayMessage, type DayChange } from "./vertretung-gong";

const change = (over: Partial<DayChange>): DayChange => ({
  lessonId: "l1",
  groupId: "g-7b",
  groupName: "7b",
  periodNr: 3,
  subjectName: "Mathematik",
  kind: "cancel",
  teacherId: "t",
  substituteId: null,
  substituteName: null,
  roomId: null,
  note: null,
  ...over,
});

describe("Vertretungs-Gong (Q5-03): Tagesnachricht", () => {
  it("eine Änderung wie bisher, mehrere als Übersicht, gekoppelte Gruppen in einer Zeile, keine mehr → Regelplan", () => {
    expect(dayMessage("2026-10-13", [change({})])).toEqual({ title: "Entfall Di., 13.10., 3. Std: Mathematik (7b)", body: null });
    expect(dayMessage("2026-10-13", [change({ kind: "substitute", substituteId: "s", substituteName: "Jana Brandt", note: "Buch mitbringen" })])).toEqual({
      title: "Vertretung Di., 13.10., 3. Std: Mathematik (7b)",
      body: "bei Jana Brandt · Buch mitbringen",
    });
    const many = dayMessage("2026-10-13", [
      change({ periodNr: 5, lessonId: "l5" }),
      change({ periodNr: 1, kind: "room", roomId: "201", subjectName: "Deutsch" }),
      change({ periodNr: 3, kind: "substitute", substituteId: "s", substituteName: "Jana Brandt" }),
      change({ periodNr: 3, kind: "substitute", substituteId: "s", substituteName: "Jana Brandt", groupId: "g-7a", groupName: "7a", lessonId: "l3a" }),
    ]);
    expect(many.title).toBe("Vertretungsplan Di., 13.10.: 2 Änderungen, 1 Entfall");
    expect(many.body).toBe("1. Std Deutsch (7b): Raumänderung – Raum 201 · 3. Std Mathematik (7a, 7b): Vertretung – bei Jana Brandt · 5. Std Mathematik (7b): Entfall");
    expect(dayMessage("2026-10-13", [change({}), change({ periodNr: 4 })]).title).toBe("Vertretungsplan Di., 13.10.: 2 Stunden entfallen");
    expect(dayMessage("2026-10-13", []).title).toBe("Vertretungsplan Di., 13.10.: keine Änderungen mehr");
  });
});

describe("Vertretungs-Gong (Q5-03): gebündelt und an Eltern", () => {
  let h: DbHandle;
  let mother: string;
  const MO = "2026-10-05";
  const DI = "2026-10-06";
  const ids: Record<string, string> = {};
  const gongs = (userId: string) => h.db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.moduleId, "stundenplan")));

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(timetableLessons);
    await h.db.delete(notifications);
    const base = { validFrom: "2026-08-01", validUntil: null };
    const rows = await h.db
      .insert(timetableLessons)
      .values(
        [0, 1].flatMap((weekday) => [
          { ...base, weekday, groupId: "g-7b", periodNr: 1, subjectId: "D", teacherId: "u-jana.brandt", roomId: "106" },
          { ...base, weekday, groupId: "g-7b", periodNr: 2, subjectId: "M", teacherId: "u-tobias.kleine", roomId: "106" },
          { ...base, weekday, groupId: "g-9a", periodNr: 3, subjectId: "E", teacherId: "u-sophie.wagner", roomId: "201" },
          { ...base, weekday, groupId: "g-q1", periodNr: 4, subjectId: "E", teacherId: "u-sophie.wagner", roomId: "201" },
        ]),
      )
      .returning({ id: timetableLessons.id, weekday: timetableLessons.weekday, groupId: timetableLessons.groupId, periodNr: timetableLessons.periodNr });
    for (const r of rows) ids[`${r.weekday}-${r.groupId}-${r.periodNr}`] = r.id;
    [{ mother }] = (await h.db.select({ mother: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, "u-lea.schaefer"))) as [{ mother: string }];
  }, 60_000);
  afterAll(() => h.close());

  const cancel = (key: string, date: string) => saveSubstitution(h.db, "u-sabine.kowalski", { lessonId: ids[key]!, date, kind: "cancel", substituteId: null, roomId: null, note: null });

  it("Entfall → Elternteil bekommt genau einen Gong; weitere Änderung am selben Tag ersetzt ihn", async () => {
    await cancel("0-g-7b-1", MO);
    let g = await gongs(mother);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ title: "Entfall Mo., 5.10., 1. Std: Deutsch (7b)", readAt: null, bundleKey: `stundenplan:${MO}` });
    await h.db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.userId, mother));
    await saveSubstitution(h.db, "u-sabine.kowalski", { lessonId: ids["0-g-7b-2"]!, date: MO, kind: "room", substituteId: null, roomId: "201", note: null });
    g = await gongs(mother);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ title: "Vertretungsplan Mo., 5.10.: 1 Änderung, 1 Entfall", readAt: null });
    expect(g[0]!.body).toBe("1. Std Deutsch (7b): Entfall · 2. Std Mathematik (7b): Raumänderung – Raum 201");
    // Schülerin und Lehrkraft ebenso je eine Nachricht; die handelnde Person keine
    expect(await gongs("u-lea.schaefer")).toHaveLength(1);
    expect((await gongs("u-tobias.kleine")).map((n) => n.title)).toEqual(["Raumänderung Mo., 5.10., 2. Std: Mathematik (7b)"]);
    expect(await gongs("u-sabine.kowalski")).toHaveLength(0);
  });

  it("Zurücknehmen erneuert die Tagesnachricht", async () => {
    const sub = (await substitutionsOn(h.db, [MO])).find((s) => s.lessonId === ids["0-g-7b-1"])!;
    await deleteSubstitution(h.db, "u-sabine.kowalski", sub.id);
    const g = await gongs(mother);
    expect(g).toHaveLength(1);
    expect(g[0]!.title).toBe("Raumänderung Mo., 5.10., 2. Std: Mathematik (7b)");
    expect((await gongs("u-jana.brandt")).map((n) => n.title)).toEqual(["Vertretungsplan Mo., 5.10.: keine Änderungen mehr"]);
  });

  it("anderer Tag = eigene Nachricht; Kinder in zwei Klassen → trotzdem eine Nachricht je Tag", async () => {
    const [ninth] = (await listUsers(h.db, { groupId: "g-9a", role: "schueler" })).rows;
    await h.db.insert(parentChild).values({ parentId: mother, childId: ninth!.id }).onConflictDoNothing();
    await cancel("1-g-7b-1", DI);
    await cancel("1-g-9a-3", DI);
    const di = (await gongs(mother)).filter((n) => n.bundleKey === `stundenplan:${DI}`);
    expect(di).toHaveLength(1);
    expect(di[0]!.title).toBe("Vertretungsplan Di., 6.10.: 2 Stunden entfallen");
    expect(di[0]!.body).toBe("1. Std Deutsch (7b): Entfall · 3. Std Englisch (9a): Entfall");
    expect(await gongs(mother)).toHaveLength(2);
  });

  it("GATE-031 S-05: Notiz der Vertretung nur an Schüler:innen und Lehrkräfte, nicht an Eltern", async () => {
    await h.db.delete(notifications);
    await saveSubstitution(h.db, "u-sabine.kowalski", { lessonId: ids["0-g-7b-1"]!, date: "2026-10-12", kind: "cancel", substituteId: null, roomId: null, note: "Fr. B. erkrankt" });
    const day = (rows: { bundleKey: string | null; body: string | null; title: string }[]) => rows.filter((n) => n.bundleKey === "stundenplan:2026-10-12");
    expect(day(await gongs("u-lea.schaefer"))[0]!.body).toBe("Fr. B. erkrankt");
    const m = day(await gongs(mother));
    expect(m).toHaveLength(1);
    expect(m[0]!.title).toBe("Entfall Mo., 12.10., 1. Std: Deutsch (7b)");
    expect(m[0]!.body).toBeNull();
    expect(JSON.stringify(await gongs(mother))).not.toContain("erkrankt");
  });

  it("Oberstufe nie; Einstellung „aus“ bzw. unter dem Jahrgang → keine Eltern", async () => {
    const [q1] = (await listUsers(h.db, { groupId: "g-q1", role: "schueler" })).rows;
    const [q1Parent] = await h.db.select({ id: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, q1!.id));
    await cancel("1-g-q1-4", DI);
    expect(await gongs(q1!.id)).toHaveLength(1); // die Schülerin selbst schon
    expect(await gongs(q1Parent!.id)).toHaveLength(0);

    await h.db.delete(notifications);
    await writeModuleSetting(h.db, PARENTS_SUBSTITUTION, "6");
    await saveSubstitution(h.db, "u-sabine.kowalski", { lessonId: ids["1-g-7b-2"]!, date: DI, kind: "room", substituteId: null, roomId: "110", note: null });
    expect(await gongs(mother)).toHaveLength(0);
    expect(await gongs("u-lea.schaefer")).toHaveLength(1);
    await writeModuleSetting(h.db, PARENTS_SUBSTITUTION, "0");
    await saveSubstitution(h.db, "u-sabine.kowalski", { lessonId: ids["1-g-9a-3"]!, date: DI, kind: "room", substituteId: null, roomId: "110", note: null });
    expect(await gongs(mother)).toHaveLength(0);
    await writeModuleSetting(h.db, PARENTS_SUBSTITUTION, "10");
  });
});
