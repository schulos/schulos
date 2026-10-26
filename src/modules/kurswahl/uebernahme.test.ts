import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, ne, sql } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { groupMembers, groups, kurswahlWahlen, timetableAssignmentGroups, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { createGroup, addMembers } from "@/modules/verwaltung/groups";
import { ValidationError } from "@/modules/verwaltung/users";
import { createAngebot, createVerfahren, deleteAngebot, getVerfahren, listAngebote, submitChoice, targetStudents, updateAngebot, type VerfahrenInput } from "./service";
import { assignmentSuggestions, createSuggestedAssignments, transfer, transferPreview } from "./uebernahme";
import { assignManually, runAllocation } from "./zuteilen";

const SABINE = "u-sabine.kowalski";
const TODAY = "2026-11-20";
const input: VerfahrenInput = {
  title: "WP I 7b",
  kind: "wp1",
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

describe("Kurswahlen – Übernahme in Gruppen und Lehraufträge", () => {
  let h: DbHandle;
  let id: string;
  let students: string[];
  let teacher: string;
  const p = (u: string) => loadPermissions(h.db, u);

  beforeAll(async () => {
    h = await createSeededTestDb();
    teacher = "u-jana.brandt";
    id = await createVerfahren(h.db, await p(SABINE), input);
    const f = await createAngebot(h.db, await p(SABINE), id, { title: "Französisch", subjectId: "F", level: null, minSize: 0, maxSize: null, note: null, teacherId: teacher, hours: 4, offSubjectOk: true });
    const inf = await createAngebot(h.db, await p(SABINE), id, { title: "Informatik", subjectId: "IF", level: null, minSize: 0, maxSize: null, note: null, teacherId: null, hours: null });
    students = (await targetStudents(h.db, input)).map((s) => s.id);
    // 24 wählen (12 F, 12 IF), eine Person nicht
    await h.db.insert(kurswahlWahlen).values(students.slice(0, 24).map((s, i) => ({ verfahrenId: id, studentId: s, choices: [i % 2 ? inf : f], submittedBy: SABINE, submittedAt: new Date() })));
    // eine Schüler:in ist schon in einem Französisch-Wahlpflichtkurs
    const old = await createGroup(h.db, SABINE, { name: "WP Französisch alt", kind: "wahlpflicht", subjectId: "F" });
    await addMembers(h.db, SABINE, old, [students[0]!]);
  }, 60_000);
  afterAll(() => h.close());

  it("ohne Zuteilung keine Übernahme; Vorschau nennt Konflikte", async () => {
    await expect(transfer(h.db, await p(SABINE), id, { acceptConflicts: true }, TODAY)).rejects.toBeInstanceOf(ValidationError);
    await runAllocation(h.db, await p(SABINE), id);
    const v = (await getVerfahren(h.db, id))!;
    await expect(transferPreview(h.db, await p(teacher), v)).rejects.toBeInstanceOf(ForbiddenError);
    const prev = await transferPreview(h.db, await p(SABINE), v);
    expect(prev.groups.map((g) => [g.name, g.students.length])).toEqual([
      ["7 Französisch", 12],
      ["7 Informatik", 12],
    ]);
    expect(prev.conflicts.map((c) => c.kind).sort()).toEqual(["ohne_kurs", "schon_in_gruppe"]);
    expect(prev.conflicts.find((c) => c.kind === "schon_in_gruppe")!.text).toContain("„WP Französisch alt“");
  });

  it("übernimmt erst nach Bestätigung, nicht während der Wahl; legt Gruppen mit Mitgliedern und Leitung an", async () => {
    await expect(transfer(h.db, await p(SABINE), id, { acceptConflicts: false }, TODAY)).rejects.toBeInstanceOf(ValidationError);
    await expect(transfer(h.db, await p(SABINE), id, { acceptConflicts: true }, "2026-11-10")).rejects.toBeInstanceOf(ValidationError);
    const created = await transfer(h.db, await p(SABINE), id, { acceptConflicts: true }, TODAY);
    expect(created).toHaveLength(2);
    const offers = await listAngebote(h.db, id);
    const fGroup = offers.find((o) => o.title === "Französisch")!.groupId!;
    const [g] = await h.db.select().from(groups).where(eq(groups.id, fGroup));
    expect(g).toMatchObject({ name: "7 Französisch", kind: "wahlpflicht", gradeLevel: 7, subjectId: "F", schoolYearId: "sj-2026-27" });
    const members = await h.db.select().from(groupMembers).where(eq(groupMembers.groupId, fGroup));
    expect(members.filter((m) => m.role === "member")).toHaveLength(12);
    expect(members.find((m) => m.userId === teacher)?.role).toBe("leader");
    expect((await getVerfahren(h.db, id))!.transferredAt).toBeTruthy();
    await expect(transfer(h.db, await p(SABINE), id, { acceptConflicts: true }, TODAY)).rejects.toBeInstanceOf(ValidationError);
  });

  it("Lehraufträge-Vorschlag: nur mit Fach und Stunden, nur mit Recht für den Stundenplan, nicht doppelt", async () => {
    const v = (await getVerfahren(h.db, id))!;
    const sugg = await assignmentSuggestions(h.db, await p(SABINE), v);
    expect(sugg.map((s) => [s.groupName, s.missing])).toEqual([
      ["7 Französisch", []],
      ["7 Informatik", ["Wochenstunden"]],
    ]);
    const [{ id: fGroup }] = (await h.db.select({ id: groups.id }).from(groups).where(and(eq(groups.name, "7 Französisch")))) as [{ id: string }];
    // SP-03: das Sekretariat plant nicht (kein `stundenplan.manage`); Lehrkraft ohne Kurswahl-Recht auch nicht
    await expect(createSuggestedAssignments(h.db, await p(SABINE), id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createSuggestedAssignments(h.db, await p(teacher), id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignmentSuggestions(h.db, await p(teacher), v)).rejects.toBeInstanceOf(ForbiddenError);
    // SP-05 (Projektleitung 2026-10-19): die Stundenplanung (`stundenplan.manage` + `kurswahl.view`, ohne `kurswahl.manage`) legt an
    const frank = await p("u-frank.schulte");
    expect((await assignmentSuggestions(h.db, frank, v)).map((s) => s.groupName)).toEqual(["7 Französisch", "7 Informatik"]);
    expect(await createSuggestedAssignments(h.db, frank, id)).toBe(1);
    expect(await h.db.select().from(timetableAssignmentGroups).where(eq(timetableAssignmentGroups.groupId, fGroup))).toHaveLength(1);
    expect((await assignmentSuggestions(h.db, await p(SABINE), v))[0]!.exists).toBe(true);
    expect(await createSuggestedAssignments(h.db, await p("u-admin"), id)).toBe(0);
  });
});

describe("Kurswahlen – Gate-Review 4d (G4D-C01, C02, C08, S02)", () => {
  let h: DbHandle;
  let id: string;
  let f: string, inf: string, dg: string;
  let students: string[];
  const p = (u: string) => loadPermissions(h.db, u);
  const v = async () => (await getVerfahren(h.db, id))!;
  const wahl = async (s: string) => (await h.db.select().from(kurswahlWahlen).where(and(eq(kurswahlWahlen.verfahrenId, id), eq(kurswahlWahlen.studentId, s))))[0]!;
  const named = (name: string) => h.db.select().from(groups).where(eq(groups.name, name));

  beforeAll(async () => {
    h = await createSeededTestDb();
    id = await createVerfahren(h.db, await p(SABINE), { ...input, title: "WP I Review" });
    const offer = (title: string, subjectId: string | null, teacherId: string | null) => ({ title, subjectId, level: null, minSize: 0, maxSize: null, note: null, teacherId, hours: null, offSubjectOk: true });
    f = await createAngebot(h.db, await p(SABINE), id, offer("Französisch", "F", "u-jana.brandt"));
    inf = await createAngebot(h.db, await p(SABINE), id, offer("Informatik", "IF", "u-jana.brandt"));
    dg = await createAngebot(h.db, await p(SABINE), id, offer("Darstellen", null, null));
    students = (await targetStudents(h.db, input)).map((s) => s.id);
    await h.db.insert(kurswahlWahlen).values(students.slice(0, 10).map((s, i) => ({ verfahrenId: id, studentId: s, choices: [i % 2 ? inf : f], submittedBy: SABINE, submittedAt: new Date(Date.now() - 60_000) })));
  }, 60_000);
  afterAll(() => h.close());

  it("C08: Angebot mit Zuteilung von Hand gelöscht → die Person ist wieder offen und wird beim nächsten Mal zugeteilt", async () => {
    await assignManually(h.db, await p(SABINE), id, students[0]!, dg);
    await deleteAngebot(h.db, await p(SABINE), dg);
    expect(await wahl(students[0]!)).toMatchObject({ assignedId: null, manual: false, reason: "Angebot „Darstellen“ gelöscht – bei der nächsten Zuteilung neu" });
    await runAllocation(h.db, await p(SABINE), id);
    expect((await wahl(students[0]!)).assignedId).toBe(f);
  });

  it("C01: eine Wahl nach der Berechnung verwirft die Zuteilung; ohne neue Berechnung keine Übernahme", async () => {
    expect((await v()).allocatedAt).toBeTruthy();
    await assignManually(h.db, await p(SABINE), id, students[3]!, f);
    // Familie (hier: Verwaltung vom Papier) ändert den Wunsch von Französisch auf Informatik
    await submitChoice(h.db, await p(SABINE), id, students[2]!, [inf], "2026-11-10");
    expect((await v()).allocatedAt).toBeNull();
    expect((await wahl(students[0]!)).assignedId).toBeNull();
    expect(await wahl(students[3]!)).toMatchObject({ assignedId: f, manual: true });
    await expect(transfer(h.db, await p(SABINE), id, { acceptConflicts: true }, TODAY)).rejects.toMatchObject({ fieldErrors: { transfer: /Erst die Zuteilung berechnen/ } });
    // Kapazität geändert → ebenso veraltet
    await runAllocation(h.db, await p(SABINE), id);
    expect((await wahl(students[2]!)).assignedId).toBe(inf);
    await updateAngebot(h.db, await p(SABINE), f, { title: "Französisch", subjectId: "F", level: null, minSize: 0, maxSize: 20, note: null, teacherId: "u-jana.brandt", hours: null });
    expect((await v()).allocatedAt).toBeNull();
    // gleiche Wünsche erneut abgegeben ändern nichts
    const at = await runAllocation(h.db, await p(SABINE), id).then(async () => (await v()).allocatedAt);
    await submitChoice(h.db, await p(SABINE), id, students[2]!, [inf], "2026-11-10");
    expect((await v()).allocatedAt).toEqual(at);
    // Abgabe nach der Berechnung (z. B. an der Prüfung vorbei geschrieben) → Übernahme lehnt ab
    await h.db.update(kurswahlWahlen).set({ submittedAt: new Date(at!.getTime() + 1000) }).where(and(eq(kurswahlWahlen.verfahrenId, id), eq(kurswahlWahlen.studentId, students[4]!)));
    await expect(transfer(h.db, await p(SABINE), id, { acceptConflicts: true }, TODAY)).rejects.toMatchObject({ fieldErrors: { transfer: /veraltet/ } });
    expect((await v()).transferredAt).toBeNull();
    await runAllocation(h.db, await p(SABINE), id, {}, new Date(at!.getTime() + 60_000));
  });

  it("S02: übernehmen nur mit Gruppenrecht; eine vorhandene Gruppe wird nur nach Bestätigung ergänzt, ihre Leitung bleibt", async () => {
    const jana = await p("u-jana.brandt");
    const coordinator = { ...jana, granted: new Set([...jana.granted, "kurswahl.manage"]) };
    await expect(transfer(h.db, coordinator, id, { acceptConflicts: true }, TODAY)).rejects.toMatchObject({ permission: "verwaltung.groups" });
    const sabine = await p(SABINE);
    const noGroups = { ...sabine, granted: new Set([...sabine.granted].filter((g) => g !== "verwaltung.groups")) };
    await expect(transfer(h.db, noGroups, id, { acceptConflicts: true }, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    // fremder Kurs gleichen Namens mit eigener Leitung
    const existing = await createGroup(h.db, SABINE, { name: "7 Informatik", kind: "wahlpflicht", subjectId: "IF" });
    const [otherTeacher] = await h.db.select({ id: users.id }).from(users).where(and(eq(users.role, "lehrkraft"), ne(users.id, "u-jana.brandt"))).limit(1);
    await addMembers(h.db, SABINE, existing, [otherTeacher!.id], "leader");
    const prev = await transferPreview(h.db, sabine, await v());
    expect(prev.conflicts.find((c) => c.kind === "vorhandene_gruppe")?.text).toMatch(/„7 Informatik“ gibt es schon.*Leitung bleibt/);
    await expect(transfer(h.db, sabine, id, { acceptConflicts: false }, TODAY)).rejects.toMatchObject({ fieldErrors: { transfer: /bestätigen/ } });
  });

  it("C02: scheitert die Übernahme mittendrin, bleibt nichts zurück; zwei gleichzeitige Übernahmen ergeben eine", async () => {
    const sabine = await p(SABINE);
    await h.db.execute(sql.raw("create function g4d_c02_fail() returns trigger language plpgsql as $$ begin raise exception 'Testfehler'; end $$"));
    await h.db.execute(sql.raw(`create trigger g4d_c02 before update on kurswahl_angebote for each row when (new.id = '${inf}' and new.group_id is not null) execute function g4d_c02_fail()`));
    await expect(transfer(h.db, sabine, id, { acceptConflicts: true }, TODAY)).rejects.toThrow();
    await h.db.execute(sql.raw("drop trigger g4d_c02 on kurswahl_angebote"));
    await h.db.execute(sql.raw("drop function g4d_c02_fail()"));
    expect(await named("7 Französisch")).toEqual([]);
    expect((await v()).transferredAt).toBeNull();
    expect((await listAngebote(h.db, id)).map((o) => o.groupId)).toEqual([null, null]);
    const both = await Promise.allSettled([transfer(h.db, sabine, id, { acceptConflicts: true }, TODAY), transfer(h.db, sabine, id, { acceptConflicts: true }, TODAY)]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await named("7 Französisch")).toHaveLength(1);
    const [inform] = await named("7 Informatik");
    const members = await h.db.select().from(groupMembers).where(eq(groupMembers.groupId, inform!.id));
    expect(members.filter((m) => m.role === "member").length).toBeGreaterThan(0);
    expect(members.find((m) => m.userId === "u-jana.brandt")).toBeUndefined();
    expect(members.filter((m) => m.role === "leader")).toHaveLength(1);
    const [fr] = await named("7 Französisch");
    expect((await h.db.select().from(groupMembers).where(and(eq(groupMembers.groupId, fr!.id), eq(groupMembers.userId, "u-jana.brandt"))))[0]?.role).toBe("leader");
  });
});
