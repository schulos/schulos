import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { ganztagMarks, ganztagSessions, groupMembers, notifications, parentChild, users, type GroupKind } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { isEnabled } from "@/core/modules/registry";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { collectPersonalData } from "@/core/privacy/auskunft";
import { deleteAccounts } from "@/core/privacy/konto";
import { OPEN_CALENDAR, SchoolCalendar } from "@/core/school/calendar";
import { MODULES } from "@/modules";
import { courseFeatures } from "@/modules/kurse/service";
import { availableGroupFeatures } from "@/modules/verwaltung/groups";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  createSeries,
  createSession,
  dateLabel,
  deleteSeries,
  deleteSession,
  getOffer,
  getSessionList,
  listEligibleGroups,
  listOffers,
  parseTime,
  recordState,
  seriesDates,
  setAllPresent,
  setListFeature,
  setMark,
  setSessionCancelled,
} from "./service";
import { EDIT_DAYS } from "./settings";

// Feste Daten, unabhängig von Wochentag und Uhrzeit des Testlaufs (`now` wird übergeben).
const XMAS = new SchoolCalendar("NW", [{ id: "x", kind: "ferien", name: "Weihnachtsferien", startsOn: "2026-12-23", endsOn: "2027-01-06" }]);

describe("Ganztag: reine Helfer", () => {
  it("parseTime normalisiert und lehnt Unsinn ab", () => {
    expect(parseTime("9:05")).toBe("09:05");
    expect(parseTime(" 14:00 ")).toBe("14:00");
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("14.00")).toBeNull();
  });

  it("dateLabel: kurzer Wochentag + Datum", () => {
    expect(dateLabel("2026-11-10")).toBe("Di, 10.11.2026");
  });

  it("seriesDates überspringt Ferien und Feiertage und nennt den Grund", () => {
    // Montage 07.12.2026 … 18.01.2027: 28.12. und 04.01. liegen in den Weihnachtsferien
    const r = seriesDates(XMAS, 0, "2026-12-07", "2027-01-18");
    expect(r.dates).toEqual(["2026-12-07", "2026-12-14", "2026-12-21", "2027-01-11", "2027-01-18"]);
    expect(r.skipped).toEqual([
      { date: "2026-12-28", reason: "Weihnachtsferien" },
      { date: "2027-01-04", reason: "Weihnachtsferien" },
    ]);
    // Donnerstag 06.05.2027 = Christi Himmelfahrt (bundesweit)
    const t = seriesDates(XMAS, 3, "2027-04-29", "2027-05-13");
    expect(t.dates).toEqual(["2027-04-29", "2027-05-13"]);
    expect(t.skipped).toEqual([{ date: "2027-05-06", reason: "Feiertag (Christi Himmelfahrt)" }]);
    // Beginn mitten in der Woche: erster passender Wochentag danach
    expect(seriesDates(OPEN_CALENDAR, 1, "2026-11-12", "2026-11-30").dates).toEqual(["2026-11-17", "2026-11-24"]);
  });

  it("recordState: nicht vor dem Tag, Leitung bis N Tage danach, Verwaltung auch später", () => {
    const s = (date: string) => ({ date, status: "geplant" as const });
    expect(recordState(s("2026-11-11"), "2026-11-10", 7, false)).toBe("zukunft");
    expect(recordState(s("2026-11-10"), "2026-11-10", 0, false)).toBe("offen");
    expect(recordState(s("2026-11-03"), "2026-11-10", 7, false)).toBe("offen");
    expect(recordState(s("2026-11-02"), "2026-11-10", 7, false)).toBe("abgelaufen");
    expect(recordState(s("2026-11-02"), "2026-11-10", 7, true)).toBe("offen");
    expect(recordState({ date: "2026-11-10", status: "ausgefallen" }, "2026-11-10", 7, true)).toBe("ausgefallen");
  });
});

describe("Ganztag: Gruppenmerkmal", () => {
  it("wird nur für AG/Förderkurs/frei angeboten und nie im Kursraum", () => {
    const ids = (kind: GroupKind) => availableGroupFeatures(MODULES, { kind }).map((f) => f.id);
    expect(ids("ag")).toContain("ganztag.liste");
    expect(ids("foerderkurs")).toContain("ganztag.liste");
    expect(ids("klasse")).not.toContain("ganztag.liste");
    expect(ids("kurs")).not.toContain("ganztag.liste");
    const on = new Map(MODULES.map((m) => [m.id, true]));
    expect(MODULES.every((m) => isEnabled(m, on))).toBe(true);
    expect(courseFeatures(on, "ag").map((f) => f.id)).not.toContain("ganztag.liste");
    expect(courseFeatures(on, "ag").map((f) => f.id)).toContain("foren.forum");
  });
});

