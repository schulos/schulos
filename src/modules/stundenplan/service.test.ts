import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { listUsers } from "@/modules/verwaltung/users";
import { canViewPlan, lessonActiveOn, listSlots, planOwners, regularSlots, weekOf } from "./service";

const MO = "2026-10-05"; // Montag, KW 41 → A-Woche
const NEXT_MO = "2026-10-12"; // KW 42 → B-Woche

describe("weekOf / lessonActiveOn", () => {
  it("A-Woche = ungerade KW", () => {
    expect(weekOf(MO)).toBe("A");
    expect(weekOf(NEXT_MO)).toBe("B");
  });
  it("prüft Wochentag, Gültigkeit und A/B-Woche", () => {
    const l = { weekday: 0, week: "A", validFrom: "2026-10-01", validUntil: "2026-12-31" };
    expect(lessonActiveOn(l, MO)).toBe(true);
    expect(lessonActiveOn(l, NEXT_MO)).toBe(false); // B-Woche
    expect(lessonActiveOn(l, "2026-10-06")).toBe(false); // Dienstag
    expect(lessonActiveOn({ ...l, week: "all", validUntil: "2026-10-11" }, NEXT_MO)).toBe(false); // abgelaufen
    expect(lessonActiveOn({ ...l, week: "all", validFrom: "2026-10-06" }, MO)).toBe(false); // noch nicht gültig
  });
});

