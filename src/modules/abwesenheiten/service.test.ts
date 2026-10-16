import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { absenceReports, classbookAbsences, classbookEntries, notifications, parentChild, timetableLessons, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { lessonContext, saveEntry } from "@/modules/klassenbuch/service";
import { listUsers, ValidationError } from "@/modules/verwaltung/users";
import { decideReport, leaderView, parentView, phoneStudents, reasonVisible, reportAbsence, selfView } from "./service";

const MO = "2026-10-05";
const DI = "2026-10-06";
const TODAY = "2026-10-07";

describe("Abwesenheiten", () => {
  let h: DbHandle;
  let mutter: string;
  let fremdeMutter: string;
  const ids: Record<string, string> = {};
  const p = (id: string) => loadPermissions(h.db, id);
  const lea = "u-lea.schaefer";

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(classbookEntries);
    await h.db.delete(absenceReports);
    await h.db.delete(timetableLessons);
    mutter = (await listUsers(h.db, { q: "Daniela Schäfer" })).rows[0]!.id;
    const kid9a = (await listUsers(h.db, { groupId: "g-9a", role: "schueler" })).rows[0]!.id;
    fremdeMutter = (await h.db.select().from(parentChild).where(eq(parentChild.childId, kid9a)))[0]!.parentId;
    const rows = await h.db
      .insert(timetableLessons)
      .values([
        { groupId: "g-7b", weekday: 0, periodNr: 1, subjectId: "D", teacherId: "u-jana.brandt", roomId: "106", validFrom: "2026-08-01" },
        { groupId: "g-7b", weekday: 1, periodNr: 1, subjectId: "M", teacherId: "u-tobias.kleine", roomId: "106", validFrom: "2026-08-01" },
      ])
      .returning({ id: timetableLessons.id, weekday: timetableLessons.weekday });
    for (const r of rows) ids[r.weekday === 0 ? "mo" : "di"] = r.id;
    // Montag: Lea fehlt laut Klassenbuch
    await saveEntry(h.db, await p("u-jana.brandt"), { lessonId: ids.mo!, date: MO, topic: "Erörterung", homework: "", absences: [{ studentId: lea, kind: "absent", minutesLate: null }] }, TODAY);
  }, 60_000);
  afterAll(() => h.close());

  it("Elternteil meldet das eigene Kind krank, Klassenleitung bekommt einen Gong", async () => {
    await reportAbsence(h.db, await p(mutter), { studentId: lea, fromDate: MO, toDate: DI, reason: "krank" }, TODAY);
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, "u-jana.brandt"), eq(notifications.moduleId, "abwesenheiten")));
    expect(gong.map((n) => n.title)).toEqual(["Abwesenheit gemeldet: Lea Schäfer (5.10.–6.10.)"]);
    expect(gong[0]!.body).toBe("Grund: krank");
    const { reports } = await parentView(h.db, mutter);
    expect(reports.map((r) => `${r.studentName} ${r.status}`)).toEqual(["Lea Schäfer gemeldet"]);
  });

  it("DS-20: Admin-Konten sehen Meldungen, aber nicht den Grund – Klassenleitung und ausdrückliches Recht schon", async () => {
    const admin = await leaderView(h.db, await p("u-admin"));
    const leaRows = admin.reports.filter((r) => r.studentId === lea);
    expect(leaRows.length).toBeGreaterThan(0);
    expect(leaRows.every((r) => r.reason === null)).toBe(true);
    expect((await leaderView(h.db, await p("u-jana.brandt"))).reports.find((r) => r.studentId === lea)?.reason).toBe("krank");
    // ausdrücklich vergebenes Recht zählt (z. B. Schulleitung) – `*` an eine Gruppe nicht
    const petra = await p("u-petra.lindner");
    expect(reasonVisible({ ...petra, granted: new Set(["abwesenheiten.manage"]) }, "g-7b")).toBe(true);
    expect(reasonVisible({ ...petra, granted: new Set(["*"]) }, "g-7b")).toBe(false);
    expect(reasonVisible({ ...petra, role: "admin", granted: new Set(["abwesenheiten.manage"]) }, "g-7b")).toBe(false);
  });

  it("fremde Kinder melden geht nicht; Plausibilität des Zeitraums", async () => {
    await expect(reportAbsence(h.db, await p(fremdeMutter), { studentId: lea, fromDate: MO, toDate: MO, reason: "krank" }, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reportAbsence(h.db, await p(lea), { studentId: lea, fromDate: MO, toDate: MO, reason: "krank" }, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    try {
      await reportAbsence(h.db, await p(mutter), { studentId: lea, fromDate: "2026-09-01", toDate: "2026-08-30", reason: "krank" }, TODAY);
      throw new Error("erwartet ValidationError");
    } catch (err) {
      expect((err as ValidationError).fieldErrors).toEqual({ toDate: "Der letzte Tag liegt vor dem ersten", fromDate: "Nachmeldungen sind bis zu 14 Tage rückwirkend möglich" });
    }
  });

  it("Klassenleitung entschuldigt: wirkt auf vorhandene und später eingetragene Fehlstunden; Gong an die Mutter", async () => {
    const view = await leaderView(h.db, await p("u-jana.brandt"));
    expect(view.students).toHaveLength(25);
    const open = view.reports.find((r) => r.status === "gemeldet")!;
    await expect(decideReport(h.db, await p("u-daniel.okafor"), open.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    await decideReport(h.db, await p("u-jana.brandt"), open.id, true);
    expect((await lessonContext(h.db, ids.mo!, MO)).absences.get(lea)!.excused).toBe(true);
    // Dienstag wird erst danach eingetragen – übernimmt „entschuldigt“
    await saveEntry(h.db, await p("u-tobias.kleine"), { lessonId: ids.di!, date: DI, topic: "Brüche", homework: "", absences: [{ studentId: lea, kind: "absent", minutesLate: null }] }, TODAY);
    expect((await lessonContext(h.db, ids.di!, DI)).absences.get(lea)!.excused).toBe(true);
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, mutter), eq(notifications.moduleId, "abwesenheiten")));
    expect(gong.map((n) => n.title)).toContain("Lea Schäfer: 5.10.–6.10. entschuldigt");
  });

  it("nicht entschuldigen setzt die Fehlstunden auf unentschuldigt; Klassenleitung erfasst Entschuldigung direkt", async () => {
    const [r] = await h.db.select().from(absenceReports);
    await decideReport(h.db, await p("u-jana.brandt"), r!.id, false);
    const rows = await h.db.select().from(classbookAbsences).where(eq(classbookAbsences.studentId, lea));
    expect(rows.every((a) => a.excused === false)).toBe(true);
    await reportAbsence(h.db, await p("u-jana.brandt"), { studentId: lea, fromDate: MO, toDate: MO, reason: "sonstiges" }, TODAY);
    const after = await h.db.select({ excused: classbookAbsences.excused, date: classbookEntries.date }).from(classbookAbsences).innerJoin(classbookEntries, eq(classbookEntries.id, classbookAbsences.entryId)).where(eq(classbookAbsences.studentId, lea));
    expect(after.find((a) => a.date === MO)!.excused).toBe(true);
    expect(after.find((a) => a.date === DI)!.excused).toBe(false);
  });
  it("Sekretariat nimmt einen Anruf auf (Q5-01): Status „gemeldet“, Gong an die Klassenleitung, entschieden wird dort", async () => {
    const sek = await p("u-sabine.kowalski");
    await h.db.delete(absenceReports);
    await h.db.delete(notifications);
    // Lehrkraft ohne Klassenleitung der Klasse darf weder melden noch das Telefon-Recht nutzen
    await expect(phoneStudents(h.db, await p("u-daniel.okafor"))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await phoneStudents(h.db, sek)).find((s) => s.id === lea)?.groupName).toBe("Klasse 7b");
    const id = await reportAbsence(h.db, sek, { studentId: lea, fromDate: TODAY, toDate: TODAY, reason: "krank" }, TODAY);
    const [row] = await h.db.select().from(absenceReports).where(eq(absenceReports.id, id));
    expect(row).toMatchObject({ status: "gemeldet", reportedBy: sek.userId, decidedBy: null });
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, "u-jana.brandt"), eq(notifications.moduleId, "abwesenheiten")));
    expect(gong.map((n) => n.title)).toEqual(["Abwesenheit gemeldet: Lea Schäfer (7.10.)"]);
    // Sekretariat kann nicht selbst entschuldigen; Klassenleitung entscheidet
    await expect(decideReport(h.db, sek, id, true)).rejects.toBeInstanceOf(ForbiddenError);
    await decideReport(h.db, await p("u-jana.brandt"), id, true);
    const [after] = await h.db.select().from(absenceReports).where(eq(absenceReports.id, id));
    expect(after!.status).toBe("entschuldigt");
    // nur Schüler:innen, nicht beliebige Konten
    await expect(reportAbsence(h.db, sek, { studentId: "u-jana.brandt", fromDate: TODAY, toDate: TODAY, reason: "krank" }, TODAY)).rejects.toBeInstanceOf(ValidationError);
  });

  it("Telefon-Formular: auch wer entscheiden dürfte (Admin), meldet nur – Status „gemeldet“, Gong an die Klassenleitung (Code-Review Gate 4a M3)", async () => {
    const admin = await p("u-admin");
    await h.db.update(classbookAbsences).set({ excused: false }).where(eq(classbookAbsences.studentId, lea));
    await h.db.delete(absenceReports);
    await h.db.delete(notifications);
    const id = await reportAbsence(h.db, admin, { studentId: lea, fromDate: MO, toDate: MO, reason: "krank" }, TODAY, { channel: "telefon" });
    const [row] = await h.db.select().from(absenceReports).where(eq(absenceReports.id, id));
    expect(row).toMatchObject({ status: "gemeldet", decidedBy: null });
    const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, "u-jana.brandt"), eq(notifications.moduleId, "abwesenheiten")));
    expect(gong).toHaveLength(1);
    // Fehlstunde im Klassenbuch bleibt unentschieden (nicht still entschuldigt)
    const [abs] = await h.db.select().from(classbookAbsences).where(and(eq(classbookAbsences.studentId, lea), eq(classbookAbsences.kind, "absent")));
    expect(abs!.excused).toBe(false);
    // Telefon-Weg nur mit dem Recht
    await expect(reportAbsence(h.db, await p("u-jana.brandt"), { studentId: lea, fromDate: TODAY, toDate: TODAY, reason: "krank" }, TODAY, { channel: "telefon" })).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("DS-19: Eigenständige (volljährige) Schüler:innen melden selbst; Eltern melden nicht mehr und sehen keine Meldungen", async () => {
    await h.db.delete(absenceReports);
    await h.db.delete(notifications);
    await h.db.update(users).set({ selfResponsible: true }).where(eq(users.id, lea));
    try {
      // die Person selbst: Status „gemeldet“, Gong an die Klassenleitung, 14 Tage Rückwirkung wie bei Eltern
      const id = await reportAbsence(h.db, await p(lea), { studentId: lea, fromDate: TODAY, toDate: TODAY, reason: "krank" }, TODAY);
      const [row] = await h.db.select().from(absenceReports).where(eq(absenceReports.id, id));
      expect(row).toMatchObject({ status: "gemeldet", reportedBy: lea, decidedBy: null });
      const gong = await h.db.select().from(notifications).where(and(eq(notifications.userId, "u-jana.brandt"), eq(notifications.moduleId, "abwesenheiten")));
      expect(gong.map((n) => n.title)).toEqual(["Abwesenheit gemeldet: Lea Schäfer (7.10.)"]);
      await expect(reportAbsence(h.db, await p(lea), { studentId: lea, fromDate: "2026-09-01", toDate: "2026-09-01", reason: "krank" }, TODAY)).rejects.toBeInstanceOf(ValidationError);
      expect((await selfView(h.db, lea))!.map((r) => r.status)).toEqual(["gemeldet"]);
      // nur für sich selbst, nicht für andere
      const other = (await listUsers(h.db, { groupId: "g-7b", role: "schueler" })).rows.find((r) => r.id !== lea)!.id;
      await expect(reportAbsence(h.db, await p(lea), { studentId: other, fromDate: TODAY, toDate: TODAY, reason: "krank" }, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
      // Eltern: kein Melden, Kind und Meldungen nicht in der Elternsicht (auch nicht mit Einwilligung – nur Fehlzeiten)
      await expect(reportAbsence(h.db, await p(mutter), { studentId: lea, fromDate: TODAY, toDate: TODAY, reason: "krank" }, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
      let view = await parentView(h.db, mutter);
      expect(view.kids.map((k) => k.id)).not.toContain(lea);
      expect(view.informed.map((k) => k.id)).not.toContain(lea);
      expect(view.reports.map((r) => r.studentId)).not.toContain(lea);
      await h.db.update(users).set({ parentsInformedSince: new Date() }).where(eq(users.id, lea));
      view = await parentView(h.db, mutter);
      expect(view.informed.map((k) => k.id)).toContain(lea);
      expect(view.kids.map((k) => k.id)).not.toContain(lea);
      expect(view.reports.map((r) => r.studentId)).not.toContain(lea);
    } finally {
      await h.db.update(users).set({ selfResponsible: false, parentsInformedSince: null }).where(eq(users.id, lea));
    }
    // minderjährig: Schüler:in meldet nicht selbst
    expect(await selfView(h.db, lea)).toBeNull();
    await expect(reportAbsence(h.db, await p(lea), { studentId: lea, fromDate: TODAY, toDate: TODAY, reason: "krank" }, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
