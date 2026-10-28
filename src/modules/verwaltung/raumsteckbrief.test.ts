import { and, asc, desc, eq, gte, isNotNull, isNull, lte, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import {
  auditLog,
  gebaeudeInspectionTypes,
  gebaeudeInspections,
  gebaeudeTickets,
  parentChild,
  roomInfoFields,
  roomInfoValues,
  timetableLessons,
  timetableRoomBlocks,
  users,
} from "@/core/db/schema";
import { createSeededTestDb, createTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { addDays } from "@/core/time";
import {
  DEFAULT_INFO_FIELDS,
  createInfoField,
  deleteInfoField,
  ensureDefaultInfoFields,
  listInfoFields,
  roomAudience,
  roomDirectory,
  roomInfo,
  roomProfile,
  setRoomInfo,
  slotFor,
  updateInfoField,
} from "./raumsteckbrief";
import { setRoomActive } from "./rooms";
import { ROOM_OCCUPANCY_FAMILY } from "./settings";
import { ValidationError } from "./users";

// feste Schulwoche ohne Demo-Ferien (createSeededTestDb legt keine an) und ohne Demo-Vertretungen
const MONDAY = "2027-03-01";
const TODAY = "2027-03-02";
const ALL_ON = { stundenplan: true, gebaeude: true, buchungen: true };
const JANA = "u-jana.brandt"; // Lehrkraft
const LEA = "u-lea.schaefer"; // Schülerin
const SABINE = "u-sabine.kowalski"; // Sekretariat: verwaltung.school
const KLAUS = "u-klaus.berger"; // Hausmeisterei: gebaeude.manage

describe("Raumsteckbrief: Vorgabe-Infofelder", () => {
  it("Migration legt die sechs Vorgaben an (wie DEFAULT_INFO_FIELDS); ensureDefaultInfoFields ändert Vorhandenes nicht", async () => {
    const h = await createTestDb();
    try {
      const pick = (r: { id: string; label: string; visibility: string; sortOrder: number }) => ({ id: r.id, label: r.label, visibility: r.visibility, sortOrder: r.sortOrder });
      expect((await listInfoFields(h.db)).map(pick)).toEqual(DEFAULT_INFO_FIELDS);
      await h.db.update(roomInfoFields).set({ label: "Netz und Technik" }).where(eq(roomInfoFields.id, "technik"));
      await ensureDefaultInfoFields(h.db);
      expect((await listInfoFields(h.db)).find((f) => f.id === "technik")?.label).toBe("Netz und Technik");
      await h.db.delete(roomInfoFields);
      await ensureDefaultInfoFields(h.db);
      expect(await listInfoFields(h.db)).toHaveLength(6);
    } finally {
      await h.close();
    }
  });
});

describe("Raumsteckbrief (RS-02/RS-03)", () => {
  let h: DbHandle;
  let parentId: string;
  const p = (id: string) => loadPermissions(h.db, id);
  const profile = async (userId: string, roomId = "NW2", modules = ALL_ON) => (await roomProfile(h.db, await p(userId), roomId, { today: TODAY, monday: MONDAY, modules }))!;

  beforeAll(async () => {
    h = await createSeededTestDb();
    const [pc] = await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, LEA)).orderBy(asc(parentChild.parentId));
    parentId = pc!.parentId;
  }, 60_000);
  afterAll(() => h.close());

  it("Sicht: Beschäftigte = personal, Schüler:innen und Eltern = familie", async () => {
    expect(roomAudience(await p(JANA))).toBe("personal");
    expect(roomAudience(await p(KLAUS))).toBe("personal");
    expect(roomAudience(await p(LEA))).toBe("familie");
    expect(roomAudience(await p(parentId))).toBe("familie");
  });

  it("Belegung: Lehrkraft mit Klasse und Lehrkraft, Schülerin und Eltern nur frei/belegt", async () => {
    // eine Stunde des Plans in einem Raum mit Lehrkraft – deterministisch gewählt
    const [lesson] = await h.db
      .select({ roomId: timetableLessons.roomId, weekday: timetableLessons.weekday, periodNr: timetableLessons.periodNr, code: users.shortCode })
      .from(timetableLessons)
      .innerJoin(users, eq(users.id, timetableLessons.teacherId))
      .where(
        and(
          isNotNull(timetableLessons.roomId),
          isNotNull(users.shortCode),
          eq(timetableLessons.week, "all"),
          lte(timetableLessons.validFrom, MONDAY),
          or(isNull(timetableLessons.validUntil), gte(timetableLessons.validUntil, addDays(MONDAY, 4))),
        ),
      )
      .orderBy(asc(timetableLessons.roomId), asc(timetableLessons.weekday), asc(timetableLessons.periodNr), asc(timetableLessons.id))
      .limit(1);
    const date = addDays(MONDAY, lesson!.weekday);
    const staff = await profile(JANA, lesson!.roomId!);
    const slot = staff.week!.days.find((d) => d.date === date)!.slots.get(lesson!.periodNr)!;
    expect(slot.state).toBe("belegt");
    expect(slot).toMatchObject({ kind: "lesson", label: expect.stringContaining(" · ") });
    expect(slot.state === "belegt" && slot.teacher?.split(", ")).toContain(lesson!.code);

    for (const viewer of [LEA, parentId]) {
      const fam = await profile(viewer, lesson!.roomId!);
      expect(fam.week!.days.find((d) => d.date === date)!.slots.get(lesson!.periodNr)).toEqual({ state: "belegt" });
      const json = JSON.stringify(fam.week!.days.map((d) => [...d.slots.values()]));
      expect(json).not.toContain(lesson!.code!);
      expect(json).not.toMatch(/label|teacher|kind/);
    }
    // gleiche Wochenform: 5 Tage, alle Stunden des Zeitrasters
    expect(staff.week!.days.map((d) => d.date)).toEqual([0, 1, 2, 3, 4].map((i) => addDays(MONDAY, i)));
  });

  it("slotFor: Sperre und Buchung erscheinen für Schüler:innen/Eltern nur als belegt; Ferien als frei", () => {
    expect(slotFor({ kind: "blocked", label: "Gesperrt: Prüfung (Abitur)" }, "familie")).toEqual({ state: "belegt" });
    expect(slotFor({ kind: "booking", label: "Buchung BRA" }, "personal")).toEqual({ state: "belegt", kind: "booking", label: "Buchung BRA" });
    expect(slotFor({ kind: "closed", label: "Ferien" }, "personal")).toEqual({ state: "frei" });
    expect(slotFor(undefined, "familie")).toEqual({ state: "frei" });
  });

  it("Infofelder: Personal-Felder nur für Beschäftigte (Demo NW2)", async () => {
    const staff = await profile(JANA);
    expect(staff.info.map((i) => i.label)).toEqual(["Technik/Netz", "Sicherheit", "Fenster/Lüftung", "Fläche"]);
    for (const viewer of [LEA, parentId]) {
      const fam = await profile(viewer);
      expect(fam.info.map((i) => [i.label, i.visibility])).toEqual([
        ["Fenster/Lüftung", "alle"],
        ["Fläche", "alle"],
      ]);
      expect(JSON.stringify(fam)).not.toContain("Not-Aus");
      expect(JSON.stringify(fam)).not.toContain("HDMI");
    }
  });

  it("Mängel nur für Beschäftigte, ohne Namen; Link nur für Melder:in und wer alle Meldungen sieht", async () => {
    await h.db.insert(gebaeudeTickets).values([
      { year: 2099, seq: 1, category: "technik", priority: "hoch", roomId: "NW2", title: "Abzug läuft nicht an", reporterId: JANA },
      { year: 2099, seq: 2, category: "it", roomId: "NW2", title: "Beamer flackert", reporterId: KLAUS, status: "erledigt", closedAt: new Date() },
    ]);
    const jana = await profile(JANA);
    expect(jana.defects!.map((d) => [d.number, d.title, d.canOpen])).toEqual([["M-2099-0001", "Abzug läuft nicht an", true]]);
    expect(JSON.stringify(jana.defects)).not.toContain("Brandt");
    const klaus = await profile(KLAUS);
    expect(klaus.defects!.map((d) => d.canOpen)).toEqual([true]);
    // andere Lehrkraft: sieht den Mangel, öffnet die Meldung aber nicht
    const [other] = await h.db.select({ id: users.id }).from(users).where(and(eq(users.role, "lehrkraft"), isNotNull(users.shortCode))).orderBy(desc(users.id)).limit(1);
    expect((await profile(other!.id)).defects!.map((d) => d.canOpen)).toEqual([false]);
    for (const viewer of [LEA, parentId]) {
      const fam = await profile(viewer);
      expect(fam.defects).toBeNull();
      expect(JSON.stringify(fam)).not.toContain("Abzug läuft nicht an");
    }
    // Modul aus → kein Abschnitt
    expect((await profile(JANA, "NW2", { ...ALL_ON, gebaeude: false })).defects).toBeNull();
  });

  it("fällige Prüfungen nur mit gebaeude.manage/view_all", async () => {
    const [type] = await h.db
      .insert(gebaeudeInspectionTypes)
      .values({ name: "Gasanlage prüfen", appliesTo: "raum", intervalMonths: 12, warnDays: 30, active: true })
      .returning({ id: gebaeudeInspectionTypes.id });
    await h.db.insert(gebaeudeInspections).values([
      { typeId: type!.id, roomId: "NW2", dueOn: addDays(TODAY, -3) },
      { typeId: type!.id, roomId: "NW2", dueOn: addDays(TODAY, 200) }, // noch nicht fällig
    ]);
    expect((await profile(KLAUS)).inspections!.map((i) => [i.typeName, i.state])).toEqual([["Gasanlage prüfen", "ueberfaellig"]]);
    expect((await profile(JANA)).inspections).toBeNull();
    expect((await profile(LEA)).inspections).toBeNull();
  });

  it("Banner: laufende Sperre (Notiz nur für Personal), geplante Sperre, stillgelegt", async () => {
    await h.db.insert(timetableRoomBlocks).values([
      { roomId: "NW2", startsOn: MONDAY, endsOn: addDays(MONDAY, 3), reason: "pruefung", note: "Abiturklausur Chemie" },
      { roomId: "NW2", startsOn: addDays(TODAY, 7), endsOn: addDays(TODAY, 7), fromPeriod: 1, toPeriod: 2, reason: "renovierung" },
      { roomId: "NW2", startsOn: addDays(TODAY, 30), endsOn: addDays(TODAY, 30), reason: "sonstiges" }, // zu weit weg
    ]);
    const staff = await profile(JANA);
    expect(staff.blocks).toEqual([expect.objectContaining({ endsOn: addDays(MONDAY, 3), reasonLabel: "Prüfung", note: "Abiturklausur Chemie" })]);
    expect(staff.upcomingBlocks.map((b) => [b.startsOn, b.reasonLabel, b.fromPeriod])).toEqual([[addDays(TODAY, 7), "Renovierung", 1]]);
    const lea = await profile(LEA);
    expect(lea.blocks.map((b) => [b.reasonLabel, b.note])).toEqual([["Prüfung", null]]);
    expect(JSON.stringify(lea)).not.toContain("Abiturklausur");
    // die Sperre belegt den Raum in der Woche – für die Schülerin ohne Grund
    expect(lea.week!.days[0]!.slots.get(1)).toEqual({ state: "belegt" });
    expect(staff.week!.days[0]!.slots.get(1)).toMatchObject({ kind: "blocked" });

    expect(staff.room.active).toBe(true);
    await setRoomActive(h.db, SABINE, "NW3", false);
    expect((await profile(LEA, "NW3")).room.active).toBe(false);
    await setRoomActive(h.db, SABINE, "NW3", true);
    expect(await roomProfile(h.db, await p(LEA), "GIBTSNICHT", { today: TODAY, monday: MONDAY, modules: ALL_ON })).toBeNull();
  });

  it("Moduleinstellung: Belegung für Schüler:innen/Eltern abschaltbar, Beschäftigte sehen sie weiter; Stundenplan aus → keine Belegung", async () => {
    await writeModuleSetting(h.db, ROOM_OCCUPANCY_FAMILY, "aus");
    expect((await profile(LEA)).week).toBeNull();
    expect((await profile(parentId)).week).toBeNull();
    expect((await profile(JANA)).week).not.toBeNull();
    await writeModuleSetting(h.db, ROOM_OCCUPANCY_FAMILY, "frei_belegt");
    expect((await profile(LEA)).week).not.toBeNull();
    expect((await profile(JANA, "NW2", { ...ALL_ON, stundenplan: false })).week).toBeNull();
  });

  it("Infofelder pflegen: nur mit verwaltung.school, trimmt, leer löscht, Audit nennt Felder statt Texte", async () => {
    const [jana, sabine, lea] = await Promise.all([p(JANA), p(SABINE), p(LEA)]);
    await expect(setRoomInfo(h.db, jana, "101", { technik: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setRoomInfo(h.db, lea, "101", { technik: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await setRoomInfo(h.db, sabine, "101", { technik: "  Beamer neu  ", lueftung: "", durchwahl: "4711" })).toBe(3);
    expect((await roomInfo(h.db, "101", "personal")).map((i) => [i.fieldId, i.value])).toEqual([
      ["technik", "Beamer neu"],
      ["durchwahl", "4711"],
    ]);
    expect(await roomInfo(h.db, "101", "familie")).toEqual([]);
    // unverändert → keine Änderung, kein Audit
    expect(await setRoomInfo(h.db, sabine, "101", { technik: "Beamer neu" })).toBe(0);
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.room.info")).orderBy(asc(auditLog.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: SABINE, target: "101", meta: { fields: ["Technik/Netz", "Fenster/Lüftung", "Durchwahl"] } });
    expect(JSON.stringify(audits[0]!.meta)).not.toContain("4711");

    await expect(setRoomInfo(h.db, sabine, "101", { gibtsnicht: "x" })).rejects.toMatchObject({ fieldErrors: { gibtsnicht: "Unbekanntes Infofeld" } });
    await expect(setRoomInfo(h.db, sabine, "101", { technik: "x".repeat(1001) })).rejects.toBeInstanceOf(ValidationError);
    await expect(setRoomInfo(h.db, sabine, "GIBTSNICHT", { technik: "x" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("Infofelder festlegen: Rechte, Dubletten, Sichtbarkeit wirkt sofort, Löschen nimmt die Werte mit", async () => {
    const [jana, sabine] = await Promise.all([p(JANA), p(SABINE)]);
    await expect(createInfoField(h.db, jana, { label: "Schlüssel", visibility: "personal" })).rejects.toBeInstanceOf(ForbiddenError);
    const id = await createInfoField(h.db, sabine, { label: " Schlüssel ", visibility: "personal" });
    expect((await listInfoFields(h.db)).at(-1)).toMatchObject({ id, label: "Schlüssel", visibility: "personal", sortOrder: 7 });
    await expect(createInfoField(h.db, sabine, { label: "SCHLÜSSEL", visibility: "alle" })).rejects.toMatchObject({ fieldErrors: { label: "Diese Bezeichnung gibt es schon" } });
    await expect(createInfoField(h.db, sabine, { label: "x", visibility: "geheim", sortOrder: "-1" })).rejects.toMatchObject({
      fieldErrors: { visibility: "Sichtbarkeit wählen", sortOrder: "Reihenfolge 0–999 oder leer" },
    });

    await setRoomInfo(h.db, sabine, "015", { [id]: "Schlüssel im Sekretariat, Schrank 3" });
    expect((await roomInfo(h.db, "015", "familie")).map((i) => i.label)).toEqual([]);
    await updateInfoField(h.db, sabine, id, { label: "Schlüssel", visibility: "alle", sortOrder: "0" });
    expect((await roomInfo(h.db, "015", "familie")).map((i) => i.label)).toEqual(["Schlüssel"]);
    // eigene Bezeichnung beim Speichern ist keine Dublette
    await updateInfoField(h.db, sabine, id, { label: "Schlüssel", visibility: "personal" });
    expect((await listInfoFields(h.db))[0]).toMatchObject({ id, sortOrder: 0, visibility: "personal" });
    await expect(updateInfoField(h.db, jana, id, { label: "y", visibility: "alle" })).rejects.toBeInstanceOf(ForbiddenError);

    await expect(deleteInfoField(h.db, jana, id)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteInfoField(h.db, sabine, id);
    expect(await h.db.select().from(roomInfoValues).where(eq(roomInfoValues.fieldId, id))).toEqual([]);
    expect(await h.db.select().from(roomInfoFields).where(eq(roomInfoFields.id, id))).toEqual([]);
    const [del] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.room.info_field.delete")).orderBy(desc(auditLog.id)).limit(1);
    expect(del).toMatchObject({ target: id, meta: { label: "Schlüssel", values: 1 } });
  });

  it("Umbenennen des Raums zieht die Infofelder mit (Fremdschlüssel)", async () => {
    const sabine = await p(SABINE);
    await setRoomInfo(h.db, sabine, "BIB", { flaeche: "120 m²" });
    const { updateRoom } = await import("./rooms");
    await updateRoom(h.db, SABINE, "BIB", { code: "BIB2", name: "Bibliothek", kind: "sonstiges", equipment: [], accessible: true, active: true });
    expect((await roomInfo(h.db, "BIB2", "familie")).map((i) => i.value)).toEqual(["120 m²"]);
  });

  it("Raumliste/Suche: nur aktive Räume, Kürzel numerisch sortiert", async () => {
    const hits = await roomDirectory(h.db, "Raum 10");
    expect(hits.map((r) => r.id).slice(0, 3)).toEqual(["101", "102", "103"]);
    await setRoomActive(h.db, SABINE, "TH2", false);
    expect((await roomDirectory(h.db, "Sporthalle")).map((r) => r.id)).toEqual(["TH1"]);
  });
});
