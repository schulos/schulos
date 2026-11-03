// VA-05/06 (Projektleitung 2026-11-03): Bearbeiten durch die anmeldende Person (wesentlich = Zeit/Räume → neu bestätigen, Sperren und
// Kalender weg; erneute Freigabe nur bei geändertem Zeitraum oder zusätzlichen Räumen; unwesentlich behält die Bestätigung) und Serien
// (wöchentlich/alle 2 Wochen, bis Datum oder höchstens 26 Termine, Ferien übersprungen, ganze Serie bestätigen mit Konflikt-Terminen
// offen, „nur dieser“/„dieser und alle folgenden“).
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { calendarEvents, gebaeudeEventHistory, gebaeudeEvents, notifications, timetableRoomBlocks } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { OPEN_CALENDAR, SchoolCalendar, type DayOff } from "@/core/school/calendar";
import { addDays, fromBerlinLocal, toBerlinDate, toBerlinLocal, weekdayMon0 } from "@/core/time";
import { listSlots } from "@/modules/stundenplan/service";
import { ValidationError } from "@/modules/verwaltung/users";
import { EVENT_APPROVAL } from "./settings";
import {
  approveEvent,
  cancelEvent,
  collapseSeries,
  confirmEvent,
  createEvent,
  dayDiff,
  eventChanges,
  eventOverview,
  getEvent,
  seriesPlan,
  seriesSummary,
  shiftLocal,
  statusAfterEdit,
  updateEvent,
  type EventInput,
} from "./veranstaltungen";
import { createMaintenance } from "./wartung";

const KLAUS = "u-klaus.berger"; // Hausmeisterei
const JANA = "u-jana.brandt"; // Lehrkraft (meldet an)
const PETRA = "u-petra.lindner"; // Schulleitung (Freigabe)
const LEA = "u-lea.schaefer"; // Schülerin
const FRANK = "u-frank.schulte"; // Stundenplanung

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

const offOn =
  (days: Record<string, string>) =>
  (ymd: string): DayOff | null =>
    days[ymd] ? { kind: "ferien", name: days[ymd]!, until: ymd } : null;

