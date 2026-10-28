// Review-Fixes R1b (SP2-Review 2026-10-26): Verlegung mit Raum je Band-Teil (A3), Tausch nur mit stattfindendem Unterricht (A4),
// Aufheben nimmt die Kopplungsteile des Tauschpartners mit (A5), gelöschte aufnehmende Stunde lässt die Zusammenlegung offen
// stehen statt sie still zu löschen (A10), Dauervertretung meldet „nichts eingetragen“ als Fehler (A11) und Vertretungen nach
// dem Ende einer verkürzten Abwesenheit werden zur Prüfung markiert (SP2-16b).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { notifications, timetableAbsences, timetableLessons, timetableSubstitutions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { createAbsence, deleteAbsence, endedAbsenceReviews, needsOn, shortenAbsence } from "./abwesenheit";
import { savePermanentSubstitution } from "./dauervertretung";
import { changeLabel } from "./display";
import { deleteLesson } from "./manage";
import { deleteSubstitution, keepReviewedSubstitution, removeReviewedSubstitutions, saveSubstitution, substitutionsOn } from "./vertretung";

const MO = "2026-10-05";
const BRA = "u-jana.brandt";
const KLE = "u-tobias.kleine";
const WAG = "u-sophie.wagner";
const RIC = "u-jonas.richter";

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("R1b Vertretung", () => {
  let h: DbHandle;
  const ids: Record<string, string> = {};
  const mo = { weekday: 0, validFrom: "2026-08-01", validUntil: null };

  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  beforeEach(async () => {
    await h.db.delete(timetableSubstitutions);
    await h.db.delete(timetableLessons);
    await h.db.delete(timetableAbsences);
    const rows = await h.db
      .insert(timetableLessons)
      .values([
        // 7b am Montag: 1. Sport (KLE), 3. Mathe (RIC), 4. Bio (BRA), 5. Deutsch (BRA)
        { ...mo, groupId: "g-7b", periodNr: 1, subjectId: "SP", teacherId: KLE, roomId: "106" },
        { ...mo, groupId: "g-7b", periodNr: 3, subjectId: "M", teacherId: RIC, roomId: "106" },
        { ...mo, groupId: "g-7b", periodNr: 4, subjectId: "BI", teacherId: BRA, roomId: "106" },
        { ...mo, groupId: "g-7b", periodNr: 5, subjectId: "D", teacherId: BRA, roomId: "106" },
        // 7a: 1. Mathe (WAG), 4. Englisch (KLE)
        { ...mo, groupId: "g-7a", periodNr: 1, subjectId: "M", teacherId: WAG, roomId: "105" },
        { ...mo, groupId: "g-7a", periodNr: 4, subjectId: "E", teacherId: KLE, roomId: "105" },
        // Band-Stunde in der 6.: 9a (RIC, Raum 201) + 9b (WAG, Raum 202)
        { ...mo, groupId: "g-9a", periodNr: 6, subjectId: "M", teacherId: RIC, roomId: "201", couplingId: "band-6" },
        { ...mo, groupId: "g-9b", periodNr: 6, subjectId: "D", teacherId: WAG, roomId: "202", couplingId: "band-6" },
      ])
      .returning({ id: timetableLessons.id, groupId: timetableLessons.groupId, periodNr: timetableLessons.periodNr });
    for (const r of rows) ids[`${r.groupId.slice(2)}-${r.periodNr}`] = r.id;
  });

  const save = (lessonId: string, kind: "cancel" | "substitute" | "room" | "move" | "merge", extra: Partial<Parameters<typeof saveSubstitution>[2]> = {}) =>
    saveSubstitution(h.db, "u-admin", { lessonId, date: MO, kind, substituteId: null, roomId: null, note: null, ...extra });
  const rowsByLesson = async () => new Map((await h.db.select().from(timetableSubstitutions)).map((r) => [r.lessonId, r]));

  it("A3: Verlegung einer Band-Stunde mit anderem Raum – nur der bearbeitete Teil zieht um, die anderen behalten ihren Raum", async () => {
    await save(ids["9a-6"]!, "move", { targetPeriod: 2, roomId: "203" });
    const rows = await rowsByLesson();
    expect(rows.get(ids["9a-6"]!)).toMatchObject({ kind: "move", targetPeriod: 2, roomId: "203" });
    expect(rows.get(ids["9b-6"]!)).toMatchObject({ kind: "move", targetPeriod: 2, roomId: null });
  });

  it("A3: der Raum jedes Teils wird in der Zielstunde geprüft; der neue Raum darf nicht der eines anderen Teils sein", async () => {
    // Raum 202 (9b) ist in der 2. Stunde durch die 7a belegt
    await h.db.insert(timetableLessons).values({ ...mo, groupId: "g-7a", periodNr: 2, subjectId: "D", teacherId: BRA, roomId: "202" });
    expect((await fieldErrors(save(ids["9a-6"]!, "move", { targetPeriod: 2, roomId: "203" }))).targetPeriod).toMatch(/Raum 202 ist in der 2\. Stunde belegt/);
    // 9a in den Raum der 9b → beide Gruppen in einem Raum
    expect((await fieldErrors(save(ids["9a-6"]!, "move", { targetPeriod: 3, roomId: "202" }))).roomId).toMatch(/202/);
  });

  it("A4: Tausch nimmt keine entfallene Stunde mit (der Entfall käme sonst zurück) – ohne Tausch geht die Verlegung", async () => {
    await save(ids["7b-3"]!, "cancel");
    expect((await fieldErrors(save(ids["7b-5"]!, "move", { targetPeriod: 3, swap: true }))).targetPeriod).toMatch(/entfällt/);
    expect((await rowsByLesson()).get(ids["7b-3"]!)).toMatchObject({ kind: "cancel" });
    await save(ids["7b-5"]!, "move", { targetPeriod: 3 });
    expect((await rowsByLesson()).get(ids["7b-3"]!)).toMatchObject({ kind: "cancel" });
  });

  it("A4: Tausch mit einer vertretenen Stunde wird abgelehnt – die Vertretung bleibt", async () => {
    await save(ids["7b-3"]!, "substitute", { substituteId: WAG });
    expect((await fieldErrors(save(ids["7b-5"]!, "move", { targetPeriod: 3, swap: true }))).targetPeriod).toMatch(/Vertretung/);
    expect((await rowsByLesson()).get(ids["7b-3"]!)).toMatchObject({ kind: "substitute", substituteId: WAG });
  });

  it("A5: Aufheben eines Tauschs nimmt auch die Kopplungsteile des Tauschpartners zurück", async () => {
    // Band in der 2.: 7b (KLE, 106) + 9a (WAG, 201)
    const band = await h.db
      .insert(timetableLessons)
      .values([
        { ...mo, groupId: "g-7b", periodNr: 2, subjectId: "E", teacherId: KLE, roomId: "106", couplingId: "band-2" },
        { ...mo, groupId: "g-9a", periodNr: 2, subjectId: "M", teacherId: WAG, roomId: "201", couplingId: "band-2" },
      ])
      .returning({ id: timetableLessons.id });
    await save(ids["7b-5"]!, "move", { targetPeriod: 2, swap: true });
    const rows = await rowsByLesson();
    expect(band.map((b) => rows.get(b.id)?.targetPeriod)).toEqual([5, 5]);
    await deleteSubstitution(h.db, "u-admin", rows.get(ids["7b-5"]!)!.id);
    expect(await h.db.select().from(timetableSubstitutions)).toEqual([]);
  });

  it("A10: wird die aufnehmende Stunde gelöscht, bleibt die Zusammenlegung als „aufgehoben“ stehen – Bedarf offen, Lehrkraft benachrichtigt", async () => {
    await createAbsence(h.db, "u-admin", { teacherId: KLE, groupId: null, startsOn: MO, endsOn: MO, fromPeriod: null, toPeriod: null, reason: "fortbildung", note: null });
    await save(ids["7a-4"]!, "merge", { mergeLessonId: ids["7b-4"] });
    expect((await needsOn(h.db, MO)).open.find((o) => o.lessonId === ids["7a-4"])?.status).toBe("merge");
    const before = (await h.db.select().from(notifications).where(and(eq(notifications.userId, BRA), eq(notifications.moduleId, "stundenplan")))).at(-1)?.title;
    expect(before).toMatch(/Zusammenlegung/);
    // SP3-05: Planung vor Schuljahresbeginn – ohne Vergangenheitsbezug wird die Stunde ganz gelöscht
    await deleteLesson(h.db, "u-admin", ids["7b-4"]!, "2026-07-31");
    const row = (await rowsByLesson()).get(ids["7a-4"]!);
    expect(row).toMatchObject({ kind: "merge", mergeLessonId: null });
    expect((await needsOn(h.db, MO)).open.find((o) => o.lessonId === ids["7a-4"])?.status).toBe("open");
    const e = (await substitutionsOn(h.db, [MO])).find((x) => x.lessonId === ids["7a-4"])!;
    expect(changeLabel(e)).toBe("Zusammenlegung aufgehoben");
    // die bisher mitbetreuende Lehrkraft und die Lehrkraft der Stunde erfahren es
    // (Tagesnachricht je Person und Tag wird ersetzt: BRA hat an dem Tag nichts mehr)
    // (SP3-05: daneben kommt die Änderungsliste der Sofort-Korrektur als eigener Gong – hier zählt die Tagesnachricht)
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, BRA), eq(notifications.bundleKey, `stundenplan:${MO}`)));
    expect(gong.at(-1)?.title).not.toBe(before);
    expect(gong.at(-1)?.title).toMatch(/keine Änderungen mehr/);
    const kle = await h.db.select().from(notifications).where(and(eq(notifications.userId, KLE), eq(notifications.moduleId, "stundenplan")));
    expect(kle.at(-1)?.body).toMatch(/aufgehoben/);
  });

  it("A11: Dauervertretung ohne Vertretungslehrkraft oder ohne einen möglichen Tag ist ein Fehler, keine Erfolgsmeldung", async () => {
    const absenceId = await createAbsence(h.db, "u-admin", { teacherId: BRA, groupId: null, startsOn: MO, endsOn: "2026-10-16", fromPeriod: null, toPeriod: null, reason: "krank", note: null });
    expect((await fieldErrors(savePermanentSubstitution(h.db, "u-admin", { lessonId: ids["7b-5"]!, from: MO, absenceId, substituteId: "" }))).substituteId).toBe("Vertretungslehrkraft wählen");
    // RIC unterrichtet montags in der 3. – BRA-Stunde in der 3. gibt es nicht; nimm die 6. (RIC im Band) → an keinem Tag möglich
    await h.db.update(timetableLessons).set({ periodNr: 6 }).where(eq(timetableLessons.id, ids["7b-5"]!));
    await h.db.delete(timetableLessons).where(eq(timetableLessons.id, ids["9b-6"]!));
    await h.db.update(timetableLessons).set({ couplingId: null }).where(eq(timetableLessons.id, ids["9a-6"]!));
    const err = await fieldErrors(savePermanentSubstitution(h.db, "u-admin", { lessonId: ids["7b-5"]!, from: MO, absenceId, substituteId: RIC }));
    expect(err.substituteId).toMatch(/an keinem Tag/);
    expect(await h.db.select().from(timetableSubstitutions)).toEqual([]);
  });

  it("SP2-16b: Abwesenheit verkürzt – Vertretungen danach bleiben, sind markiert und lassen sich einzeln behalten oder alle entfernen", async () => {
    const [wed] = await h.db.insert(timetableLessons).values({ ...mo, weekday: 2, groupId: "g-7b", periodNr: 1, subjectId: "SP", teacherId: KLE, roomId: "106" }).returning({ id: timetableLessons.id });
    const absenceId = await createAbsence(h.db, "u-admin", { teacherId: KLE, groupId: null, startsOn: MO, endsOn: "2026-10-16", fromPeriod: null, toPeriod: null, reason: "krank", note: null });
    expect((await savePermanentSubstitution(h.db, "u-admin", { lessonId: ids["7b-1"]!, from: MO, absenceId, substituteId: BRA })).saved).toEqual([MO, "2026-10-12"]);
    expect((await savePermanentSubstitution(h.db, "u-admin", { lessonId: wed!.id, from: "2026-10-07", absenceId, substituteId: BRA })).saved).toEqual(["2026-10-07", "2026-10-14"]);
    expect(await endedAbsenceReviews(h.db, MO)).toEqual([]);
    // Ende auf Freitag, 09.10., vorgezogen
    expect((await fieldErrors(shortenAbsence(h.db, "u-admin", absenceId, "2026-10-16"))).endsOn).toMatch(/früher/);
    expect((await fieldErrors(shortenAbsence(h.db, "u-admin", absenceId, "2026-10-01"))).endsOn).toMatch(/Beginn/);
    await shortenAbsence(h.db, "u-admin", absenceId, "2026-10-09");
    const review = await endedAbsenceReviews(h.db, MO);
    expect(review.map((r) => [r.date, r.groupName, r.teacherCode, r.substituteCode])).toEqual([
      ["2026-10-12", "Klasse 7b", "KLE", "BRA"],
      ["2026-10-14", "Klasse 7b", "KLE", "BRA"],
    ]);
    // die Vertretungen stehen weiter im Plan, mit Markierung
    expect((await substitutionsOn(h.db, ["2026-10-12"], { drafts: true }))[0]).toMatchObject({ kind: "substitute", absenceEnded: true });
    expect((await substitutionsOn(h.db, [MO], { drafts: true }))[0]).toMatchObject({ absenceEnded: false });
    // „behalten“ nimmt die Markierung weg
    await keepReviewedSubstitution(h.db, "u-admin", review[0]!.id);
    expect((await endedAbsenceReviews(h.db, MO)).map((r) => r.date)).toEqual(["2026-10-14"]);
    // „alle entfernen“ löscht die markierten (nur die) und benachrichtigt
    expect(await removeReviewedSubstitutions(h.db, "u-admin", MO)).toEqual({ removed: 1, failed: [] });
    expect((await h.db.select().from(timetableSubstitutions)).map((r) => r.date).sort()).toEqual([MO, "2026-10-07", "2026-10-12"]);
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, BRA), eq(notifications.moduleId, "stundenplan")));
    expect(gong.some((g) => g.title.includes("14.10."))).toBe(true);
  });

  it("SP2-16b: Abwesenheit aufgehoben – alle Vertretungen aus ihr werden markiert; erneutes Speichern bestätigt", async () => {
    const absenceId = await createAbsence(h.db, "u-admin", { teacherId: KLE, groupId: null, startsOn: MO, endsOn: "2026-10-12", fromPeriod: null, toPeriod: null, reason: "krank", note: null });
    await savePermanentSubstitution(h.db, "u-admin", { lessonId: ids["7b-1"]!, from: MO, absenceId, substituteId: BRA });
    // eine zweite Abwesenheit deckt den 12.10. weiter → dort bleibt alles unmarkiert
    await createAbsence(h.db, "u-admin", { teacherId: KLE, groupId: null, startsOn: "2026-10-12", endsOn: "2026-10-12", fromPeriod: 1, toPeriod: 2, reason: "dienstlich", note: null });
    await deleteAbsence(h.db, "u-admin", absenceId);
    expect((await endedAbsenceReviews(h.db, MO)).map((r) => r.date)).toEqual([MO]);
    await save(ids["7b-1"]!, "substitute", { substituteId: BRA });
    expect(await endedAbsenceReviews(h.db, MO)).toEqual([]);
  });
});