describe("Ganztag: Termine und Listen (DB)", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  const SEKRETARIAT = "u-sabine.kowalski";
  const RICHTER = "u-jonas.richter"; // Leitung AG Schulchor
  const BRANDT = "u-jana.brandt"; // Leitung AG Schülerzeitung, nicht Schulchor
  const CHOR = "g-ag-schulchor";
  const NOW = new Date("2026-11-10T15:00:00Z"); // Dienstag
  let kids: string[] = [];

  beforeAll(async () => {
    h = await createSeededTestDb();
    kids = (
      await h.db
        .select({ id: groupMembers.userId })
        .from(groupMembers)
        .innerJoin(users, eq(users.id, groupMembers.userId))
        .where(and(eq(groupMembers.groupId, CHOR), eq(groupMembers.role, "member"), eq(users.role, "schueler")))
        .orderBy(groupMembers.userId)
    ).map((r) => r.id);
  }, 60_000);
  afterAll(async () => h?.close());

  it("Merkmal: nur „Ganztag verwalten“, nur passende Gruppenarten; Demo hat zwei AGs mit Liste", async () => {
    const sek = await p(SEKRETARIAT);
    const before = await listEligibleGroups(h.db, sek);
    expect(before.filter((g) => g.listOn).map((g) => g.id).sort()).toEqual(["g-ag-robotik", "g-ag-schuelerzeitung"]);
    expect(before.some((g) => g.id === "g-7b")).toBe(false);
    await expect(setListFeature(h.db, await p(RICHTER), CHOR, true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setListFeature(h.db, sek, "g-7b", true)).rejects.toBeInstanceOf(ValidationError);
    // ohne Merkmal kein Angebot – auch nicht für die Leitung
    expect(await getOffer(h.db, await p(RICHTER), CHOR, NOW)).toBeNull();
    await setListFeature(h.db, sek, CHOR, true);
    expect((await listEligibleGroups(h.db, sek)).find((g) => g.id === CHOR)).toMatchObject({ listOn: true, leaders: ["Jonas Richter"] });
  });

  it("Leitung sieht und pflegt nur eigene Angebote; Verwaltung alle", async () => {
    const richter = await p(RICHTER);
    const brandt = await p(BRANDT);
    expect((await listOffers(h.db, richter, NOW)).map((o) => o.id)).toEqual([CHOR]);
    expect((await listOffers(h.db, brandt, NOW)).map((o) => o.id)).toEqual(["g-ag-schuelerzeitung"]);
    expect((await listOffers(h.db, await p(SEKRETARIAT), NOW)).map((o) => o.id).sort()).toEqual(["g-ag-robotik", CHOR, "g-ag-schuelerzeitung"].sort());
    expect(await listOffers(h.db, await p("u-lea.schaefer"), NOW)).toEqual([]);
    expect(await getOffer(h.db, brandt, CHOR, NOW)).toBeNull();
    await expect(createSession(h.db, brandt, CHOR, { date: "2026-11-10", startsAt: "16:00", endsAt: "17:00" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Serie mit Ferien, Prüfung der Eingaben, Löschen behält Erfasstes", async () => {
    const richter = await p(RICHTER);
    await expect(createSeries(h.db, richter, CHOR, { weekday: 5, startsAt: "14:00", endsAt: "13:00", validFrom: "2026-12-07", validTo: "2026-12-01" }, XMAS)).rejects.toMatchObject({
      fieldErrors: { weekday: expect.any(String), endsAt: expect.any(String), validTo: expect.any(String) },
    });
    const r = await createSeries(h.db, richter, CHOR, { weekday: 0, startsAt: "14:00", endsAt: "15:30", validFrom: "2026-12-07", validTo: "2027-01-18" }, XMAS);
    expect(r.created).toBe(5);
    expect(r.skipped.map((s) => s.date)).toEqual(["2026-12-28", "2027-01-04"]);
    const offer = (await getOffer(h.db, richter, CHOR, NOW))!;
    expect(offer.series).toEqual([expect.objectContaining({ weekday: 0, startsAt: "14:00", sessions: 5 })]);
    expect(offer.sessions.map((s) => s.date)).toEqual(["2026-12-07", "2026-12-14", "2026-12-21", "2027-01-11", "2027-01-18"]);
    expect(offer.defaults).toEqual({ validFrom: "2026-11-10", validTo: "2027-07-31" });

    // einen Termin erfassen (Verwaltung darf nachtragen, hier am 07.12.), dann Serie löschen: der erfasste bleibt
    const first = offer.sessions[0]!;
    const sek = await p(SEKRETARIAT);
    await setMark(h.db, sek, first.id, kids[0]!, "anwesend", null, new Date("2026-12-07T15:00:00Z"));
    expect(await deleteSeries(h.db, richter, r.seriesId)).toEqual({ removed: 4, kept: 1 });
    const after = (await getOffer(h.db, richter, CHOR, NOW))!;
    expect(after.series).toEqual([]);
    expect(after.sessions).toEqual([expect.objectContaining({ id: first.id, seriesId: null, status: "erfasst", marks: 1 })]);
    // erfasste Termine löscht nur die Verwaltung
    await expect(deleteSession(h.db, richter, first.id)).rejects.toBeInstanceOf(ValidationError);
    await deleteSession(h.db, sek, first.id);
    expect(await h.db.select().from(ganztagMarks).where(eq(ganztagMarks.sessionId, first.id))).toEqual([]);
  });

  it("Liste startet leer; „alle anwesend“ als Schalter; Handmarkierungen bleiben", async () => {
    const richter = await p(RICHTER);
    const id = await createSession(h.db, richter, CHOR, { date: "2026-11-10", startsAt: "16:00", endsAt: "17:00" });
    await expect(createSession(h.db, richter, CHOR, { date: "2026-11-10", startsAt: "16:00", endsAt: "17:30" })).rejects.toBeInstanceOf(ValidationError);
    expect(kids.length).toBeGreaterThan(2);

    let list = (await getSessionList(h.db, richter, id, NOW))!;
    expect(list.state).toBe("offen");
    expect(list.rows.map((r) => r.studentId).sort()).toEqual([...kids].sort());
    expect(list.rows.every((r) => r.status === null)).toBe(true);
    expect(list.counts).toEqual({ anwesend: 0, fehlt: 0, verspaetet: 0, offen: kids.length });
    expect(list.session.status).toBe("geplant");

    await setMark(h.db, richter, id, kids[0]!, "fehlt", null, NOW);
    await setMark(h.db, richter, id, kids[1]!, "verspaetet", 10, NOW);
    await expect(setMark(h.db, richter, id, kids[2]!, "verspaetet", 999, NOW)).rejects.toBeInstanceOf(ValidationError);
    expect(await setAllPresent(h.db, richter, id, true, NOW)).toBe(kids.length - 2);
    list = (await getSessionList(h.db, richter, id, NOW))!;
    expect(list.session).toMatchObject({ allPresent: true, status: "erfasst" });
    expect(list.counts).toEqual({ anwesend: kids.length - 2, fehlt: 1, verspaetet: 1, offen: 0 });
    expect(list.rows.find((r) => r.studentId === kids[1])).toMatchObject({ status: "verspaetet", minutesLate: 10 });

    // eine Zeile von Hand bestätigt → bleibt beim Ausschalten
    await setMark(h.db, richter, id, kids[2]!, "anwesend", null, NOW);
    expect(await setAllPresent(h.db, richter, id, false, NOW)).toBe(kids.length - 3);
    list = (await getSessionList(h.db, richter, id, NOW))!;
    expect(list.counts).toEqual({ anwesend: 1, fehlt: 1, verspaetet: 1, offen: kids.length - 3 });

    // leeren → wieder geplant
    for (const k of kids.slice(0, 3)) await setMark(h.db, richter, id, k, null, null, NOW);
    expect((await getSessionList(h.db, richter, id, NOW))!.session.status).toBe("geplant");

    // Fremde dürfen nicht, Nicht-Mitglieder nicht in die Liste
    await expect(setMark(h.db, await p(BRANDT), id, kids[0]!, "fehlt", null, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await getSessionList(h.db, await p(BRANDT), id, NOW)).toBeNull();
    await expect(setMark(h.db, richter, id, "u-lea.schaefer", "fehlt", null, NOW)).rejects.toBeInstanceOf(ValidationError);
  });

  it("Erfassungsfenster: nicht vorab, Leitung bis 7 Tage (Einstellung), Verwaltung später", async () => {
    const richter = await p(RICHTER);
    const sek = await p(SEKRETARIAT);
    const future = await createSession(h.db, richter, CHOR, { date: "2026-11-11", startsAt: "16:00", endsAt: "17:00" });
    await expect(setMark(h.db, richter, future, kids[0]!, "anwesend", null, NOW)).rejects.toMatchObject({ fieldErrors: { sessionId: expect.stringContaining("erst am Tag") } });
    const old = await createSession(h.db, richter, CHOR, { date: "2026-11-02", startsAt: "16:00", endsAt: "17:00" });
    expect((await getSessionList(h.db, richter, old, NOW))!.state).toBe("abgelaufen");
    await expect(setAllPresent(h.db, richter, old, true, NOW)).rejects.toBeInstanceOf(ValidationError);
    await setMark(h.db, sek, old, kids[0]!, "fehlt", null, NOW);
    await writeModuleSetting(h.db, EDIT_DAYS, "14");
    await setMark(h.db, richter, old, kids[0]!, "anwesend", null, NOW);
    await writeModuleSetting(h.db, EDIT_DAYS, "7");
    expect((await listOffers(h.db, richter, NOW)).find((o) => o.id === CHOR)).toMatchObject({ next: { id: future, date: "2026-11-11" } });
  });

  it("Ausfall: Gong an Teilnehmende und Eltern, keine Erfassung, zurücknehmen; vergangene ohne Gong", async () => {
    const richter = await p(RICHTER);
    const id = await createSession(h.db, richter, CHOR, { date: "2026-11-12", startsAt: "14:00", endsAt: "15:00" });
    const parents = (await h.db.select({ id: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, kids[0]!))).map((r) => r.id);
    expect(parents.length).toBeGreaterThan(0);
    const sent = await setSessionCancelled(h.db, richter, id, true, NOW);
    expect(sent).toBeGreaterThanOrEqual(kids.length + 1);
    const gongs = await h.db.select().from(notifications).where(eq(notifications.moduleId, "ganztag"));
    const to = new Set(gongs.map((g) => g.userId));
    for (const k of kids) expect(to.has(k)).toBe(true);
    expect(to.has(parents[0]!)).toBe(true);
    expect(to.has(RICHTER)).toBe(false);
    expect(gongs[0]).toMatchObject({ title: "AG Schulchor fällt aus", body: "Do, 12.11.2026, 14:00–15:00 Uhr" });
    // am Tag selbst: ausgefallen lässt sich nicht erfassen
    await expect(setMark(h.db, richter, id, kids[0]!, "anwesend", null, new Date("2026-11-12T15:00:00Z"))).rejects.toMatchObject({ fieldErrors: { sessionId: "Der Termin ist ausgefallen" } });
    expect(await setSessionCancelled(h.db, richter, id, false, NOW)).toBeGreaterThan(0);
    expect((await h.db.select().from(ganztagSessions).where(eq(ganztagSessions.id, id)))[0]).toMatchObject({ status: "geplant", cancelledAt: null });
    // vergangener Termin: Ausfall vermerken ohne Gong; erfasster Termin fällt nicht aus
    const past = await createSession(h.db, richter, CHOR, { date: "2026-11-09", startsAt: "14:00", endsAt: "15:00" });
    expect(await setSessionCancelled(h.db, richter, past, true, NOW)).toBe(0);
    const rec = await createSession(h.db, richter, CHOR, { date: "2026-11-10", startsAt: "08:00", endsAt: "09:00" });
    await setMark(h.db, richter, rec, kids[0]!, "anwesend", null, NOW);
    await expect(setSessionCancelled(h.db, richter, rec, true, NOW)).rejects.toBeInstanceOf(ValidationError);
  });

  it("Datenschutz: Auskunft der Schüler:in enthält die eigenen Zeilen; Kontolöschung räumt auf", async () => {
    const richter = await p(RICHTER);
    const id = await createSession(h.db, richter, CHOR, { date: "2026-11-10", startsAt: "18:00", endsAt: "19:00" });
    const kid = kids[kids.length - 1]!;
    await setMark(h.db, richter, id, kid, "verspaetet", 5, NOW);
    const data = (await collectPersonalData(h.db, kid))!;
    const own = data.sections.find((s) => s.table === "ganztag_marks" && !s.asActor);
    expect(own?.rows).toEqual([expect.objectContaining({ session_id: id, status: "verspaetet", minutes_late: 5 })]);
    // Leitung: nur die Handlung, ohne Schüler:in und Status
    const lead = (await collectPersonalData(h.db, RICHTER))!.sections.find((s) => s.table === "ganztag_marks" && s.asActor);
    expect(lead?.rows.length).toBeGreaterThan(0);
    for (const r of lead!.rows) {
      expect(r).not.toHaveProperty("student_id");
      expect(r).not.toHaveProperty("status");
    }

    await deleteAccounts(h.db, [kid]);
    expect(await h.db.select().from(ganztagMarks).where(eq(ganztagMarks.studentId, kid))).toEqual([]);
    await deleteAccounts(h.db, [RICHTER]);
    const [s] = await h.db.select().from(ganztagSessions).where(eq(ganztagSessions.id, id));
    expect(s).toMatchObject({ recordedBy: null });
    expect((await h.db.select().from(ganztagMarks).where(eq(ganztagMarks.sessionId, id))).length).toBe(0);
  });
});