describe("VA-05/06 (rein)", () => {
  it("Serienplan: wöchentlich/alle 2 Wochen, bis Datum oder Anzahl, Ferien übersprungen, Grenzen", () => {
    const cal = { dayOff: offOn({ "2026-11-17": "Herbstferien" }) };
    expect(seriesPlan(cal, "2026-11-10", { every: "keine", until: null, count: null })).toBeNull();
    expect(seriesPlan(cal, "2026-11-10", { every: "woechentlich", until: null, count: "4" })).toEqual({
      dates: ["2026-11-10", "2026-11-24", "2026-12-01", "2026-12-08"],
      skipped: [{ date: "2026-11-17", reason: "Herbstferien" }],
      every: 1,
    });
    expect(seriesPlan(cal, "2026-11-10", { every: "zweiwoechentlich", until: "2026-12-08", count: null })!.dates).toEqual(["2026-11-10", "2026-11-24", "2026-12-08"]);
    // beides: was zuerst erreicht ist
    expect(seriesPlan(cal, "2026-11-10", { every: "woechentlich", until: "2026-12-31", count: 2 })!.dates).toEqual(["2026-11-10", "2026-11-24"]);
    expect(() => seriesPlan(cal, "2026-11-10", { every: "taeglich", until: "2026-12-01", count: null })).toThrow(ValidationError);
    const err = (r: Parameters<typeof seriesPlan>[2]) => {
      try {
        seriesPlan(cal, "2026-11-10", r);
      } catch (e) {
        return (e as ValidationError).fieldErrors;
      }
      return null;
    };
    expect(err({ every: "woechentlich", until: null, count: null })).toEqual({ until: "Enddatum oder Anzahl der Termine angeben" });
    expect(err({ every: "woechentlich", until: null, count: 27 })).toEqual({ count: "2 bis 26 Termine" });
    expect(err({ every: "woechentlich", until: "2026-11-10", count: null })).toEqual({ until: "Ein Tag nach dem ersten Termin" });
    expect(err({ every: "woechentlich", until: "2027-12-01", count: null })).toEqual({ until: "Eine Serie läuft höchstens ein Jahr" });
    expect(err({ every: "woechentlich", until: "2027-08-01", count: null })!.until).toContain("Höchstens 26 Termine");
    expect(err({ every: "woechentlich", until: "2026-11-20", count: null })).toEqual({ until: "Kein weiterer Termin außerhalb von Ferien und freien Tagen" });
    // echter Kalender: Feiertag als Grund
    const nw = new SchoolCalendar("NW", []);
    const xmas = seriesPlan(nw, "2026-12-18", { every: "woechentlich", until: null, count: 3 })!;
    expect(xmas.skipped).toEqual([
      { date: "2026-12-25", reason: "Feiertag (1. Weihnachtstag)" },
      { date: "2027-01-01", reason: "Feiertag (Neujahr)" },
    ]);
    expect(seriesSummary(xmas)).toBe("Serie wöchentlich, 3 Termine bis Fr., 15.01.; übersprungen: Fr., 25.12. (Feiertag (1. Weihnachtstag)), Fr., 01.01. (Feiertag (Neujahr))");
  });

  it("Verschieben über die Zeitumstellung behält die Ortszeit", () => {
    expect(shiftLocal("2026-10-20T18:00", 7)).toBe("2026-10-27T18:00");
    expect(toBerlinLocal(fromBerlinLocal(shiftLocal("2026-10-20T18:00", 7)))).toBe("2026-10-27T18:00");
    expect(dayDiff("2026-10-20", "2026-11-03")).toBe(14);
    expect(dayDiff("2026-11-03", "2026-10-20")).toBe(-14);
  });

  it("wesentlich/unwesentlich und Stand nach der Änderung", () => {
    const a = fromBerlinLocal("2026-11-13T18:00");
    const b = fromBerlinLocal("2026-11-13T20:00");
    const old = { title: "Konzert", startsAt: a, endsAt: b, setupAt: a, teardownAt: b, location: null, persons: 50, seating: "reihen" as const, details: null, needsTech: false, needsLocking: false, needsHeating: false, needsCleaning: false };
    const next = { ...old, needs: { needsTech: false, needsLocking: false, needsHeating: false, needsCleaning: false }, roomIds: ["106"] };
    expect(eventChanges(old, ["106"], next)).toEqual({ fields: [], time: false, roomsAdded: false, roomsRemoved: false });
    expect(eventChanges(old, ["106"], { ...next, persons: 80, needs: { ...next.needs, needsTech: true } }).fields).toEqual(["Personenzahl", "Bedarf"]);
    expect(eventChanges(old, ["106"], { ...next, teardownAt: fromBerlinLocal("2026-11-13T21:00") })).toMatchObject({ fields: ["Zeit"], time: true });
    expect(eventChanges(old, ["106", "MU1"], next)).toMatchObject({ fields: ["Räume"], roomsAdded: false, roomsRemoved: true });
    expect(eventChanges(old, ["106"], { ...next, roomIds: ["106", "MU1"] })).toMatchObject({ roomsAdded: true, roomsRemoved: false });

    const none = { time: false, roomsAdded: false, roomsRemoved: false };
    expect(statusAfterEdit("bestaetigt", none, true)).toBe("bestaetigt");
    expect(statusAfterEdit("rueckfrage", none, false)).toBe("rueckfrage");
    expect(statusAfterEdit("bestaetigt", { ...none, time: true }, false)).toBe("angemeldet");
    expect(statusAfterEdit("bestaetigt", { ...none, time: true }, true)).toBe("freigabe");
    expect(statusAfterEdit("bestaetigt", { ...none, roomsAdded: true }, true)).toBe("freigabe");
    // weniger Räume: neu bestätigen, aber keine erneute Freigabe
    expect(statusAfterEdit("bestaetigt", { ...none, roomsRemoved: true }, true)).toBe("angemeldet");
    expect(statusAfterEdit("freigabe", { ...none, time: true }, true)).toBe("freigabe");
  });

  it("Serien in Listen zusammenfassen", () => {
    const rows = [
      { id: "a", seriesId: "s" },
      { id: "b", seriesId: null },
      { id: "c", seriesId: "s" },
      { id: "d", seriesId: "s" },
    ];
    expect(collapseSeries(rows)).toEqual([
      { id: "a", seriesId: "s", seriesMore: 2 },
      { id: "b", seriesId: null, seriesMore: 0 },
    ]);
  });
});