describe("Stundenplan", () => {
  let h: DbHandle;
  let mutter: string;
  let fremd: string;

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(timetableLessons); // eigener, überschaubarer Plan statt Demo-Stundenplan
    mutter = (await listUsers(h.db, { q: "Daniela Schäfer" })).rows[0]!.id;
    fremd = (await listUsers(h.db, { groupId: "g-9a", role: "schueler" })).rows[0]!.id;
    const base = { validFrom: "2026-08-01", validUntil: null };
    await h.db.insert(timetableLessons).values([
      { ...base, groupId: "g-7b", weekday: 0, periodNr: 1, subjectId: "D", teacherId: "u-jana.brandt", roomId: "112" },
      { ...base, groupId: "g-7b", weekday: 0, periodNr: 2, subjectId: "M", teacherId: "u-tobias.kleine", roomId: "112" },
      { ...base, groupId: "g-7b", weekday: 0, periodNr: 3, subjectId: "E", teacherId: "u-jana.brandt", roomId: "112", week: "A" },
      { ...base, groupId: "g-9a", weekday: 0, periodNr: 3, subjectId: "D", teacherId: "u-jana.brandt", roomId: "201", week: "B" },
      { ...base, groupId: "g-ag-schuelerzeitung", weekday: 2, periodNr: 7, subjectId: "D", teacherId: "u-jana.brandt", roomId: "BIB" },
      { groupId: "g-7b", weekday: 1, periodNr: 1, subjectId: "SP", teacherId: "u-daniel.okafor", roomId: "TH1", validFrom: "2026-08-01", validUntil: "2026-10-04" },
    ]);
  }, 60_000);
  afterAll(() => h.close());
  const p = (id: string) => loadPermissions(h.db, id);
  const week = (target: Parameters<typeof listSlots>[1], mo = MO) => listSlots(h.db, target, mo, `${mo.slice(0, 8)}${String(Number(mo.slice(8)) + 7).padStart(2, "0")}`);

  it("Schülerin sieht Stunden ihrer Klasse und AG, sortiert, A/B-Woche berücksichtigt", async () => {
    const slots = await week({ kind: "user", id: "u-lea.schaefer" });
    expect(slots.map((s) => `${s.date} ${s.periodNr} ${s.subjectId}`)).toEqual([
      "2026-10-05 1 D",
      "2026-10-05 2 M",
      "2026-10-05 3 E", // nur A-Woche
      "2026-10-07 7 D", // AG Schülerzeitung, Mittwoch
    ]);
    expect(slots[0]).toMatchObject({ startsAt: "08:00", endsAt: "08:45", teacherCode: "BRA", roomId: "112", groupName: "Klasse 7b", color: "#D9480F" });
    const b = await week({ kind: "user", id: "u-lea.schaefer" }, NEXT_MO);
    expect(b.map((s) => s.subjectId)).not.toContain("E");
  });

  it("abgelaufene Stunden verschwinden (Sport endete am 04.10.)", async () => {
    const slots = await listSlots(h.db, { kind: "group", id: "g-7b" }, "2026-09-28", "2026-10-07");
    expect(slots.filter((s) => s.subjectId === "SP").map((s) => s.date)).toEqual(["2026-09-29"]);
  });

  it("Lehrkraft sieht eigene Stunden aus allen Gruppen", async () => {
    const slots = await week({ kind: "teacher", id: "u-jana.brandt" });
    expect(slots.map((s) => `${s.groupName} ${s.periodNr}`)).toEqual(["Klasse 7b 1", "Klasse 7b 3", "AG Schülerzeitung 7"]);
    const b = await week({ kind: "teacher", id: "u-jana.brandt" }, NEXT_MO);
    expect(b.map((s) => `${s.groupName} ${s.periodNr}`)).toEqual(["Klasse 7b 1", "Klasse 9a 3", "AG Schülerzeitung 7"]);
    expect((await week({ kind: "user", id: "u-jana.brandt" })).length).toBe(3);
  });

  it("Raumplan", async () => {
    expect((await week({ kind: "room", id: "112" })).map((s) => s.subjectId)).toEqual(["D", "M", "E"]);
  });

  it("Sichtbarkeit: eigener Plan, Kinder, eigene Gruppen; Personal alles", async () => {
    const lea = await p("u-lea.schaefer");
    expect(await canViewPlan(h.db, lea, { kind: "user", id: "u-lea.schaefer" })).toBe(true);
    expect(await canViewPlan(h.db, lea, { kind: "group", id: "g-7b" })).toBe(true);
    expect(await canViewPlan(h.db, lea, { kind: "group", id: "g-9a" })).toBe(false);
    expect(await canViewPlan(h.db, lea, { kind: "user", id: fremd })).toBe(false);
    expect(await canViewPlan(h.db, lea, { kind: "teacher", id: "u-jana.brandt" })).toBe(false);
    const m = await p(mutter);
    expect((await planOwners(h.db, m)).map((o) => o.id)).toContain("u-lea.schaefer");
    expect(await canViewPlan(h.db, m, { kind: "user", id: "u-lea.schaefer" })).toBe(true);
    expect(await canViewPlan(h.db, m, { kind: "user", id: fremd })).toBe(false);
    expect(await canViewPlan(h.db, await p("u-jana.brandt"), { kind: "room", id: "112" })).toBe(true);
  });

  it("Regelplan (Druck): A- und B-Woche zusammen, Gültigkeit am Stichtag, Tage der Stichtagswoche", async () => {
    const jana = await regularSlots(h.db, { kind: "teacher", id: "u-jana.brandt" }, "2026-10-07");
    expect(jana.map((s) => `${s.date} ${s.periodNr} ${s.groupName} ${s.week}`)).toEqual([
      "2026-10-05 1 Klasse 7b all",
      "2026-10-05 3 Klasse 7b A",
      "2026-10-05 3 Klasse 9a B",
      "2026-10-07 7 AG Schülerzeitung all",
    ]);
    // Sport (bis 04.10.) gilt am 01.10. noch, am 07.10. nicht mehr
    const before = await regularSlots(h.db, { kind: "group", id: "g-7b" }, "2026-10-01");
    expect(before.map((s) => s.subjectId)).toEqual(["D", "M", "E", "SP"]);
    expect((await regularSlots(h.db, { kind: "group", id: "g-7b" }, "2026-10-07")).map((s) => s.subjectId)).toEqual(["D", "M", "E"]);
    expect((await regularSlots(h.db, { kind: "user", id: "u-lea.schaefer" }, "2026-10-07")).length).toBe(4);
  });
});
