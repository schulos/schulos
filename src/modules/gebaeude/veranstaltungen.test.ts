// VA-01…03: Veranstaltungsanmeldung an die Hausmeisterei – Rechte (anmelden mit `report`, entscheiden mit `manage`, Freigabe mit
// `event_approve` nur bei eingeschalteter Einstellung), Prüfungen der Eingaben, Ablauf Rückfrage/Antwort/Bestätigung/Absage,
// Raumsperre nur bei Unterricht (je Raum und Tag die berührten Stunden), Konflikthinweise (Wartung), Schulkalender, „Heute im Haus“,
// Wochenvorschau, Gong am Vortag (einmal), Löschklasse, Auskunft, Kontolöschung.
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { calendarEvents, gebaeudeEventHistory, gebaeudeEvents, gebaeudeMaintenance, notifications, timetableRoomBlocks } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { collectPersonalData } from "@/core/privacy/auskunft";
import { deleteAccounts } from "@/core/privacy/konto";
import { planDeletion } from "@/core/privacy/loeschlauf";
import { userRefs } from "@/core/privacy/refs";
import { SCHEDULED_JOBS } from "@/core/scheduler";
import { addDays, fromBerlinLocal, toBerlinDate, weekdayMon0 } from "@/core/time";
import { listSlots } from "@/modules/stundenplan/service";
import { ValidationError } from "@/modules/verwaltung/users";
import { todayInHouse } from "./heute";
import { EVENT_APPROVAL } from "./settings";
import {
  answerEvent,
  approveEvent,
  askEvent,
  cancelEvent,
  confirmEvent,
  createEvent,
  daysOf,
  eventConflicts,
  eventOverview,
  eventSpan,
  getEvent,
  myEvents,
  rejectEvent,
  runEventReminders,
  setupText,
  type EventInput,
} from "./veranstaltungen";
import { createMaintenance } from "./wartung";

const KLAUS = "u-klaus.berger"; // Hausmeisterei: manage über die Gruppe
const JANA = "u-jana.brandt"; // Lehrkraft: report
const PETRA = "u-petra.lindner"; // Schulleitung: event_approve über die Gruppe
const LEA = "u-lea.schaefer"; // Schülerin: kein report
const FRANK = "u-frank.schulte"; // Gruppe Stundenplanung: stundenplan.substitute

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("VA-01 (rein)", () => {
  it("Zeitraum, Auf-/Abbau und berührte Tage", () => {
    const a = fromBerlinLocal("2026-11-13T18:00");
    const b = fromBerlinLocal("2026-11-13T21:00");
    expect(eventSpan(a, b)).toBe("Fr., 13.11., 18:00–21:00");
    expect(eventSpan(a, fromBerlinLocal("2026-11-14T12:00"))).toBe("Fr., 13.11., 18:00 – Sa., 14.11., 12:00");
    expect(setupText({ startsAt: a, endsAt: b, setupAt: a, teardownAt: b })).toBe("");
    expect(setupText({ startsAt: a, endsAt: b, setupAt: fromBerlinLocal("2026-11-13T16:00"), teardownAt: fromBerlinLocal("2026-11-13T22:30") })).toBe("Aufbau ab 16:00, Abbau bis 22:30");
    expect(daysOf(a, b)).toEqual(["2026-11-13"]);
    expect(daysOf(fromBerlinLocal("2026-11-13T16:00"), fromBerlinLocal("2026-11-15T00:00"))).toEqual(["2026-11-13", "2026-11-14"]);
  });

  it("Job, Personenbezug bei Kontolöschung", () => {
    expect(SCHEDULED_JOBS.find((j) => j.name === "gebaeude-veranstaltungen")).toMatchObject({ at: "12:00", until: "20:00" });
    expect(userRefs().find((r) => r.table === "gebaeude_veranstaltungen")).toMatchObject({ column: "organizer_id", onDelete: "set null" });
    expect(userRefs().find((r) => r.table === "gebaeude_veranstaltung_verlauf")).toMatchObject({ column: "actor_id", onDelete: "set null" });
  });
});

