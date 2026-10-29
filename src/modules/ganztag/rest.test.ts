// GT-04…GT-07: Abgleich mit den Abwesenheiten, Hinweis an die Klassenleitung, Familienansicht, Auswertung ohne Namen,
// Häkchen in der Kurswahl-Übernahme, Kontolöschung. Feste Daten (`now` wird übergeben).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import {
  absenceLeaveRequests,
  absenceReports,
  classbookAbsences,
  ganztagGroupSettings,
  ganztagMarks,
  groupFeatures,
  groupMembers,
  groups,
  kurswahlWahlen,
  notifications,
  parentChild,
  users,
} from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { deleteAccounts } from "@/core/privacy/konto";
import { SCHEDULED_JOBS } from "@/core/scheduler";
import { createAngebot, createVerfahren, getVerfahren, listAngebote, targetStudents, type VerfahrenInput } from "@/modules/kurswahl/service";
import { transfer } from "@/modules/kurswahl/uebernahme";
import { runAllocation } from "@/modules/kurswahl/zuteilen";
import { ValidationError } from "@/modules/verwaltung/users";
import { canEvaluate, evaluation, evaluationCsvRows, monthLabel } from "./auswertung";
import { familyView } from "./familie";
import { classLeadView, hintBundleKey, leadsClass, runClassLeadHints } from "./klassenleitung";
import { createSession, getSessionList, LIST_FEATURE, readOfferSettings, setListFeature, setMark, setOfferSettings, setSessionCancelled } from "./service";

const SEKRETARIAT = "u-sabine.kowalski";
const SCHULLEITUNG = "u-petra.lindner";
const RICHTER = "u-jonas.richter"; // Leitung AG Schulchor
const CHOR = "g-ag-schulchor";
const DAY = "2026-11-10"; // Dienstag
const NOW = new Date("2026-11-10T15:00:00Z");
const EVENING = new Date("2026-11-10T19:30:00Z");

