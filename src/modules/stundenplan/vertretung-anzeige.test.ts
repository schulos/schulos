// VT-02: Anzeige überall – Marker „neu/geändert“ aus der Historie, „Meine Vertretungen“ mit Kenntnisnahme, Liste Unbestätigter,
// Klassenbuch-Hinweis, Monitor (Grund, Raum „alt → neu“, Tagesmitteilungen, Marker) und Verlauf je Stunde.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { timetableDayNotes, timetableLessons, timetableSubstitutionChanges, timetableSubstitutionDays, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { loadPermissions } from "@/core/permissions";
import { monitorData } from "@/modules/monitor/service";
import { SUBSTITUTION_ACK } from "./settings";
import { saveDayNote } from "./tagesmitteilungen";
import { acknowledgeSubstitution, lessonSubstitution, ownSubstitutions, publishDay, saveSubstitution, substitutionsOn, unacknowledgedSubstitutions } from "./vertretung";
import { describeChange, publicChange, snapshotOf, substitutionHistory } from "./vertretung-historie";

const MO = "2026-10-05";
const BRA = "u-jana.brandt";
const KLE = "u-tobias.kleine";
const WAG = "u-sophie.wagner";
const RIC = "u-jonas.richter";
const PLANUNG = "u-frank.schulte";

describe("VT-02 rein", () => {
  const a = snapshotOf({ lessonId: "l", kind: "substitute", substituteId: "t", roomId: null, subjectId: null, targetPeriod: null, mergeLessonId: null, note: null });
  it("öffentlicher Marker nur bei sichtbaren Feldern", () => {
    expect(publicChange(null, a)).toBe(true);
    expect(publicChange(a, null)).toBe(false);
    expect(publicChange(a, { ...a, internalNote: "x" })).toBe(false);
    expect(publicChange(a, { ...a, internalNote: "x", roomId: "105" })).toBe(true);
  });
  it("Verlauf: Aktion und geänderte Felder", () => {
    expect(describeChange({ action: "create", changed: [] })).toBe("angelegt");
    expect(describeChange({ action: "update", changed: ["substituteId", "roomId"] })).toBe("geändert: Vertretung, Raum");
    expect(describeChange({ action: "delete", changed: [] })).toBe("aufgehoben");
    expect(describeChange({ action: "plan_publish", changed: [] })).toBe("durch Planübernahme entfernt");
  });
});