describe("VA-01…03: Veranstaltungen – Service", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  const gongs = async (userId: string) => (await h.db.select({ title: notifications.title }).from(notifications).where(eq(notifications.userId, userId))).map((n) => n.title);
  /** ein Tag mit Unterricht in Raum 106 (mindestens zwei Tage voraus) und die erste Stunde dort */
  let lesson: { date: string; start: string; end: string; teacherId: string; periodNr: number };
  /** ein Sonntag (kein Unterricht) in der Zukunft */
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
    details: "Beamer und ein Mikrofon",
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

  it("Rechte und Eingaben: anmelden nur mit „melden“, Zeitraum, Räume oder Ort, Personenzahl", async () => {
    const [jana, lea] = await Promise.all([p(JANA), p(LEA)]);
    await expect(createEvent(h.db, lea, base())).rejects.toThrow(ForbiddenError);
    expect(await fieldErrors(createEvent(h.db, jana, base({ title: "x", end: `${sunday}T17:00`, persons: 0, seating: "sofa" })))).toEqual({
      title: "Titel mit 3 bis 120 Zeichen",
      end: "Ende liegt vor dem Beginn",
      persons: "Personenzahl von 1 bis 5000",
      seating: "Bestuhlung wählen",
    });
    expect(await fieldErrors(createEvent(h.db, jana, base({ roomIds: [], location: null })))).toEqual({ roomIds: "Räume wählen oder einen Ort angeben" });
    expect(await fieldErrors(createEvent(h.db, jana, base({ roomIds: ["999"] })))).toEqual({ roomIds: "Raum 999 gibt es nicht" });
    expect(await fieldErrors(createEvent(h.db, jana, base({ setup: `${sunday}T19:00` })))).toEqual({ setup: "Aufbau liegt nach dem Beginn" });
    expect(await fieldErrors(createEvent(h.db, jana, base({ teardown: `${sunday}T19:00` })))).toEqual({ teardown: "Abbau endet vor der Veranstaltung" });
    expect(await fieldErrors(createEvent(h.db, jana, base({ teardown: `${addDays(sunday, 8)}T19:00` })))).toEqual({ teardown: "Aufbau bis Abbau höchstens 7 Tage" });
    const yesterday = addDays(toBerlinDate(new Date()), -1);
    expect(await fieldErrors(createEvent(h.db, jana, base({ start: `${yesterday}T18:00`, end: `${yesterday}T20:00` })))).toEqual({ start: "Liegt in der Vergangenheit" });
  });

  it("Ablauf: Anmeldung → Rückfrage → Antwort → Bestätigung mit Raumsperre nur bei Unterricht und Schulkalender → Absage räumt auf", async () => {
    const [klaus, jana, lea, petra] = await Promise.all([p(KLAUS), p(JANA), p(LEA), p(PETRA)]);
    const { id, conflicts } = await createEvent(h.db, jana, base({ title: "Theaterprobe", start: lesson.start, end: lesson.end, setup: null, teardown: null }));
    expect(conflicts.filter((c) => c.kind === "unterricht")).toEqual([{ kind: "unterricht", roomId: "106", text: expect.stringContaining(`${lesson.periodNr}. Std`) }]);
    expect(await gongs(KLAUS)).toContain("Veranstaltung angemeldet: Theaterprobe");
    const [row] = await h.db.select().from(gebaeudeEvents).where(eq(gebaeudeEvents.id, id));
    expect(row).toMatchObject({ status: "angemeldet", organizerId: JANA, persons: 60, seating: "reihen", needsTech: true, needsLocking: false });

    // Sicht: anmeldende Person und Hausmeisterei ja, andere Lehrkraft/Schülerin nein
    expect(await getEvent(h.db, lea, id)).toBeNull();
    expect((await getEvent(h.db, jana, id))!.can).toEqual({ approve: false, decide: false, answer: false, cancel: true });
    expect((await getEvent(h.db, klaus, id))!.can).toMatchObject({ decide: true, cancel: true });
    expect((await getEvent(h.db, petra, id))!.can).toMatchObject({ approve: false, decide: false });
    await expect(confirmEvent(h.db, jana, id, { blockRooms: true, calendar: false })).rejects.toThrow(ForbiddenError);
    await expect(eventOverview(h.db, lea)).rejects.toThrow(ForbiddenError);

    // Rückfrage und Antwort
    expect(await fieldErrors(askEvent(h.db, klaus, id, " "))).toEqual({ text: "Text mit 3 bis 1000 Zeichen" });
    await askEvent(h.db, klaus, id, "Braucht ihr die Bühne?");
    expect(await gongs(JANA)).toContain("Rückfrage zur Veranstaltung: Theaterprobe");
    expect((await getEvent(h.db, jana, id))!.can.answer).toBe(true);
    await expect(answerEvent(h.db, klaus, id, "Ja")).rejects.toThrow(ForbiddenError);
    await answerEvent(h.db, jana, id, "Ja, mit Vorhang");
    expect(await gongs(KLAUS)).toContain("Antwort zur Veranstaltung: Theaterprobe");

    // Bestätigen: Unterricht → Sperre genau dieser Stunde, Gong an die Lehrkraft, Kalender
    const r = await confirmEvent(h.db, klaus, id, { blockRooms: true, calendar: true, note: "Schlüssel liegt bereit" });
    expect(r.blocks).toBe(1);
    expect(await gongs(lesson.teacherId)).toContain("Raum 106 gesperrt: Veranstaltung Theaterprobe");
    // VA-04: die Stundenplanung bekommt einen gebündelten Gong mit Link auf den betroffenen Tag
    const planGong = await h.db.select({ title: notifications.title, body: notifications.body, href: notifications.href }).from(notifications).where(and(eq(notifications.userId, FRANK), eq(notifications.title, "Veranstaltung Theaterprobe: 1 Raumsperre")));
    expect(planGong).toEqual([{ title: "Veranstaltung Theaterprobe: 1 Raumsperre", body: expect.stringContaining(`Raum 106, ${lesson.periodNr}. Std.`), href: `/planung/vertretungen?datum=${lesson.date}` }]);
    const blocks = await h.db.select().from(timetableRoomBlocks).where(and(eq(timetableRoomBlocks.roomId, "106"), eq(timetableRoomBlocks.note, "Theaterprobe")));
    expect(blocks).toEqual([expect.objectContaining({ startsOn: lesson.date, endsOn: lesson.date, fromPeriod: lesson.periodNr, toPeriod: lesson.periodNr, reason: "veranstaltung" })]);
    const d = (await getEvent(h.db, klaus, id))!;
    expect(d.event.status).toBe("bestaetigt");
    expect(d.blocks).toHaveLength(1);
    // die eigene Sperre ist kein Konflikt; der Unterricht in der Stunde bleibt als Hinweis sichtbar
    expect(d.conflicts.some((c) => c.kind === "raumsperre")).toBe(false);
    const [cal] = await h.db.select().from(calendarEvents).where(eq(calendarEvents.id, d.event.calendarEventId!));
    expect(cal).toMatchObject({ scope: "school", title: "Theaterprobe", location: "Raum 106" });
    expect(await gongs(JANA)).toContain("Veranstaltung bestätigt: Theaterprobe");
    expect(d.history.map((x) => x.kind)).toEqual(["angemeldet", "rueckfrage", "antwort", "bestaetigt"]);
    await expect(confirmEvent(h.db, klaus, id, { blockRooms: false, calendar: false })).rejects.toThrow(ValidationError);

    // Übersicht und „Heute im Haus“ am Tag der Veranstaltung
    const o = await eventOverview(h.db, klaus, fromBerlinLocal(`${lesson.date}T06:00`));
    expect(o.week[0]!.events.map((e) => e.id)).toContain(id);
    const heute = await todayInHouse(h.db, klaus, fromBerlinLocal(`${lesson.date}T06:00`));
    expect(heute.events.map((e) => e.title)).toContain("Theaterprobe");
    expect((await myEvents(h.db, jana)).map((e) => e.id)).toContain(id);

    // Absage durch die anmeldende Person: Sperre und Kalendereintrag weg, Hausmeisterei informiert
    await cancelEvent(h.db, jana, id, "Probe verschoben");
    expect(await h.db.select().from(timetableRoomBlocks).where(eq(timetableRoomBlocks.note, "Theaterprobe"))).toHaveLength(0);
    expect(await h.db.select().from(calendarEvents).where(eq(calendarEvents.id, cal!.id))).toHaveLength(0);
    expect(await gongs(KLAUS)).toContain("Veranstaltung abgesagt: Theaterprobe");
    expect((await getEvent(h.db, jana, id))!.can.cancel).toBe(false);
    await expect(cancelEvent(h.db, jana, id, null)).rejects.toThrow(ValidationError);
  });

  it("ohne Unterricht keine Raumsperre, Wartung und andere Veranstaltungen nur als Hinweis; Ablehnen mit Begründung", async () => {
    const [klaus, jana] = await Promise.all([p(KLAUS), p(JANA)]);
    await createMaintenance(h.db, klaus, { title: "Lüftung", provider: null, start: `${sunday}T17:00`, end: `${sunday}T19:00`, building: null, roomIds: ["106"], note: null, blockRooms: false, calendar: false });
    const first = await createEvent(h.db, jana, base({ title: "Sonntagskonzert" }));
    expect(first.conflicts.map((c) => c.kind)).toEqual(["wartung"]);
    const second = await createEvent(h.db, jana, base({ title: "Chorprobe", location: "Schulhof" }));
    expect(second.conflicts.map((c) => c.kind).sort()).toEqual(["veranstaltung", "wartung"]);
    expect(await eventConflicts(h.db, { roomIds: [], from: new Date(), to: new Date() })).toEqual([]);
    const r = await confirmEvent(h.db, klaus, first.id, { blockRooms: true, calendar: false });
    expect(r).toEqual({ blocks: 0, notified: 0 });
    expect(await fieldErrors(rejectEvent(h.db, klaus, second.id, ""))).toEqual({ text: "Text mit 3 bis 1000 Zeichen" });
    await rejectEvent(h.db, klaus, second.id, "Aula ist an dem Abend belegt");
    expect(await gongs(JANA)).toContain("Veranstaltung abgelehnt: Chorprobe");
    // Hausmeisterei sagt eine bestätigte ab → Gong an die anmeldende Person
    await cancelEvent(h.db, klaus, first.id, null);
    expect(await gongs(JANA)).toContain("Veranstaltung abgesagt: Sonntagskonzert");
    await h.db.delete(gebaeudeMaintenance).where(eq(gebaeudeMaintenance.title, "Lüftung"));
  });

  it("Schulleitungs-Freigabe (Einstellung): erst Schulleitung, dann Hausmeisterei", async () => {
    const [klaus, jana, petra] = await Promise.all([p(KLAUS), p(JANA), p(PETRA)]);
    await writeModuleSetting(h.db, EVENT_APPROVAL, "1");
    try {
      const { id } = await createEvent(h.db, jana, base({ title: "Sportfest", roomIds: [], location: "Sportplatz" }));
      expect((await h.db.select().from(gebaeudeEvents).where(eq(gebaeudeEvents.id, id)))[0]!.status).toBe("freigabe");
      expect(await gongs(PETRA)).toContain("Veranstaltung zur Freigabe: Sportfest");
      expect(await gongs(KLAUS)).not.toContain("Veranstaltung angemeldet: Sportfest");
      // Hausmeisterei kann noch nicht entscheiden, Lehrkraft nicht freigeben
      await expect(confirmEvent(h.db, klaus, id, { blockRooms: false, calendar: false })).rejects.toThrow(ValidationError);
      await expect(approveEvent(h.db, jana, id)).rejects.toThrow(ForbiddenError);
      expect((await eventOverview(h.db, petra)).approval.map((e) => e.id)).toContain(id);
      expect((await eventOverview(h.db, klaus)).approval).toEqual([]);
      await approveEvent(h.db, petra, id);
      expect(await gongs(KLAUS)).toContain("Veranstaltung angemeldet: Sportfest");
      expect(await gongs(JANA)).toContain("Veranstaltung freigegeben: Sportfest");
      await expect(approveEvent(h.db, petra, id)).rejects.toThrow(ValidationError);
      // Ablehnen durch die Schulleitung
      const other = await createEvent(h.db, jana, base({ title: "Disco", roomIds: [], location: "Pausenhalle" }));
      await rejectEvent(h.db, petra, other.id, "Nicht im Schuljahr");
      expect((await getEvent(h.db, jana, other.id))!.event.status).toBe("abgelehnt");
    } finally {
      await writeModuleSetting(h.db, EVENT_APPROVAL, "0");
    }
  });

  it("Gong am Vortag: Hausmeisterei und anmeldende Person, je Veranstaltung einmal; abgesagte und Freigabe-Fälle nicht", async () => {
    const jana = await p(JANA);
    const now = new Date();
    const tomorrow = addDays(toBerlinDate(now), 1);
    const { id } = await createEvent(h.db, jana, base({ title: "Lesung", start: `${tomorrow}T19:00`, end: `${tomorrow}T21:00`, setup: `${tomorrow}T17:30`, roomIds: [], location: "Bibliothek" }));
    const gone = await createEvent(h.db, jana, base({ title: "Abgesagt", start: `${tomorrow}T19:00`, end: `${tomorrow}T21:00`, roomIds: [], location: "Aula" }));
    await cancelEvent(h.db, jana, gone.id, null);
    const r = await runEventReminders(h.db, now);
    expect(r.events).toBe(1);
    expect(await gongs(KLAUS)).toContain("Morgen im Haus: Lesung");
    expect(await gongs(JANA)).toContain("Morgen im Haus: Lesung");
    expect(await gongs(KLAUS)).not.toContain("Morgen im Haus: Abgesagt");
    expect(await runEventReminders(h.db, now)).toEqual({ events: 0, notified: 0 });
    const [n] = await h.db.select().from(notifications).where(and(eq(notifications.userId, KLAUS), like(notifications.title, "Morgen im Haus: Lesung")));
    expect(n!.body).toContain("Aufbau ab 17:30");
    expect(n!.body).toContain("noch nicht bestätigt");
    expect(n!.href).toBe(`/gebaeude/veranstaltungen/${id}`);
  });

  it("Löschklasse ab Veranstaltungsende, Auskunft, Kontolöschung leert die Person", async () => {
    const data = (await collectPersonalData(h.db, JANA))!;
    expect(data.sections.find((s) => s.owner === "gebaeude" && s.table === "veranstaltungen")!.rows.length).toBeGreaterThanOrEqual(1);
    const far = addDays(toBerlinDate(new Date()), 400);
    const item = (await planDeletion(h.db, far)).find((i) => i.table === "gebaeude_veranstaltungen")!;
    expect(item).toMatchObject({ status: "due", classId: "LK-ENDE-1J" });
    expect(item.count).toBeGreaterThanOrEqual(1);
    await deleteAccounts(h.db, [JANA]);
    expect(await h.db.select().from(gebaeudeEvents).where(eq(gebaeudeEvents.organizerId, JANA))).toHaveLength(0);
    expect((await h.db.select().from(gebaeudeEvents)).every((e) => e.organizerId === null)).toBe(true);
    expect(await h.db.select().from(gebaeudeEventHistory).where(eq(gebaeudeEventHistory.actorId, JANA))).toHaveLength(0);
  });
});
