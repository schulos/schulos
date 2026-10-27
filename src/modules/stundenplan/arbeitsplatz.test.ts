// VT-03a: Vertretungs-Arbeitsplatz – Ampel der offenen Stunden, Tagwechsel, Kopfleiste „Gong geplant …“, Kontext der vorgeschlagenen
// Lehrkraft (Hohl-/Randstunde, Stundenzahl, Tagesregel, Bereitschaft) und aufgehobene Vertretungen mit Verlauf.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { timetableLessons, timetableStandby, timetableSubstitutionChanges, timetableSubstitutionDays, timetableSubstitutions, timetableTeacherDayRules } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { OPEN_CALENDAR } from "@/core/school/calendar";
import { fromBerlinLocal } from "@/core/time";
import { loadPermissions } from "@/core/permissions";
import { buildTeacherDay, classDay, dayPosition, gongSummary, lessonGroup, needUrgency, openNeighbours, removedLessons, removedSubstitutions, stepSchoolDay, teacherDayContext } from "./arbeitsplatz";
import { deleteSubstitution, saveSubstitution } from "./vertretung";
import { substitutionHistory } from "./vertretung-historie";
import { schoolYearOn } from "./vertretung-regeln";

const MO = "2026-10-05";
const BRA = "u-jana.brandt";
const KLE = "u-tobias.kleine";
const PLANUNG = "u-frank.schulte";

