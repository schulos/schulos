import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, groupMembers, notifications, timetableAbsenceMaterials, timetableAbsences, timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import type { FileStorage } from "@/core/files/storage";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { needsOn } from "./abwesenheit";
import {
  affectedLessons,
  decideAbsence,
  materialFor,
  materialsFor,
  myAbsences,
  pendingRequests,
  reportOwnAbsence,
  saveMaterial,
  spanText,
  withdrawOwnAbsence,
} from "./selbstmeldung";
import { saveSubstitution } from "./vertretung";

// P4-74 + Q5-12: Lehrkräfte melden die eigene Abwesenheit, Schulleitung genehmigt Fortbildung/dienstlich, Vertretungsmaterial je Stunde.
const TODAY = "2026-10-02"; // Freitag
const MO = "2026-10-05";
const DI = "2026-10-06";
const JANA = "u-jana.brandt";
const PETRA = "u-petra.lindner"; // Schulleitung
const SEKRETARIAT = "u-sabine.kowalski"; // keine Lehrkraft, plant nicht (SP-03)
const PLANUNG = "u-frank.schulte"; // Gruppe Stundenplanung (stundenplan.manage/.substitute)
const OTHER = "u-murat.yilmaz"; // Lehrkraft ohne Planungsrecht (Tobias Kleine ist Schulleitung → seit SP-02 `substitute`)
const LEA = "u-lea.schaefer"; // 7b

function memStorage(): FileStorage & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    put: async (k: string, d: Uint8Array) => void files.set(k, d),
    get: async (k: string) => files.get(k) ?? null,
    delete: async (k: string) => void files.delete(k),
    list: async () => [...files.keys()].map((key) => ({ key, size: files.get(key)!.byteLength, modifiedAt: new Date() })),
  } as unknown as FileStorage & { files: Map<string, Uint8Array> };
}

