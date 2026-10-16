// Ferien, Feiertage und unterrichtsfreie Tage über die Module hinweg.
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { schoolClosures, timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { addResource, book, listResources, resourceWeek } from "@/modules/buchungen/service";
import { schoolDayOffOccurrences } from "@/modules/kalender/service";
import { lessonContext } from "@/modules/klassenbuch/service";
import { createExam } from "@/modules/klausurplan/service";
import { checkClosures, deleteClosure, saveClosures } from "@/modules/verwaltung/closures";
import { ValidationError } from "@/modules/verwaltung/users";
import { listSlots } from "./service";
import { planDays, saveSubstitution } from "./vertretung";

const TODAY = "2026-10-03";
const PAED = "2026-10-16"; // Freitag, pädagogischer Tag
const FERIEN = "2026-10-20"; // Dienstag in den Herbstferien

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("Ferien und Feiertage", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    await saveClosures(h.db, "u-admin", [], { kind: "ferien", name: "Herbstferien", startsOn: "2026-10-17", endsOn: "2026-10-31" });
    await saveClosures(h.db, "u-admin", (await h.db.select().from(schoolClosures)).map((c) => ({ ...c })), { kind: "frei", name: "Pädagogischer Tag", startsOn: PAED, endsOn: PAED });
  }, 60_000);
  afterAll(() => h.close());

  it("Pflege prüft Zeitraum, Länge und überlappende Ferien", async () => {
    expect(
      checkClosures([
        { id: "a", kind: "ferien", name: "Herbstferien", startsOn: "2026-10-17", endsOn: "2026-10-31" },
        { id: "b", kind: "ferien", name: "Doppelt", startsOn: "2026-10-30", endsOn: "2026-11-02" },
        { id: "c", kind: "frei", name: "Brückentag", startsOn: "2026-10-30", endsOn: "2026-10-30" },
        { id: "d", kind: "urlaub", name: " ", startsOn: "2026-12-01", endsOn: "2026-11-30" },
        { kind: "ferien", name: "Sommer", startsOn: "2027-07-19", endsOn: "2028-08-31" },
      ]),
    ).toEqual({
      "start-b": "Überschneidet sich mit „Herbstferien“",
      "kind-d": "Art wählen",
      "name-d": "Bezeichnung angeben",
      "end-d": "Ende vor dem Beginn",
      "end-new": "Mehr als zehn Wochen – Jahr prüfen",
    });
    expect(await h.db.select().from(schoolClosures)).toHaveLength(2);
  });

  it("Stundenplan: keine Stunden an Feiertagen, in den Ferien und an freien Tagen", async () => {
    const week = await listSlots(h.db, { kind: "group", id: "g-7b" }, "2026-10-12", "2026-10-17");
    const days = new Set(week.map((s) => s.date));
    expect(days.has("2026-10-12")).toBe(true);
    expect(days.has(PAED)).toBe(false);
    expect(await listSlots(h.db, { kind: "group", id: "g-7b" }, "2026-10-19", "2026-10-24")).toEqual([]);
    // 1. Weihnachtstag 2026 ist ein Freitag (keine Ferien gepflegt)
    const xmas = await listSlots(h.db, { kind: "group", id: "g-7b" }, "2026-12-21", "2026-12-26");
    expect(xmas.some((s) => s.date === "2026-12-24")).toBe(true);
    expect(xmas.some((s) => s.date === "2026-12-25")).toBe(false);
  });

  it("Vertretungsplan springt über Ferien; Vertretung und Klassenbuch lehnen freie Tage ab", async () => {
    const cal = await loadSchoolCalendar(h.db);
    expect(planDays("2026-10-15", cal)).toEqual(["2026-10-15", "2026-11-02"]);
    expect(planDays("2026-10-24", cal)).toEqual(["2026-11-02", "2026-11-03"]);
    const [friday] = await h.db.select().from(timetableLessons).where(and(eq(timetableLessons.groupId, "g-7b"), eq(timetableLessons.weekday, 4)));
    expect(await fieldErrors(saveSubstitution(h.db, "u-admin", { lessonId: friday!.id, date: PAED, kind: "cancel", substituteId: null, roomId: null, note: null }))).toEqual({
      date: "Kein Unterricht: unterrichtsfrei (Pädagogischer Tag)",
    });
    await expect(lessonContext(h.db, friday!.id, PAED)).rejects.toMatchObject({ fieldErrors: { lessonId: "Kein Unterricht: unterrichtsfrei (Pädagogischer Tag)" } });
  });

  it("Klausurplan sperrt, Buchungen nur in Ferien und an Feiertagen gesperrt", async () => {
    const jana = await p("u-jana.brandt");
    const base = { groupId: "g-7b", subjectId: "D", kind: "klassenarbeit" as const, title: "1. Klassenarbeit", periodFrom: 1, periodTo: 2, roomId: null, override: false };
    expect(await fieldErrors(createExam(h.db, jana, { ...base, date: FERIEN }, TODAY))).toEqual({ date: "Kein Unterricht: Herbstferien" });

    const bib = (await listResources(h.db)).find((r) => r.roomId === "BIB");
    const room = bib?.id ?? (await addResource(h.db, await p("u-sabine.kowalski"), { kind: "room", roomId: "BIB" }));
    expect(await fieldErrors(book(h.db, jana, { resourceId: room, date: FERIEN, periodNr: 1, groupId: null, note: "" }, TODAY))).toEqual({ date: "Schule geschlossen: Herbstferien" });
    await book(h.db, jana, { resourceId: room, date: PAED, periodNr: 1, groupId: null, note: "Fortbildung" }, TODAY);
    const week = await resourceWeek(h.db, room, "2026-10-19");
    expect(week.get(`${FERIEN}:1`)).toEqual({ kind: "closed", label: "Herbstferien" });
  });

  it("Kalender zeigt Feiertage und Ferien als ganztägige Termine", async () => {
    const occ = await schoolDayOffOccurrences(h.db, "2026-10-01", "2026-11-02");
    expect(occ.map((o) => o.title)).toEqual(["Tag der Deutschen Einheit (Feiertag)", "Pädagogischer Tag (unterrichtsfrei)", "Herbstferien", "Allerheiligen (Feiertag)"]);
    expect(occ.every((o) => o.allDay)).toBe(true);
  });

  it("Löschen gibt den Tag wieder frei", async () => {
    const paed = (await h.db.select().from(schoolClosures)).find((c) => c.kind === "frei")!;
    await deleteClosure(h.db, "u-admin", paed.id);
    expect((await loadSchoolCalendar(h.db)).isSchoolDay(PAED)).toBe(true);
  });
});