describe("VT-03a rein", () => {
  const at = (local: string) => fromBerlinLocal(local);
  it("Ampel: dringend bis zwei Stunden vorher und während der Stunde, sonst heute/noch Zeit, vorbei nach dem Ende, geregelt", () => {
    const n = { date: MO, startsAt: "10:00:00", endsAt: "10:45:00", open: true };
    expect(needUrgency(n, at(`${MO}T07:30`))).toBe("heute");
    expect(needUrgency(n, at(`${MO}T08:00`))).toBe("dringend");
    expect(needUrgency(n, at(`${MO}T10:20`))).toBe("dringend");
    expect(needUrgency(n, at(`${MO}T10:45`))).toBe("vorbei");
    expect(needUrgency(n, at("2026-10-02T12:00"))).toBe("spaeter");
    expect(needUrgency({ ...n, open: false }, at(`${MO}T10:00`))).toBe("geregelt");
    expect(needUrgency(n, at(`${MO}T07:30`), 180)).toBe("dringend");
  });

  it("Tagwechsel überspringt das Wochenende", () => {
    expect(stepSchoolDay(OPEN_CALENDAR, "2026-10-09", 1)).toBe("2026-10-12");
    expect(stepSchoolDay(OPEN_CALENDAR, "2026-10-12", -1)).toBe("2026-10-09");
    expect(stepSchoolDay(OPEN_CALENDAR, MO, 1)).toBe("2026-10-06");
  });

  it("VT-03b: Nachbarn der offenen Stunden für ↑/↓ und „nächste offene Stunde“ nach dem Speichern", () => {
    const ids = ["a", "b", "c"];
    expect(openNeighbours(ids, "b")).toEqual({ prev: "a", next: "c", afterSave: "c" });
    expect(openNeighbours(ids, "a")).toEqual({ prev: null, next: "b", afterSave: "b" });
    // letzte offene Stunde: nach dem Speichern zurück zur ersten anderen, ↓ hat kein Ziel
    expect(openNeighbours(ids, "c")).toEqual({ prev: "b", next: null, afterSave: "a" });
    // geregelte (nicht mehr offene) Stunde: ↓ springt zur ersten offenen
    expect(openNeighbours(ids, "z")).toEqual({ prev: null, next: "a", afterSave: "a" });
    expect(openNeighbours(["a"], "a")).toEqual({ prev: null, next: null, afterSave: null });
    expect(openNeighbours([], null)).toEqual({ prev: null, next: null, afterSave: null });
  });

  it("Kopfleiste: nächster Termin mit allen Personen, heute nur die Uhrzeit, fällig ohne Uhrzeit", () => {
    const now = at(`${MO}T12:00`);
    expect(gongSummary([], now)).toBeNull();
    expect(gongSummary([{ dueAt: at(`${MO}T18:00`), people: 30 }, { dueAt: at(`${MO}T18:00`), people: 4 }], now)).toBe("Gong geplant 18:00 (34)");
    expect(gongSummary([{ dueAt: at("2026-10-06T18:00"), people: 2 }], now)).toBe("Gong geplant Di., 18:00 (2)");
    expect(gongSummary([{ dueAt: at(`${MO}T11:59`), people: 3 }], now)).toBe("Gong fällig (3)");
  });

  it("Lage im Tag wie in den Vorschlägen", () => {
    expect(dayPosition([], 3)).toBe("hat sonst frei");
    expect(dayPosition([1, 5], 3)).toBe("Hohlstunde");
    expect(dayPosition([1, 2], 3)).toBe("Randstunde");
    expect(dayPosition([4, 5], 3)).toBe("Randstunde");
  });

  it("Tag einer Lehrkraft: Stundenzahl ohne Entfall, Bereitschaft, Aufsicht, Tagesregel", () => {
    const periods = [1, 2, 3, 4, 5].map((nr) => ({ nr, startsAt: `0${7 + nr}:00:00` }));
    const day = buildTeacherDay({
      periods,
      entries: [
        { periodNr: 1, label: "Mathe · 7b", held: true, covering: false },
        { periodNr: 2, label: "Deutsch · 8a · Entfällt", held: false, covering: false },
        { periodNr: 5, label: "Bio · 9a · Vertretung", held: true, covering: true },
      ],
      standby: [3],
      duties: [{ afterPeriod: 2, label: "Aufsicht Hof (2. Pause)" }],
      candidate: 3,
      rule: { maxPerDay: 2, maxDays: null },
    });
    expect(day.held).toBe(2);
    expect(day.position).toBe("Hohlstunde");
    expect(day.busy).toBe(false);
    expect(day.standbyNow).toBe(true);
    expect(day.rule).toBe("höchstens 2 Std./Tag");
    expect(day.overRule).toBe(true);
    expect(day.periods.find((p) => p.nr === 2)!.duties).toEqual(["Aufsicht Hof (2. Pause)"]);
    expect(day.periods.find((p) => p.nr === 3)!.candidate).toBe(true);
    expect(day.periods[0]!.startsAt).toBe("08:00");
    const busy = buildTeacherDay({ periods, entries: [{ periodNr: 3, label: "x", held: true, covering: false }], standby: [], duties: [], candidate: 3, rule: { maxPerDay: 1, maxDays: null } });
    expect(busy.busy).toBe(true);
    expect(busy.position).toBeNull();
    expect(busy.overRule).toBe(false);
  });

  it("Aufgehoben: letzter Eintrag ist ein Aufheben und die Stunde hat keine Änderung mehr", () => {
    const t = (m: number) => new Date(Date.UTC(2026, 9, 5, 8, m));
    const h = [
      { lessonId: "a", action: "create" as const, createdAt: t(1), actorId: "p" },
      { lessonId: "a", action: "delete" as const, createdAt: t(2), actorId: "p" },
      { lessonId: "b", action: "delete" as const, createdAt: t(1), actorId: null },
      { lessonId: "b", action: "create" as const, createdAt: t(3), actorId: null },
      { lessonId: "c", action: "delete" as const, createdAt: t(4), actorId: null },
      { lessonId: null, action: "delete" as const, createdAt: t(5), actorId: null },
    ];
    expect(removedLessons(h, new Set(["b", "c"]))).toEqual([{ lessonId: "a", removedAt: t(2), actorId: "p" }]);
  });
});