async function fe(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("Abwesenheit selbst melden (P4-74) und Vertretungsmaterial (Q5-12)", () => {
  let h: DbHandle;
  const ids: Record<string, string> = {};
  const p = (u: string) => loadPermissions(h.db, u);
  const storage = memStorage();
  const krank = { startsOn: MO, endsOn: MO, fromPeriod: null, toPeriod: null, reason: "krank", note: null };

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(timetableLessons);
    const base = { weekday: 0, validFrom: "2026-08-01", validUntil: null };
    const rows = await h.db
      .insert(timetableLessons)
      .values([
        { ...base, groupId: "g-7b", periodNr: 1, subjectId: "D", teacherId: JANA, roomId: "106" },
        { ...base, groupId: "g-7b", periodNr: 3, subjectId: "D", teacherId: JANA, roomId: "106" },
        { ...base, weekday: 1, groupId: "g-7b", periodNr: 2, subjectId: "D", teacherId: JANA, roomId: "106" },
        { ...base, groupId: "g-9a", periodNr: 1, subjectId: "M", teacherId: "u-tobias.kleine", roomId: "201" },
      ])
      .returning({ id: timetableLessons.id, weekday: timetableLessons.weekday, periodNr: timetableLessons.periodNr, groupId: timetableLessons.groupId });
    for (const r of rows) ids[`${r.groupId}-${r.weekday}-${r.periodNr}`] = r.id;
  }, 60_000);
  afterAll(() => h.close());

  it("nur Lehrkräfte, ab heute, höchstens 14 Tage, bei „krank“ keine Ergänzung", async () => {
    await expect(reportOwnAbsence(h.db, await p(SEKRETARIAT), krank, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await fe(reportOwnAbsence(h.db, await p(JANA), { ...krank, startsOn: "2026-10-01", endsOn: "2026-10-01" }, TODAY))).toEqual({
      startsOn: "Rückwirkend trägt die Vertretungsplanung ein",
    });
    expect((await fe(reportOwnAbsence(h.db, await p(JANA), { ...krank, endsOn: "2026-10-19" }, TODAY))).endsOn).toContain("Höchstens 14 Tage");
    expect((await fe(reportOwnAbsence(h.db, await p(JANA), { ...krank, note: "Grippe" }, TODAY))).note).toContain("keine Angaben zur Gesundheit");
    expect((await fe(reportOwnAbsence(h.db, await p(JANA), { ...krank, reason: "klassenfahrt" }, TODAY))).reason).toBe("Grund wählen");
    // G4E-C07: leeres bzw. nicht existierendes Datum → Feldfehler statt Datenbankfehler
    expect(await fe(reportOwnAbsence(h.db, await p(JANA), { ...krank, startsOn: "", endsOn: "" }, TODAY))).toMatchObject({ startsOn: "Datum angeben", endsOn: "Datum angeben" });
    expect((await fe(reportOwnAbsence(h.db, await p(JANA), { ...krank, startsOn: "2027-02-30", endsOn: "2027-02-30" }, TODAY))).startsOn).toBe("Datum angeben");
    expect(spanText({ startsOn: MO, endsOn: DI, fromPeriod: 2, toPeriod: 3 })).toBe("05.10.–06.10., 2.–3. Std.");
  });

  it("krank wirkt sofort: offene Stunden für die Planung, Gong an die Planung ohne Grund; Überschneidung abgelehnt", async () => {
    const r = await reportOwnAbsence(h.db, await p(JANA), krank, TODAY);
    expect(r.status).toBe("aktiv");
    const needs = await needsOn(h.db, MO);
    expect(needs.open.map((o) => o.periodNr)).toEqual([1, 3]);
    expect(needs.absences[0]).toMatchObject({ selfReported: true, status: "aktiv" });
    const gong = await h.db.select().from(notifications).where(eq(notifications.userId, PLANUNG));
    const g = gong.find((n) => n.title.startsWith("Abwesenheit gemeldet"))!;
    expect(g.title).toBe("Abwesenheit gemeldet: Jana Brandt (BRA)");
    expect(`${g.title} ${g.body}`).not.toContain("krank");
    const [log] = await h.db.select().from(auditLog).where(eq(auditLog.action, "stundenplan.absence.self"));
    expect(JSON.stringify(log!.meta)).not.toContain("krank");
    expect(await fe(reportOwnAbsence(h.db, await p(JANA), { ...krank, fromPeriod: 1, toPeriod: 1 }, TODAY))).toEqual({
      startsOn: "Für diesen Zeitraum ist schon eine Abwesenheit eingetragen",
    });
    // zurückziehen, solange sie nicht begonnen hat – danach nicht mehr
    expect(await fe(withdrawOwnAbsence(h.db, await p(JANA), r.id, MO))).toEqual({
      absence: "Die Abwesenheit hat schon begonnen – bitte die Vertretungsplanung ansprechen",
    });
    await expect(withdrawOwnAbsence(h.db, await p("u-tobias.kleine"), r.id, TODAY)).rejects.toBeInstanceOf(ValidationError);
    await withdrawOwnAbsence(h.db, await p(JANA), r.id, TODAY);
    expect((await needsOn(h.db, MO)).open).toHaveLength(0);
  });

  it("I-26: Fortbildung ist ein Antrag – zählt erst nach Genehmigung durch die Schulleitung; Ablehnung zählt nie", async () => {
    const r = await reportOwnAbsence(h.db, await p(JANA), { ...krank, endsOn: DI, reason: "fortbildung", note: "Fortbildung Digitalisierung" }, TODAY);
    expect(r.status).toBe("beantragt");
    expect((await needsOn(h.db, MO)).open).toHaveLength(0);
    const toPetra = await h.db.select().from(notifications).where(eq(notifications.userId, PETRA));
    expect(toPetra.some((n) => n.title === "Antrag Fortbildung: Jana Brandt (BRA)")).toBe(true);
    expect((await pendingRequests(h.db, await p(PETRA))).map((x) => x.span)).toEqual(["05.10.–06.10."]);
    expect(await pendingRequests(h.db, await p(JANA))).toEqual([]);
    await expect(decideAbsence(h.db, await p(JANA), r.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    await decideAbsence(h.db, await p(PETRA), r.id, true);
    expect((await needsOn(h.db, MO)).open.map((o) => o.periodNr)).toEqual([1, 3]);
    expect((await needsOn(h.db, DI)).open.map((o) => o.periodNr)).toEqual([2]);
    expect((await h.db.select().from(notifications).where(eq(notifications.userId, JANA))).some((n) => n.title === "Fortbildung genehmigt")).toBe(true);
    expect(await fe(decideAbsence(h.db, await p(PETRA), r.id, false))).toEqual({ absence: "Dieser Antrag ist schon entschieden oder zurückgezogen" });
    // ein weiterer Antrag wird abgelehnt
    const r2 = await reportOwnAbsence(h.db, await p(JANA), { ...krank, startsOn: "2026-10-12", endsOn: "2026-10-12", reason: "dienstlich", note: null }, TODAY);
    await decideAbsence(h.db, await p(PETRA), r2.id, false);
    expect((await needsOn(h.db, "2026-10-12")).open).toHaveLength(0);
    const mine = await myAbsences(h.db, await p(JANA), TODAY);
    expect(mine.map((a) => a.status)).toEqual(["aktiv", "abgelehnt"]);
    expect(mine[0]!.lessons.map((l) => `${l.date} ${l.periodNr}`)).toEqual([`${MO} 1`, `${MO} 3`, `${DI} 2`]);
  });

  it("Q5-12: Material je Stunde – Lehrkraft, Vertretung und Planung sehen es, Schüler:innen nur mit Häkchen; Gong an die Vertretung", async () => {
    const [a] = await h.db
      .select()
      .from(timetableAbsences)
      .where(and(eq(timetableAbsences.teacherId, JANA), eq(timetableAbsences.status, "aktiv")));
    const lesson = ids["g-7b-0-1"]!;
    // Vertretung steht schon fest → Gong beim ersten Material
    await saveSubstitution(h.db, PLANUNG, { lessonId: lesson, date: MO, kind: "substitute", substituteId: "u-sophie.wagner", roomId: null, note: null });
    // nur eine betroffene Stunde der Abwesenheit
    expect(
      await fe(saveMaterial(h.db, storage, await p(JANA), { absenceId: a!.id, lessonId: ids["g-9a-0-1"]!, date: MO, text: "x", forStudents: false })),
    ).toEqual({
      material: "Diese Stunde gehört nicht zur Abwesenheit",
    });
    await expect(
      saveMaterial(h.db, storage, await p(OTHER), { absenceId: a!.id, lessonId: lesson, date: MO, text: "x", forStudents: false }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const id = (await saveMaterial(h.db, storage, await p(JANA), {
      absenceId: a!.id,
      lessonId: lesson,
      date: MO,
      text: "Buch S. 34, Nr. 1–4",
      forStudents: false,
      file: { name: "Arbeitsblatt.pdf", type: "application/pdf", data: new Uint8Array([1, 2, 3]) },
    }))!;
    expect(storage.files.size).toBe(1);
    const gong = await h.db.select().from(notifications).where(eq(notifications.userId, "u-sophie.wagner"));
    expect(gong.some((n) => n.title === "Vertretungsmaterial: 1. Std Klasse 7b" && n.href === `/stundenplan/material/${id}`)).toBe(true);
    for (const who of [JANA, "u-sophie.wagner", PLANUNG]) expect((await materialFor(h.db, await p(who), id))?.text).toBe("Buch S. 34, Nr. 1–4");
    expect(await materialFor(h.db, await p(LEA), id)).toBeNull();
    expect(await materialFor(h.db, await p(OTHER), id)).toBeNull();
    // Häkchen für Schüler:innen: Lea (7b) sieht es, eine Schülerin einer anderen Klasse nicht
    await saveMaterial(h.db, storage, await p(JANA), { absenceId: a!.id, lessonId: lesson, date: MO, text: "Buch S. 34, Nr. 1–4", forStudents: true });
    expect((await materialFor(h.db, await p(LEA), id))?.fileName).toBe("Arbeitsblatt.pdf");
    const [other] = await h.db.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, "g-9a"));
    expect(await materialFor(h.db, await p(other!.userId), id)).toBeNull();
    const map = await materialsFor(h.db, await p(LEA), [
      { lessonId: lesson, date: MO },
      { lessonId: ids["g-7b-0-3"]!, date: MO },
    ]);
    expect([...map.keys()]).toEqual([`${lesson}:${MO}`]);
    // leer speichern = löschen
    await saveMaterial(h.db, storage, await p(JANA), { absenceId: a!.id, lessonId: lesson, date: MO, text: "", forStudents: false, removeFile: true });
    expect(await h.db.select().from(timetableAbsenceMaterials)).toHaveLength(0);
  });

  it("Material geht mit der Abwesenheit; betroffene Stunden ohne entfallene", async () => {
    const r = await reportOwnAbsence(h.db, await p(JANA), { ...krank, startsOn: "2026-10-19", endsOn: "2026-10-19" }, TODAY);
    const [a] = await h.db.select().from(timetableAbsences).where(eq(timetableAbsences.id, r.id));
    const lessons = await affectedLessons(h.db, a!);
    expect(lessons.map((l) => l.periodNr)).toEqual([1, 3]);
    await saveMaterial(h.db, storage, await p(JANA), {
      absenceId: r.id,
      lessonId: lessons[0]!.lessonId,
      date: "2026-10-19",
      text: "Lesen",
      forStudents: false,
    });
    await withdrawOwnAbsence(h.db, await p(JANA), r.id, TODAY);
    expect(await h.db.select().from(timetableAbsenceMaterials)).toHaveLength(0);
  });
});
