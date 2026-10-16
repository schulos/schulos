import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { addDays, mondayOf, toBerlinDate, toBerlinLocal } from "@/core/time";
import { listUsers, ValidationError } from "@/modules/verwaltung/users";
import { createEvent, deleteEvent, getEvent, listOccurrences, readableCalendars, updateEvent, writableCalendars } from "./service";

describe("Kalender", () => {
  let h: DbHandle;
  let mutter: string;
  let fremd: string;
  const mo = mondayOf(toBerlinDate(new Date()));
  const range = [addDays(mo, -7), addDays(mo, 28)] as const;

  beforeAll(async () => {
    h = await createSeededTestDb();
    mutter = (await listUsers(h.db, { q: "Daniela Schäfer" })).rows[0]!.id;
    fremd = (await listUsers(h.db, { groupId: "g-9a", role: "schueler" })).rows[0]!.id;
  }, 60_000);
  afterAll(() => h.close());
  const p = (id: string) => loadPermissions(h.db, id);
  const titles = async (id: string) => (await listOccurrences(h.db, await p(id), ...range)).map((o) => o.title);

  it("Sichtbarkeit: Klasse, Eltern über Kind, persönlich nur für sich, Schule für alle", async () => {
    const lea = await titles("u-lea.schaefer");
    expect(lea).toContain("Wandertag 7b");
    expect(lea).toContain("Elternsprechtag");
    expect(lea).not.toContain("Korrekturen Erörterung 7b");
    expect(await titles(mutter)).toContain("Elternabend 7b");
    expect(await titles(fremd)).not.toContain("Wandertag 7b");
    expect(await titles("u-jana.brandt")).toContain("Korrekturen Erörterung 7b");
    expect(await titles(fremd)).not.toContain("Lehrerkonferenz");
    expect(await titles("u-daniel.okafor")).toContain("Lehrerkonferenz");
  });

  it("wöchentliche Serie wird aufgefaltet", async () => {
    const occ = (await listOccurrences(h.db, await p("u-lea.schaefer"), ...range)).filter((o) => o.title === "Redaktionstreffen");
    expect(occ.length).toBe(4); // Donnerstage +3, +10, +17, +24 (Bereich endet vor +28; Woche -1 liegt vor dem Start)
    expect(new Set(occ.map((o) => toBerlinLocal(o.start).slice(11)))).toEqual(new Set(["14:15"]));
    expect(occ.every((o) => o.recurring)).toBe(true);
  });

  it("Serie behält über die Zeitumstellung (25.10.2026) dieselbe Ortszeit", async () => {
    const lea = await p("u-lea.schaefer");
    const id = await createEvent(h.db, lea, { calendar: "personal", title: "Nachhilfe", allDay: false, start: "2026-10-19T10:00", end: "2026-10-19T11:00", repeatWeeklyUntil: "2026-11-09" });
    const occ = (await listOccurrences(h.db, lea, "2026-10-19", "2026-11-10", ["personal"])).filter((o) => o.eventId === id);
    expect(occ.map((o) => toBerlinLocal(o.start))).toEqual(["2026-10-19T10:00", "2026-10-26T10:00", "2026-11-02T10:00", "2026-11-09T10:00"]);
    expect(occ[0]!.start.toISOString()).toBe("2026-10-19T08:00:00.000Z"); // MESZ
    expect(occ[1]!.start.toISOString()).toBe("2026-10-26T09:00:00.000Z"); // MEZ
    await deleteEvent(h.db, lea, id);
  });

  it("ganztägig über mehrere Tage", async () => {
    const austausch = (await listOccurrences(h.db, await p("u-lea.schaefer"), ...range)).find((o) => o.title === "Schüleraustausch Frankreich")!;
    expect(austausch.allDay).toBe(true);
    expect(toBerlinDate(austausch.start)).toBe(addDays(mo, 12));
  });

  it("Schreibrechte: persönlich immer, Klasse nur Leitung/Personal, Schule nur mit Recht", async () => {
    const lea = await p("u-lea.schaefer");
    expect((await writableCalendars(h.db, lea)).map((c) => c.key)).toEqual(["personal"]);
    const brandt = await p("u-jana.brandt");
    const keys = (await writableCalendars(h.db, brandt)).map((c) => c.key);
    expect(keys).toContain("group:g-7b");
    expect(keys).not.toContain("school");
    expect((await writableCalendars(h.db, await p("u-sabine.kowalski"))).map((c) => c.key)).toContain("school");
    await expect(createEvent(h.db, lea, { calendar: "group:g-7b", title: "x", allDay: false, start: `${mo}T10:00`, end: `${mo}T11:00` })).rejects.toThrow(ValidationError);
  });

  it("anlegen, ändern, löschen; Validierung", async () => {
    const lea = await p("u-lea.schaefer");
    const id = await createEvent(h.db, lea, { calendar: "personal", title: "Zahnarzt", allDay: false, start: `${mo}T15:00`, end: `${mo}T16:00` });
    await updateEvent(h.db, lea, id, { calendar: "personal", title: "Zahnarzt (verschoben)", allDay: false, start: `${mo}T16:00`, end: `${mo}T17:00` });
    expect((await getEvent(h.db, lea, id))?.title).toBe("Zahnarzt (verschoben)");
    expect(await getEvent(h.db, await p("u-jana.brandt"), id)).toBeNull(); // persönlich = privat
    await expect(createEvent(h.db, lea, { calendar: "personal", title: "x", allDay: false, start: `${mo}T15:00`, end: `${mo}T14:00` })).rejects.toThrow(ValidationError);
    await deleteEvent(h.db, lea, id);
    expect(await getEvent(h.db, lea, id)).toBeNull();
  });

  it("Gruppenkalender nur mit Gruppenmerkmal", async () => {
    const cal = await readableCalendars(h.db, await p("u-lea.schaefer"));
    expect(cal.map((c) => c.label)).toEqual(expect.arrayContaining(["Persönlich", "Schule", "Klasse 7b", "AG Schülerzeitung"]));
  });
});