describe("VT-02 Anzeige", () => {
  let h: DbHandle;
  const ids: Record<string, string> = {};
  const mo = { weekday: 0, validFrom: "2026-08-01", validUntil: null };
  const p = (u: string) => loadPermissions(h.db, u);

  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  beforeEach(async () => {
    await h.db.delete(timetableSubstitutions);
    await h.db.delete(timetableSubstitutionChanges);
    await h.db.delete(timetableSubstitutionDays);
    await h.db.delete(timetableLessons);
    await h.db.delete(timetableDayNotes);
    await writeModuleSetting(h.db, SUBSTITUTION_ACK, "an");
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

  const save = (lessonId: string, kind: "cancel" | "substitute" | "room", extra: Partial<Parameters<typeof saveSubstitution>[2]> = {}) =>
    saveSubstitution(h.db, PLANUNG, { lessonId, date: MO, kind, substituteId: null, roomId: null, note: null, ...extra });
  const backdate = async (lessonId: string, at: Date) => {
    await h.db.update(timetableSubstitutions).set({ createdAt: at }).where(and(eq(timetableSubstitutions.lessonId, lessonId), eq(timetableSubstitutions.date, MO)));
    await h.db.update(timetableSubstitutionChanges).set({ createdAt: at }).where(eq(timetableSubstitutionChanges.lessonId, lessonId));
  };
  const markerOf = async (lessonId: string, since: Date) => (await substitutionsOn(h.db, [MO], { drafts: true, since })).find((e) => e.lessonId === lessonId)?.marker;

  it("Marker: „neu“ seit dem Stichzeitpunkt angelegt, „geändert“ bei sichtbarer Änderung, nicht bei nur internem Hinweis", async () => {
    const old = new Date(Date.now() - 2 * 86_400_000);
    const since = new Date(Date.now() - 86_400_000);
    await save(ids["7b-1"]!, "cancel");
    expect(await markerOf(ids["7b-1"]!, since)).toBe("neu");
    await backdate(ids["7b-1"]!, old);
    expect(await markerOf(ids["7b-1"]!, since)).toBeNull();
    // nur der interne Hinweis → kein öffentlicher Marker
    await save(ids["7b-1"]!, "cancel", { internalNote: "Schlüssel" });
    expect(await markerOf(ids["7b-1"]!, since)).toBeNull();
    // sichtbare Änderung (Hinweis für Schüler:innen)
    await save(ids["7b-1"]!, "cancel", { note: "Sporthalle gesperrt" });
    expect(await markerOf(ids["7b-1"]!, since)).toBe("geaendert");
    // ohne `since` kein Marker
    expect((await substitutionsOn(h.db, [MO], { drafts: true })).every((e) => e.marker === null)).toBe(true);
  });

  it("Meine Vertretungen, Kenntnisnahme und Liste Unbestätigter (nur Planung, nur wenn eingeschaltet)", async () => {
    await save(ids["7b-4"]!, "substitute", { substituteId: WAG, supervisionOnly: true, internalNote: "Arbeitsblätter im Fach" });
    await save(ids["7b-5"]!, "substitute", { substituteId: RIC, roomId: "105" });
    // Entwurfstag (Demo-Schule mit Freigabe): weder „Meine Vertretungen“ noch die Liste
    const isDraft = (await h.db.$count(timetableSubstitutionDays, eq(timetableSubstitutionDays.date, MO))) > 0;
    if (isDraft) {
      expect(await ownSubstitutions(h.db, WAG, [MO])).toEqual([]);
      expect(await unacknowledgedSubstitutions(h.db, await p(PLANUNG), [MO])).toEqual([]);
    }
    await publishDay(h.db, PLANUNG, MO);
    const mine = await ownSubstitutions(h.db, WAG, [MO]);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ lessonId: ids["7b-4"], supervisionOnly: true, internal: { note: "Arbeitsblätter im Fach", acknowledgedAt: null } });
    expect(await ownSubstitutions(h.db, KLE, [MO])).toEqual([]);

    const planning = await p(PLANUNG);
    expect((await unacknowledgedSubstitutions(h.db, planning, [MO])).map((e) => e.lessonId).sort()).toEqual([ids["7b-4"], ids["7b-5"]].sort());
    expect(await unacknowledgedSubstitutions(h.db, await p(WAG), [MO])).toEqual([]);
    await acknowledgeSubstitution(h.db, WAG, mine[0]!.id);
    expect((await ownSubstitutions(h.db, WAG, [MO]))[0]!.internal?.acknowledgedAt).toBeInstanceOf(Date);
    expect((await unacknowledgedSubstitutions(h.db, planning, [MO])).map((e) => e.lessonId)).toEqual([ids["7b-5"]]);
    await writeModuleSetting(h.db, SUBSTITUTION_ACK, "aus");
    expect(await unacknowledgedSubstitutions(h.db, planning, [MO])).toEqual([]);
  });

  it("Klassenbuch-Hinweis: Kategorie und Hinweis für alle, interner Hinweis nur für Vertretung und Planung", async () => {
    await save(ids["7b-5"]!, "substitute", { substituteId: WAG, note: "Lesetext", internalNote: "Klasse unruhig" });
    await publishDay(h.db, PLANUNG, MO);
    const forBra = await lessonSubstitution(h.db, await p(BRA), ids["7b-5"]!, MO);
    expect(forBra).toMatchObject({ kind: "substitute", reason: null, note: "Lesetext" });
    expect(forBra).not.toHaveProperty("internal");
    expect((await lessonSubstitution(h.db, await p(WAG), ids["7b-5"]!, MO))?.internal?.note).toBe("Klasse unruhig");
    expect(await lessonSubstitution(h.db, await p(WAG), ids["7b-1"]!, MO)).toBeNull();
  });

  it("Monitor: Grund, Raum „alt → neu“, Betreuung, Tagesmitteilungen je Zielgruppe, Marker", async () => {
    await save(ids["7b-5"]!, "room", { roomId: "105", reason: "veranstaltung" });
    await save(ids["7b-4"]!, "substitute", { substituteId: WAG, supervisionOnly: true });
    await saveDayNote(h.db, PLANUNG, null, { date: MO, body: "6. Stunde Schulversammlung", audience: "alle" });
    await saveDayNote(h.db, PLANUNG, null, { date: MO, body: "Konferenz 14 Uhr", audience: "beschaeftigte" });
    await publishDay(h.db, PLANUNG, MO);
    const at = new Date("2026-10-05T06:00:00Z");
    const foyer = await monitorData(h.db, { profile: "foyer" }, at);
    const day = foyer.days.find((d) => d.date === MO)!;
    expect(day.notes).toEqual(["6. Stunde Schulversammlung"]);
    expect(day.entries.find((e) => e.period === 5)).toMatchObject({ label: "Raumänderung", room: "105", roomShift: "106 → 105", reason: "Veranstaltung" });
    expect(day.entries.find((e) => e.period === 4)).toMatchObject({ label: "Betreuung", roomShift: "106" });
    // Monitor-Zeit liegt vor dem Anlegen (Testlauf heute) → alles „neu“ seit dem Vortag 18:00
    expect(day.entries.every((e) => e.marker === "neu")).toBe(true);
    const staff = await monitorData(h.db, { profile: "lehrerzimmer" }, at);
    expect(staff.days.find((d) => d.date === MO)!.notes).toEqual(["6. Stunde Schulversammlung", "Konferenz 14 Uhr"]);
  });

  it("Verlauf je Stunde für die Planung", async () => {
    await save(ids["7b-5"]!, "substitute", { substituteId: WAG });
    await save(ids["7b-5"]!, "substitute", { substituteId: RIC, roomId: "105" });
    const list = await substitutionHistory(h.db, await p(PLANUNG), MO, MO, ids["7b-5"]);
    expect(list.map(describeChange)).toEqual(["angelegt", "geändert: Vertretung, Raum"]);
    expect(list.every((c) => c.actorId === PLANUNG)).toBe(true);
  });
});