describe("Ganztag GT-04…GT-07 (DB)", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let kids: string[] = [];
  const name = new Map<string, string>();
  const classOf = new Map<string, string>();
  const leadOf = new Map<string, string[]>();

  beforeAll(async () => {
    h = await createSeededTestDb();
    const rows = await h.db
      .select({ id: groupMembers.userId, name: users.name })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groupMembers.groupId, CHOR), eq(groupMembers.role, "member"), eq(users.role, "schueler")))
      .orderBy(groupMembers.userId);
    kids = rows.map((r) => r.id);
    for (const r of rows) name.set(r.id, r.name);
    // feste Ausgangslage: keine Meldungen/Beurlaubungen der Chor-Kinder aus der Demo
    await h.db.delete(absenceReports).where(inArray(absenceReports.studentId, kids));
    await h.db.delete(absenceLeaveRequests).where(inArray(absenceLeaveRequests.studentId, kids));
    const cls = await h.db
      .select({ userId: groupMembers.userId, groupId: groups.id })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(and(inArray(groupMembers.userId, kids), eq(groups.kind, "klasse"), eq(groupMembers.role, "member")));
    for (const c of cls) classOf.set(c.userId, c.groupId);
    const leaders = await h.db
      .select({ groupId: groupMembers.groupId, userId: groupMembers.userId })
      .from(groupMembers)
      .where(and(inArray(groupMembers.groupId, [...new Set(cls.map((c) => c.groupId))]), eq(groupMembers.role, "leader")));
    for (const l of leaders) leadOf.set(l.groupId, [...(leadOf.get(l.groupId) ?? []), l.userId]);
    await setListFeature(h.db, await p(SEKRETARIAT), CHOR, true);
  }, 60_000);
  afterAll(async () => h?.close());

  const report = (studentId: string, status: "gemeldet" | "entschuldigt" | "nicht_entschuldigt") =>
    h.db.insert(absenceReports).values({ studentId, fromDate: DAY, toDate: DAY, reason: "krank", status, reportedBy: SEKRETARIAT }).returning({ id: absenceReports.id });
  const rowOf = async (sessionId: string, studentId: string, now = NOW) => (await getSessionList(h.db, await p(RICHTER), sessionId, now))!.rows.find((r) => r.studentId === studentId);

  it("GT-04 Vorbelegung: Krankmeldung/Beurlaubung → „fehlt (entschuldigt)“, nur die Quelle; Leitung kann ändern", async () => {
    expect(kids.length).toBeGreaterThan(7);
    const richter = await p(RICHTER);
    await report(kids[0]!, "entschuldigt");
    await report(kids[1]!, "gemeldet");
    await report(kids[2]!, "nicht_entschuldigt");
    await h.db.insert(absenceLeaveRequests).values({ studentId: kids[6]!, fromDate: DAY, toDate: DAY, schoolDays: 1, reason: "familiaer", decider: "klassenleitung", status: "genehmigt", requestedBy: SEKRETARIAT });
    const id = await createSession(h.db, richter, CHOR, { date: DAY, startsAt: "16:00", endsAt: "17:00" });

    let list = (await getSessionList(h.db, richter, id, NOW))!;
    const byId = new Map(list.rows.map((r) => [r.studentId, r]));
    expect(byId.get(kids[0]!)).toMatchObject({ status: "fehlt", excused: "ja", source: "abwesenheiten" });
    expect(byId.get(kids[1]!)).toMatchObject({ status: "fehlt", excused: "ja", source: "abwesenheiten" });
    expect(byId.get(kids[6]!)).toMatchObject({ status: "fehlt", excused: "ja", source: "abwesenheiten" });
    expect(byId.get(kids[2]!)).toMatchObject({ status: null, excused: null }); // „nicht entschuldigt“ wird nicht vorbelegt
    // die Vorbelegung allein ist keine Erfassung (Ausfall und „offen“ bleiben möglich)
    expect(list.session.status).toBe("geplant");
    expect(JSON.stringify(list)).not.toContain("krank");

    // Leitung ändert: Kind 0 ist doch da → bleibt beim erneuten Öffnen anwesend
    await setMark(h.db, richter, id, kids[0]!, "anwesend", null, NOW);
    expect(await rowOf(id, kids[0]!)).toMatchObject({ status: "anwesend", source: "leitung", excused: null });
    // „fehlt“ von Hand: entschuldigt? kommt aus den Abwesenheiten (nicht entschuldigt bzw. ohne Meldung)
    await setMark(h.db, richter, id, kids[2]!, "fehlt", null, NOW);
    await setMark(h.db, richter, id, kids[3]!, "fehlt", null, NOW);
    expect(await rowOf(id, kids[2]!)).toMatchObject({ status: "fehlt", excused: "nein", source: "leitung" });
    expect(await rowOf(id, kids[3]!)).toMatchObject({ status: "fehlt", excused: "offen" });
    list = (await getSessionList(h.db, richter, id, NOW))!;
    expect(list.session.status).toBe("erfasst");

    // Meldung zurückgezogen → Vorbelegung fällt weg; Meldung nachträglich → „entschuldigt“
    await h.db.delete(absenceReports).where(eq(absenceReports.studentId, kids[1]!));
    expect(await rowOf(id, kids[1]!)).toMatchObject({ status: null });
    const [late] = await report(kids[3]!, "gemeldet");
    expect(await rowOf(id, kids[3]!)).toMatchObject({ status: "fehlt", excused: "ja", source: "leitung" });
    await h.db.delete(absenceReports).where(eq(absenceReports.id, late!.id));

    // Vorbelegung abschaltbar je Angebot; Einstellungen nur „Ganztag verwalten“
    await expect(setOfferSettings(h.db, richter, CHOR, { mandatory: true, notifyClassLead: true, prefillAbsences: false })).rejects.toBeInstanceOf(ForbiddenError);
    await setOfferSettings(h.db, await p(SEKRETARIAT), CHOR, { mandatory: false, notifyClassLead: true, prefillAbsences: false });
    const other = await createSession(h.db, richter, CHOR, { date: DAY, startsAt: "17:00", endsAt: "18:00" });
    expect((await getSessionList(h.db, richter, other, NOW))!.rows.every((r) => r.status === null)).toBe(true);
    await setOfferSettings(h.db, await p(SEKRETARIAT), CHOR, { mandatory: false, notifyClassLead: true, prefillAbsences: true });
    // künftige Termine werden nicht vorbelegt; beim Ausfall fallen Vorbelegungen weg
    expect((await getSessionList(h.db, richter, other, NOW))!.rows.find((r) => r.studentId === kids[6])).toMatchObject({ status: "fehlt", source: "abwesenheiten" });
    await setSessionCancelled(h.db, richter, other, true, NOW);
    expect(await h.db.select().from(ganztagMarks).where(eq(ganztagMarks.sessionId, other))).toEqual([]);
    const future = await createSession(h.db, richter, CHOR, { date: "2026-11-11", startsAt: "16:00", endsAt: "17:00" });
    await report(kids[7]!, "gemeldet").then(() => h.db.update(absenceReports).set({ fromDate: "2026-11-11", toDate: "2026-11-11" }).where(eq(absenceReports.studentId, kids[7]!)));
    expect((await getSessionList(h.db, richter, future, NOW))!.rows.every((r) => r.status === null)).toBe(true);
    await h.db.delete(absenceReports).where(eq(absenceReports.studentId, kids[7]!));
  });

  it("GT-04 Tageshinweis: genau einmal je Klassenleitung und Tag, nur Pflichtangebot + unentschuldigt; kein Klassenbuch", async () => {
    const richter = await p(RICHTER);
    const sek = await p(SEKRETARIAT);
    const classbookBefore = (await h.db.select({ n: count() }).from(classbookAbsences))[0]!.n;
    // Liste von oben: Kind 2 fehlt (nicht entschuldigt), Kind 3 fehlt (ohne Meldung), Kind 0 anwesend, Kind 6 fehlt (beurlaubt)
    // nicht verpflichtend → kein Hinweis
    expect(await runClassLeadHints(h.db, EVENING)).toMatchObject({ sent: 0 });
    await setOfferSettings(h.db, sek, CHOR, { mandatory: true, notifyClassLead: false, prefillAbsences: true });
    expect(await runClassLeadHints(h.db, EVENING)).toMatchObject({ sent: 0 });
    await setOfferSettings(h.db, sek, CHOR, { mandatory: true, notifyClassLead: true, prefillAbsences: true });
    // Kind 5 verspätet zählt nicht
    const s = (await getSessionList(h.db, richter, (await h.db.select({ id: ganztagMarks.sessionId }).from(ganztagMarks).where(eq(ganztagMarks.studentId, kids[3]!)))[0]!.id, NOW))!;
    await setMark(h.db, richter, s.session.id, kids[5]!, "verspaetet", 5, NOW);

    const r = await runClassLeadHints(h.db, EVENING);
    const expected = new Set([...(leadOf.get(classOf.get(kids[2]!)!) ?? []), ...(leadOf.get(classOf.get(kids[3]!)!) ?? [])]);
    expect(expected.size).toBeGreaterThan(0);
    expect(r.sent).toBe(expected.size);
    const hints = await h.db.select().from(notifications).where(eq(notifications.bundleKey, hintBundleKey(DAY)));
    expect(new Set(hints.map((n) => n.userId))).toEqual(expected);
    const all = hints.map((n) => `${n.title} ${n.body}`).join("\n");
    expect(all).toContain(name.get(kids[2]!)!);
    expect(all).toContain(name.get(kids[3]!)!);
    expect(all).toContain("AG Schulchor");
    for (const k of [kids[0]!, kids[5]!, kids[6]!]) expect(all).not.toContain(name.get(k)!);
    expect(all).not.toContain("krank");
    expect(hints[0]).toMatchObject({ moduleId: "ganztag", href: "/ganztag/klasse", title: "Ganztag: unentschuldigt gefehlt am Di, 10.11.2026" });

    // zweiter Lauf am selben Tag: nichts Neues, weiterhin genau ein Hinweis je Klassenleitung
    expect(await runClassLeadHints(h.db, new Date("2026-11-10T21:00:00Z"))).toMatchObject({ sent: 0 });
    expect(await h.db.select({ n: count() }).from(notifications).where(eq(notifications.bundleKey, hintBundleKey(DAY)))).toEqual([{ n: hints.length }]);
    // keine Schreibverbindung ins Klassenbuch
    expect((await h.db.select({ n: count() }).from(classbookAbsences))[0]!.n).toBe(classbookBefore);
    expect(SCHEDULED_JOBS.find((j) => j.name === "ganztag-hinweis")).toMatchObject({ at: "19:00", until: "23:00" });
  });

  it("GT-04 Klassenleitung: sieht die Zeilen ihrer Klasse, andere nichts", async () => {
    const lead = leadOf.get(classOf.get(kids[3]!)!)![0]!;
    const view = (await classLeadView(h.db, await p(lead), NOW))!;
    const row = view.rows.find((r) => r.studentId === kids[3]);
    expect(row).toMatchObject({ status: "fehlt", excused: "offen", mandatory: true, offer: "AG Schulchor", date: DAY });
    expect(view.rows.some((r) => r.status === "anwesend")).toBe(false);
    const own = new Set((await h.db.select({ id: groupMembers.userId }).from(groupMembers).where(inArray(groupMembers.groupId, view.classes.map((c) => c.id)))).map((r) => r.id));
    expect(view.rows.every((r) => own.has(r.studentId))).toBe(true);
    expect(view.participation.find((x) => x.studentId === kids[3])?.offers).toContain("AG Schulchor");
    expect(await leadsClass(h.db, await p(lead))).toBe(true);
    // eine Lehrkraft ohne Klassenleitung
    const leaders = new Set(
      (
        await h.db
          .select({ id: groupMembers.userId })
          .from(groupMembers)
          .innerJoin(groups, eq(groups.id, groupMembers.groupId))
          .where(and(eq(groups.kind, "klasse"), eq(groupMembers.role, "leader")))
      ).map((r) => r.id),
    );
    const teachers = await h.db.select({ id: users.id }).from(users).where(eq(users.role, "lehrkraft"));
    const noLead = teachers.find((t) => !leaders.has(t.id))!.id;
    expect(await classLeadView(h.db, await p(noLead), NOW)).toBeNull();
    expect(await leadsClass(h.db, await p(noLead))).toBe(false);
  });

  it("GT-05 Familie: Schüler:in sieht nur sich, Eltern nur das eigene Kind nach den Regeln der Volljährigkeit", async () => {
    const kid = kids[3]!;
    const mine = await familyView(h.db, await p(kid), NOW);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toBe(kid);
    expect(mine[0]!.marks).toEqual([expect.objectContaining({ offer: "AG Schulchor", date: DAY, status: "fehlt", excused: "offen" })]);
    expect(mine[0]!.offers.map((o) => o.name)).toContain("AG Schulchor");
    const text = JSON.stringify(mine);
    for (const k of kids.filter((x) => x !== kid)) {
      expect(text).not.toContain(k);
      expect(text).not.toContain(name.get(k)!);
    }
    // Eltern: minderjährig → sehen; eigenständig ohne Einwilligung → nicht; mit Einwilligung → wieder
    const [link] = await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, kid));
    expect(link).toBeDefined();
    const parent = link!.parentId;
    expect((await familyView(h.db, await p(parent), NOW)).map((c) => c.id)).toContain(kid);
    await h.db.update(users).set({ selfResponsible: true }).where(eq(users.id, kid));
    expect((await familyView(h.db, await p(parent), NOW)).map((c) => c.id)).not.toContain(kid);
    expect((await familyView(h.db, await p(kid), NOW))[0]!.marks).toHaveLength(1); // die Person selbst sieht weiter
    await h.db.update(users).set({ parentsInformedSince: NOW }).where(eq(users.id, kid));
    expect((await familyView(h.db, await p(parent), NOW)).map((c) => c.id)).toContain(kid);
    await h.db.update(users).set({ selfResponsible: false, parentsInformedSince: null }).where(eq(users.id, kid));
    // Personal sieht hier nichts (dafür gibt es Leitung, Klassenleitung, Auswertung)
    expect(await familyView(h.db, await p(RICHTER), NOW)).toEqual([]);
  });

  it("GT-06 Auswertung je Angebot und Monat ohne Namen; „offen heute“; nur mit „Ganztag auswerten“", async () => {
    await expect(evaluation(h.db, await p(RICHTER), NOW)).rejects.toBeInstanceOf(ForbiddenError);
    expect(canEvaluate(await p(SCHULLEITUNG))).toBe(true);
    const e = await evaluation(h.db, await p(SCHULLEITUNG), NOW);
    const nov = e.rows.find((r) => r.groupId === CHOR && r.month === "2026-11")!;
    // 16:00 erfasst (ein Ausfall um 17:00; morgen zählt noch nicht)
    expect(nov).toMatchObject({ offer: "AG Schulchor", sessions: 1, cancelled: 1, recorded: 1, open: 0 });
    expect(nov.absent).toBe(3); // Kind 2, 3, 6
    expect(nov.absentExcused).toBe(1); // beurlaubt
    expect(nov.late).toBe(1);
    expect(nov.present).toBe(2); // Kind 0 anwesend, Kind 5 verspätet
    expect(nov.rate).toBe(40);
    // „offen heute“: der Demo-Termin der Schülerzeitung (dienstags) ist nicht erfasst
    expect(e.openToday.map((o) => o.offer)).toContain("AG Schülerzeitung");
    const text = JSON.stringify(e) + JSON.stringify(evaluationCsvRows(e));
    for (const k of kids) {
      expect(text).not.toContain(k);
      expect(text).not.toContain(name.get(k)!);
    }
    expect(evaluationCsvRows(e)[0]).toContain("Teilnehmertage");
    expect(monthLabel("2026-11")).toBe("November 2026");
  });

  it("GT-07 Kurswahl: Häkchen schaltet die Liste für die entstandenen AG-Gruppen ein, sonst nicht", async () => {
    const sek = await p(SEKRETARIAT);
    const make = async (title: string) => {
      const input: VerfahrenInput = {
        title,
        kind: "ag",
        note: null,
        gradeLevel: 7,
        classIds: ["g-7b"],
        courseGrade: 7,
        schoolYearId: null,
        opensOn: "2026-11-01",
        closesOn: "2026-11-15",
        choices: 1,
        chooser: "eltern",
        parentConfirm: false,
      };
      const id = await createVerfahren(h.db, sek, input);
      const a = await createAngebot(h.db, sek, id, { title: `${title} Theater`, subjectId: null, level: null, minSize: 0, maxSize: null, note: null, teacherId: RICHTER, hours: null });
      const students = (await targetStudents(h.db, input)).map((s) => s.id);
      await h.db.insert(kurswahlWahlen).values(students.map((s) => ({ verfahrenId: id, studentId: s, choices: [a], submittedBy: SEKRETARIAT, submittedAt: new Date("2026-01-01T10:00:00Z") })));
      await runAllocation(h.db, sek, id);
      return id;
    };
    const withList = await make("AG-Wahl A");
    const without = await make("AG-Wahl B");
    await transfer(h.db, sek, withList, { acceptConflicts: true, ganztagList: true }, "2026-11-20");
    await transfer(h.db, sek, without, { acceptConflicts: true }, "2026-11-20");
    const groupOf = async (id: string) => (await listAngebote(h.db, id))[0]!.groupId!;
    const a = await groupOf(withList);
    const b = await groupOf(without);
    const features = await h.db.select().from(groupFeatures).where(and(inArray(groupFeatures.groupId, [a, b]), eq(groupFeatures.feature, LIST_FEATURE)));
    expect(features.map((f) => f.groupId)).toEqual([a]);
    expect(await readOfferSettings(h.db, a)).toMatchObject({ mandatory: false, prefillAbsences: true });
    expect(await h.db.select().from(ganztagGroupSettings).where(eq(ganztagGroupSettings.groupId, b))).toEqual([]);
    expect((await getVerfahren(h.db, withList))!.transferredAt).toBeTruthy();
    // Merkmal ist da: die Leitung (Richter) hat das neue Angebot
    expect((await getSessionList(h.db, await p(RICHTER), await createSession(h.db, await p(RICHTER), a, { date: DAY, startsAt: "08:00", endsAt: "09:00" }), NOW))!.group.id).toBe(a);
    // ohne „Ganztag verwalten“ kein direktes Schalten
    await expect(setListFeature(h.db, await p(RICHTER), b, true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setOfferSettings(h.db, sek, b, { mandatory: true, notifyClassLead: true, prefillAbsences: true })).rejects.toBeInstanceOf(ValidationError);
  });

  it("Kontolöschung: Zeilen gehen mit dem Konto, Auswertung zählt sie nicht mehr; Hinweis der Klassenleitung geht mit ihrem Konto", async () => {
    const kid = kids[3]!;
    await deleteAccounts(h.db, [kid]);
    expect(await h.db.select().from(ganztagMarks).where(eq(ganztagMarks.studentId, kid))).toEqual([]);
    const nov = (await evaluation(h.db, await p(SCHULLEITUNG), NOW)).rows.find((r) => r.groupId === CHOR && r.month === "2026-11")!;
    expect(nov.absent).toBe(2);
    const lead = leadOf.get(classOf.get(kids[2]!)!)![0]!;
    await deleteAccounts(h.db, [lead]);
    expect(await h.db.select().from(notifications).where(and(eq(notifications.userId, lead), eq(notifications.bundleKey, hintBundleKey(DAY))))).toEqual([]);
  });
});