describe("VA-05/06: Bearbeiten und Serien – Service", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  const gongs = async (userId: string) => (await h.db.select({ title: notifications.title, body: notifications.body }).from(notifications).where(eq(notifications.userId, userId)));
  const titles = async (userId: string) => (await gongs(userId)).map((g) => g.title);
  const row = async (id: string) => (await h.db.select().from(gebaeudeEvents).where(eq(gebaeudeEvents.id, id)))[0]!;
  let lesson: { date: string; start: string; end: string; teacherId: string; periodNr: number };
  /** ein Sonntag in mindestens einer Woche */
  let sunday: string;
  const base = (over: Partial<EventInput> = {}): EventInput => ({
    title: "Elternabend 5",
    start: `${sunday}T18:00`,
    end: `${sunday}T20:00`,
    setup: null,
    teardown: null,
    roomIds: ["106"],
    location: null,
    persons: 60,
    seating: "reihen",
    needs: { needsTech: true },
    details: "Beamer",
    ...over,
  });

  beforeAll(async () => {
    h = await createSeededTestDb();
    const today = toBerlinDate(new Date());
    const slots = (await listSlots(h.db, { kind: "room", id: "106" }, addDays(today, 2), addDays(today, 23))).filter((s) => s.teacherId && s.teacherId !== KLAUS && s.teacherId !== JANA && s.teacherId !== FRANK && !s.change);
    const s = slots[0]!;
    lesson = { date: s.date, start: `${s.date}T${s.startsAt.slice(0, 5)}`, end: `${s.date}T${s.endsAt.slice(0, 5)}`, teacherId: s.teacherId!, periodNr: s.periodNr };
    sunday = addDays(today, 7 + (6 - weekdayMon0(addDays(today, 7))));
  }, 60_000);
  afterAll(async () => {
    await h.close();
  });

  it("VA-05: nur die anmeldende Person; unwesentlich behält die Bestätigung, Zeit/Raum hebt Sperren und Kalender auf", async () => {
    const [klaus, jana, lea] = await Promise.all([p(KLAUS), p(JANA), p(LEA)]);
    const { id } = await createEvent(h.db, jana, base({ title: "Sommerfest", roomIds: ["KU1"] }));
    await confirmEvent(h.db, klaus, id, { blockRooms: true, calendar: true });
    await expect(updateEvent(h.db, klaus, id, base({ title: "Sommerfest", roomIds: ["KU1"] }))).rejects.toThrow(ForbiddenError);
    await expect(updateEvent(h.db, lea, id, base())).rejects.toThrow(ForbiddenError);
    expect(await fieldErrors(updateEvent(h.db, jana, id, base({ title: "Sommerfest", roomIds: ["KU1"] })))).toEqual({ status: "Nichts geändert" });
    expect((await getEvent(h.db, jana, id))!.can.edit).toBe(true);
    expect((await getEvent(h.db, klaus, id))!.can.edit).toBe(false);

    // unwesentlich: Titel, Personenzahl → bleibt bestätigt, Kalender zieht nach
    const r1 = await updateEvent(h.db, jana, id, base({ title: "Sommerfest der 5er", roomIds: ["KU1"], persons: 90 }));
    expect(r1).toEqual({ changed: 1, reconfirm: 0, reapprove: 0 });
    const e1 = await row(id);
    expect(e1).toMatchObject({ status: "bestaetigt", title: "Sommerfest der 5er", persons: 90 });
    const [cal] = await h.db.select().from(calendarEvents).where(eq(calendarEvents.id, e1.calendarEventId!));
    expect(cal!.title).toBe("Sommerfest der 5er");
    expect(await titles(KLAUS)).toContain("Veranstaltung geändert: Sommerfest der 5er");
    const hist = await h.db.select().from(gebaeudeEventHistory).where(and(eq(gebaeudeEventHistory.eventId, id), eq(gebaeudeEventHistory.kind, "geaendert")));
    expect(hist.map((x) => x.text)).toEqual(["Titel, Personenzahl geändert – Bestätigung bleibt"]);

    // wesentlich: Ende später → zurück auf „angemeldet“, Kalendereintrag weg, Hausmeisterei soll neu bestätigen
    const r2 = await updateEvent(h.db, jana, id, base({ title: "Sommerfest der 5er", roomIds: ["KU1"], persons: 90, end: `${sunday}T21:00` }));
    expect(r2).toEqual({ changed: 1, reconfirm: 1, reapprove: 0 });
    expect(await row(id)).toMatchObject({ status: "angemeldet", calendarEventId: null });
    expect(await h.db.select().from(calendarEvents).where(eq(calendarEvents.id, cal!.id))).toHaveLength(0);
    expect((await gongs(KLAUS)).find((g) => g.title === "Veranstaltung geändert: Sommerfest der 5er" && g.body?.includes("Zeit geändert"))!.body).toContain("bitte neu bestätigen");

    // vorbei: nicht mehr änderbar
    const past = new Date(fromBerlinLocal(`${sunday}T18:30`));
    expect(await fieldErrors(updateEvent(h.db, jana, id, base({ title: "X Fest" }), "einzeln", past))).toEqual({ status: "Ändern geht nur bei offenen oder bestätigten Veranstaltungen vor dem Aufbau" });
    await cancelEvent(h.db, jana, id, null);
  });

  it("VA-05: Raumsperre bei Unterricht fällt bei Raumwechsel weg; erneute Freigabe nur bei Zeit oder zusätzlichen Räumen", async () => {
    const [klaus, jana, petra] = await Promise.all([p(KLAUS), p(JANA), p(PETRA)]);
    const { id } = await createEvent(h.db, jana, base({ title: "Probe Unterricht", start: lesson.start, end: lesson.end, roomIds: ["106", "MU1"] }));
    await confirmEvent(h.db, klaus, id, { blockRooms: true, calendar: false });
    expect(await h.db.select().from(timetableRoomBlocks).where(eq(timetableRoomBlocks.note, "Probe Unterricht"))).not.toHaveLength(0);
    await writeModuleSetting(h.db, EVENT_APPROVAL, "1");
    try {
      // weniger Räume: neu bestätigen, aber nicht erneut zur Freigabe; Sperren weg
      const r = await updateEvent(h.db, jana, id, base({ title: "Probe Unterricht", start: lesson.start, end: lesson.end, roomIds: ["MU1"] }));
      expect(r).toEqual({ changed: 1, reconfirm: 1, reapprove: 0 });
      expect((await row(id)).status).toBe("angemeldet");
      expect(await h.db.select().from(timetableRoomBlocks).where(eq(timetableRoomBlocks.note, "Probe Unterricht"))).toHaveLength(0);
      expect((await getEvent(h.db, jana, id))!.event.rooms).toEqual(["MU1"]);
      // zusätzlicher Raum: erneut zur Freigabe
      await confirmEvent(h.db, klaus, id, { blockRooms: false, calendar: false });
      const r2 = await updateEvent(h.db, jana, id, base({ title: "Probe Unterricht", start: lesson.start, end: lesson.end, roomIds: ["MU1", "KU1"] }));
      expect(r2).toEqual({ changed: 1, reconfirm: 0, reapprove: 1 });
      expect((await row(id)).status).toBe("freigabe");
      expect(await titles(PETRA)).toContain("Veranstaltung geändert, erneut zur Freigabe: Probe Unterricht");
      expect((await gongs(KLAUS)).some((g) => g.title === "Veranstaltung geändert: Probe Unterricht" && g.body?.includes("erneut zur Freigabe"))).toBe(true);
      await approveEvent(h.db, petra, id);
      expect((await row(id)).status).toBe("angemeldet");
    } finally {
      await writeModuleSetting(h.db, EVENT_APPROVAL, "0");
    }
    await cancelEvent(h.db, jana, id, null);
  });

  it("VA-06: Serie anlegen (Ferien übersprungen), ganze Serie bestätigen – Konflikt-Termin bleibt offen", async () => {
    const [klaus, jana] = await Promise.all([p(KLAUS), p(JANA)]);
    const first = addDays(sunday, 70);
    const cal = new SchoolCalendar("NW", [{ id: "c1", kind: "ferien", name: "Testferien", startsOn: addDays(first, 7), endsOn: addDays(first, 7) }]);
    const input = base({ title: "Chorprobe", start: `${first}T18:00`, end: `${first}T19:30`, roomIds: ["MU1"], repeat: { every: "woechentlich", until: null, count: 4 } });
    expect(await fieldErrors(createEvent(h.db, jana, { ...input, repeat: { every: "woechentlich", until: null, count: 30 } }, new Date(), cal))).toEqual({ count: "2 bis 26 Termine" });
    const r = await createEvent(h.db, jana, input, new Date(), cal);
    expect(r.ids).toHaveLength(4);
    expect(r.skipped).toEqual([{ date: addDays(first, 7), reason: "Testferien" }]);
    const rows = await Promise.all(r.ids.map(row));
    expect(rows.map((x) => toBerlinLocal(x.startsAt))).toEqual([0, 14, 21, 28].map((d) => `${addDays(first, d)}T18:00`));
    expect(new Set(rows.map((x) => x.seriesId)).size).toBe(1);
    expect(rows[0]!.seriesId).not.toBeNull();
    expect((await titles(KLAUS)).filter((t) => t.startsWith("Veranstaltungsreihe angemeldet: Chorprobe"))).toEqual(["Veranstaltungsreihe angemeldet: Chorprobe (4 Termine)"]);
    const [hist] = await h.db.select().from(gebaeudeEventHistory).where(eq(gebaeudeEventHistory.eventId, r.ids[1]!));
    expect(hist!.text).toContain("übersprungen:");
    expect(hist!.text).toContain("(Testferien)");

    // Übersicht: offene Serie als eine Zeile
    const o = await eventOverview(h.db, klaus);
    const open = o.open.filter((e) => e.title === "Chorprobe");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: r.ids[0], seriesMore: 3 });
    const d = (await getEvent(h.db, klaus, r.ids[1]!))!;
    expect(d.series).toMatchObject({ position: 2, open: 4, approval: 0, following: 3 });
    expect(d.series!.items).toHaveLength(4);

    // Wartung am dritten Termin → bleibt offen
    const third = rows[2]!;
    await createMaintenance(h.db, klaus, { title: "Klavierstimmen", provider: null, start: toBerlinLocal(third.startsAt), end: toBerlinLocal(third.endsAt), building: null, roomIds: ["MU1"], note: null, blockRooms: false, calendar: false });
    const c = await confirmEvent(h.db, klaus, r.ids[0]!, { blockRooms: true, calendar: false, scope: "serie" });
    expect(c.confirmed).toBe(3);
    expect(c.open).toHaveLength(1);
    expect((await Promise.all(r.ids.map(row))).map((x) => x.status)).toEqual(["bestaetigt", "bestaetigt", "angemeldet", "bestaetigt"]);
    const og = (await gongs(JANA)).find((g) => g.title === "Veranstaltungsreihe bestätigt: Chorprobe")!;
    expect(og.body).toBe("3 Termine bestätigt, 1 Termin mit Konflikt noch offen");
    await expect(confirmEvent(h.db, jana, r.ids[0]!, { blockRooms: true, calendar: false, scope: "serie" })).rejects.toThrow(ForbiddenError);

    // „dieser und alle folgenden“ ab Termin 2: Beginn eine Stunde später → Termine 2–4 geändert, Termin 1 bleibt
    const u = await updateEvent(h.db, jana, r.ids[1]!, { ...input, repeat: null, start: `${addDays(first, 14)}T19:00`, end: `${addDays(first, 14)}T20:30` }, "folgende");
    expect(u).toEqual({ changed: 3, reconfirm: 2, reapprove: 0 });
    const after = await Promise.all(r.ids.map(row));
    expect(after.map((x) => toBerlinLocal(x.startsAt))).toEqual([`${first}T18:00`, ...[14, 21, 28].map((dd) => `${addDays(first, dd)}T19:00`)]);
    expect(after.map((x) => x.status)).toEqual(["bestaetigt", "angemeldet", "angemeldet", "angemeldet"]);
    expect(await titles(KLAUS)).toContain("Veranstaltung geändert: Chorprobe (3 Termine)");

    // „nur dieser“ am ersten Termin: nur Personenzahl → nur Termin 1
    expect(await updateEvent(h.db, jana, r.ids[0]!, { ...input, repeat: null, persons: 40 })).toEqual({ changed: 1, reconfirm: 0, reapprove: 0 });
    expect((await Promise.all(r.ids.map(row))).map((x) => x.persons)).toEqual([40, 60, 60, 60]);

    // Absagen „dieser und alle folgenden“ ab Termin 3
    expect(await cancelEvent(h.db, jana, r.ids[2]!, "Chor pausiert", new Date(), "folgende")).toBe(2);
    expect((await Promise.all(r.ids.map(row))).map((x) => x.status)).toEqual(["bestaetigt", "angemeldet", "abgesagt", "abgesagt"]);
    expect((await titles(KLAUS)).some((t) => t.startsWith("Veranstaltung abgesagt: Chorprobe (2 Termine ab "))).toBe(true);
    // „nur dieser“
    expect(await cancelEvent(h.db, jana, r.ids[1]!, null)).toBe(1);
    expect((await row(r.ids[0]!)).status).toBe("bestaetigt");
  });

  it("VA-06: Serie mit Unterricht – Sperren je Termin, ein Gong an Lehrkraft und Planung; Freigabe der ganzen Serie", async () => {
    const [klaus, jana, petra] = await Promise.all([p(KLAUS), p(JANA), p(PETRA)]);
    const r = await createEvent(
      h.db,
      jana,
      base({ title: "Theater-AG", start: lesson.start, end: lesson.end, roomIds: ["106"], repeat: { every: "woechentlich", until: addDays(lesson.date, 7), count: null } }),
      new Date(),
      OPEN_CALENDAR,
    );
    expect(r.ids).toHaveLength(2);
    const c = await confirmEvent(h.db, klaus, r.ids[0]!, { blockRooms: true, calendar: false, scope: "serie" });
    expect(c.confirmed).toBe(2);
    expect(c.blocks).toBeGreaterThanOrEqual(1);
    expect((await titles(lesson.teacherId)).filter((t) => t.endsWith("gesperrt: Veranstaltung Theater-AG"))).toHaveLength(1);
    expect((await titles(FRANK)).filter((t) => t.startsWith("Veranstaltung Theater-AG:"))).toHaveLength(1);
    expect(await cancelEvent(h.db, jana, r.ids[0]!, null, new Date(), "folgende")).toBe(2);
    expect(await h.db.select().from(timetableRoomBlocks).where(eq(timetableRoomBlocks.note, "Theater-AG"))).toHaveLength(0);

    await writeModuleSetting(h.db, EVENT_APPROVAL, "1");
    try {
      const s = await createEvent(h.db, jana, base({ title: "Lesekreis", roomIds: [], location: "Bibliothek", repeat: { every: "zweiwoechentlich", until: null, count: 3 } }), new Date(), OPEN_CALENDAR);
      expect((await getEvent(h.db, petra, s.ids[0]!))!.series).toMatchObject({ approval: 3 });
      expect(await titles(PETRA)).toContain("Veranstaltungsreihe zur Freigabe: Lesekreis (3 Termine)");
      expect(await approveEvent(h.db, petra, s.ids[1]!, "serie")).toBe(3);
      expect((await Promise.all(s.ids.map(row))).every((x) => x.status === "angemeldet")).toBe(true);
      expect(await titles(KLAUS)).toContain("Veranstaltungsreihe angemeldet: Lesekreis (3 Termine)");
      expect(await titles(JANA)).toContain("Veranstaltungsreihe freigegeben: Lesekreis");
    } finally {
      await writeModuleSetting(h.db, EVENT_APPROVAL, "0");
    }
  });
});