describe("VT-03a Kontext", () => {
  let h: DbHandle;
  const ids: Record<string, string> = {};
  const mo = { weekday: 0, validFrom: "2026-08-01", validUntil: null };
  const periods = [1, 2, 3, 4, 5, 6].map((nr) => ({ nr, startsAt: "08:00:00" }));

  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  beforeEach(async () => {
    await h.db.delete(timetableSubstitutions);
    await h.db.delete(timetableSubstitutionChanges);
    await h.db.delete(timetableSubstitutionDays);
    await h.db.delete(timetableStandby);
    await h.db.delete(timetableTeacherDayRules);
    await h.db.delete(timetableLessons);
    const rows = await h.db
      .insert(timetableLessons)
      .values([
        { ...mo, groupId: "g-7b", periodNr: 1, subjectId: "SP", teacherId: KLE, roomId: "106" },
        { ...mo, groupId: "g-7b", periodNr: 4, subjectId: "BI", teacherId: BRA, roomId: "106" },
        { ...mo, groupId: "g-7b", periodNr: 5, subjectId: "D", teacherId: BRA, roomId: "106" },
      ])
      .returning({ id: timetableLessons.id, groupId: timetableLessons.groupId, periodNr: timetableLessons.periodNr });
    for (const r of rows) ids[`${r.groupId.slice(2)}-${r.periodNr}`] = r.id;
  });

  it("Tag der Lehrkraft: Randstunde, Stundenzahl, Tagesregel und Bereitschaft; zu der Zeit selbst im Unterricht", async () => {
    const year = (await schoolYearOn(h.db, MO))!;
    await h.db.insert(timetableStandby).values({ schoolYearId: year.id, weekday: 0, periodNr: 2, teacherId: BRA });
    await h.db.insert(timetableTeacherDayRules).values({ schoolYearId: year.id, teacherId: BRA, maxPerDay: 2, maxDays: null });
    const ctx = (await teacherDayContext(h.db, BRA, MO, 2, periods))!;
    expect(ctx.code).toBe("BRA");
    expect(ctx.held).toBe(2);
    expect(ctx.position).toBe("Randstunde");
    expect(ctx.standbyNow).toBe(true);
    expect(ctx.rule).toBe("höchstens 2 Std./Tag");
    expect(ctx.overRule).toBe(true);
    expect(ctx.absent).toBe(false);
    const busy = (await teacherDayContext(h.db, BRA, MO, 4, periods))!;
    expect(busy.busy).toBe(true);
    expect(busy.position).toBeNull();
    // keine Lehrkraft → kein Kontext
    expect(await teacherDayContext(h.db, "u-lea.schaefer", MO, 2, periods)).toBeNull();
  });

  it("übernommene Vertretung zählt mit und macht aus der Lücke eine Hohlstunde; abgegebene Stunde zählt nicht", async () => {
    await saveSubstitution(h.db, PLANUNG, { lessonId: ids["7b-4"]!, date: MO, kind: "substitute", substituteId: KLE, roomId: null, note: null });
    const kle = (await teacherDayContext(h.db, KLE, MO, 2, periods))!;
    expect(kle.held).toBe(2);
    expect(kle.position).toBe("Hohlstunde");
    expect(kle.periods.find((p) => p.nr === 4)!.entries[0]).toMatchObject({ held: true, covering: true });
    const bra = (await teacherDayContext(h.db, BRA, MO, 2, periods))!;
    expect(bra.held).toBe(1);
    expect(bra.periods.find((p) => p.nr === 4)!.entries[0]!.held).toBe(false);
  });

  it("Tagesplan der Klasse und Gruppe einer Stunde (Deeplink ohne Lehrkraft/Gruppe)", async () => {
    const plan = await classDay(h.db, "g-7b", MO);
    expect(plan.map((s) => s.periodNr)).toEqual([1, 4, 5]);
    expect(await lessonGroup(h.db, ids["7b-4"]!)).toBe("g-7b");
    expect(await lessonGroup(h.db, "gibt-es-nicht")).toBeNull();
  });

  it("aufgehobene Vertretung bleibt mit Stunde und Verlauf erreichbar", async () => {
    const id = await saveSubstitution(h.db, PLANUNG, { lessonId: ids["7b-5"]!, date: MO, kind: "cancel", substituteId: null, roomId: null, note: null });
    await saveSubstitution(h.db, PLANUNG, { lessonId: ids["7b-1"]!, date: MO, kind: "cancel", substituteId: null, roomId: null, note: null });
    await deleteSubstitution(h.db, PLANUNG, id);
    const history = await substitutionHistory(h.db, await loadPermissions(h.db, PLANUNG), MO, MO);
    const removed = await removedSubstitutions(h.db, history, new Set([ids["7b-1"]!]));
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ lessonId: ids["7b-5"], periodNr: 5, groupName: "Klasse 7b", actorId: PLANUNG });
    expect(history.filter((x) => x.lessonId === ids["7b-5"]).map((x) => x.action)).toEqual(["create", "delete"]);
  });
});
