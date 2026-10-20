// Schulbücherei Stufe 2 – Schulbuchausgabe (BU-11): Schalter, Rechte (S82), Ausgabe per Scan klassen-/kursweise, Rücknahme mit
// Zustand am Exemplar bzw. mit Befund, Doppelscan/Prüfziffer/Bücherei-Exemplar, eigene Sicht und Eltern, Auskunft/Eigenexport,
// Mahnung nach Ablauf der Rückgabefrist (Eltern Minderjähriger ab der 1. Stufe, ohne Titel).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, buechereiCards, buechereiMaterialCopies, buechereiMaterialIssues, mailOutbox, notifications, schoolYears, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { addDays } from "@/core/time";
import { deleteSchoolYear } from "@/modules/verwaltung/school-years";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  childrenSchoolbooks,
  isMaterialNumber,
  issueCopy,
  issueFindings,
  issueGroup,
  issueGroups,
  issuePerson,
  issueSummary,
  resolveIssueFinding,
  runSchoolbookDunning,
  scanIssue,
  schoolbookAuskunft,
  schoolbookMail,
  schoolbookText,
  schoolbooksOf,
  takeBack,
} from "./ausgabe";
import { ensureCards } from "./cards";
import { dueDate } from "./dates";
import { createMaterial, withdrawMaterialCopy } from "./lernmittel";
import { DUNNING_MAIL, LERNMITTEL } from "./settings";

const SABINE = "u-sabine.kowalski"; // Verwaltung: `buecherei.materials`
const AYLIN = "u-aylin.demir"; // Büchereiteam: Theke + Bestand, keine Schulbuchausleihe
const JANA = "u-jana.brandt"; // Lehrkraft, Klassenleitung 7b
const LEA = "u-lea.schaefer"; // Schülerin 7b (minderjährig)
const MUTTER = "u-daniela.schaefer"; // Elternteil von Lea
const MAT = "Probe-Lesebuch 7 (BU-11)";

const fails = (pr: Promise<unknown>, re: RegExp) =>
  expect(pr).rejects.toSatisfy((e: unknown) => e instanceof ValidationError && re.test(Object.values(e.fieldErrors).join(" | ")));

describe("Schulbuchausgabe – reine Helfer", () => {
  it("Inventarnummern der Lernmittel erkennen", () => {
    expect(isMaterialNumber("L-000001-8")).toBe(true);
    expect(isMaterialNumber("B-000001-8")).toBe(false);
  });

  it("Mahn-Mail ohne Titel, an Eltern mit Vornamen", () => {
    const m = schoolbookMail({ school: "Testschule", level: 1, count: 2, since: "2027-07-31", link: "https://x/buecherei/meine", child: "Lea" });
    expect(m.subject).toBe("Testschule: 1. Mahnung – Schulbücher");
    expect(m.text).toContain("2 Schulbücher von Lea sind seit dem 31.07.2027 nicht zurückgegeben");
    expect(m.text).toContain("https://x/buecherei/meine");
  });
});

describe("Schulbuchausgabe", () => {
  let h: DbHandle;
  let day: string;
  let numbers: string[];
  let year: { id: string; endsOn: string };
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    day = await dueDate(h.db, "2026-11-09", 0); // ein Schultag
    const [y] = await h.db.select({ id: schoolYears.id, endsOn: schoolYears.endsOn }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
    year = y!;
    ({ numbers } = await createMaterial(h.db, await p(SABINE), { title: MAT, grades: [7], subjectId: "D", provision: "leihe" }, { count: 4 }));
  });
  afterAll(async () => {
    await h.close();
  });

  it("Schalter aus → keine Ausgabe, keine Rücknahme", async () => {
    await writeModuleSetting(h.db, LERNMITTEL, "0");
    try {
      await fails(issueGroups(h.db, await p(SABINE)), /ausgeschaltet/);
      await fails(scanIssue(h.db, await p(SABINE), numbers[0]!, LEA, day), /ausgeschaltet/);
      expect(await childrenSchoolbooks(h.db, await p(MUTTER), day)).toEqual([]);
    } finally {
      await writeModuleSetting(h.db, LERNMITTEL, "1");
    }
  });

  it("S82: Ausgabe, Rücknahme und Befunde nur mit `buecherei.materials`", async () => {
    for (const who of [AYLIN, JANA, LEA, MUTTER]) {
      const v = await p(who);
      await expect(issueGroups(h.db, v)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(issueGroup(h.db, v, "g-7b", day)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(scanIssue(h.db, v, numbers[0]!, LEA, day)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(takeBack(h.db, v, numbers[0]!, day)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(issueFindings(h.db, v)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(resolveIssueFinding(h.db, v, "x", day)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("Klassenübersicht: Demo-Ausgabe der 5a; 7b mit dem Lesebuch als „fehlt noch“", async () => {
    const s = await p(SABINE);
    const list = await issueGroups(h.db, s);
    expect(list.find((g) => g.id === "g-5a")).toMatchObject({ students: 25, books: 11 });
    expect(list[0]!.kind).toBe("klasse");
    const g = await issueGroup(h.db, s, "g-7b", day);
    expect(g!.materials.map((m) => m.title)).toContain(MAT);
    expect(g!.students.find((x) => x.id === LEA)!.missing.map((m) => m.title)).toContain(MAT);
    expect(await issueGroup(h.db, s, "g-gibtsnicht", day)).toBeNull();
    expect(await issueSummary(h.db, s, day)).toMatchObject({ year: "2026/27", issued: 11, overdue: 0, findings: 1 });
  });

  it("Ausgabe per Scan: Ausweis wählt die Person, Schulbuch an sie – laufendes Schuljahr, fällig zu dessen Ende", async () => {
    const s = await p(SABINE);
    await ensureCards(h.db, s, [LEA]);
    const [card] = await h.db.select({ code: buechereiCards.code }).from(buechereiCards).where(eq(buechereiCards.userId, LEA));
    expect(await scanIssue(h.db, s, card!.code.toLowerCase(), null, day)).toEqual({ kind: "person", userId: LEA });

    expect(await scanIssue(h.db, s, ` ${numbers[0]!.toLowerCase()} `, LEA, day)).toEqual({ kind: "issue", title: MAT, inventoryNumber: numbers[0], dueOn: year.endsOn });
    const [row] = await h.db.select().from(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.userId, LEA));
    expect(row).toMatchObject({ schoolYearId: year.id, issuedOn: day, dueOn: year.endsOn, returnedOn: null, dunningLevel: 0 });
    expect((await issueGroup(h.db, s, "g-7b", day))!.students.find((x) => x.id === LEA)!.missing.map((m) => m.title)).not.toContain(MAT);
    expect((await issuePerson(h.db, s, LEA, day))!.books.map((b) => b.inventoryNumber)).toEqual([numbers[0]]);

    // Doppelscan desselben Lernmittels, schon Ausgegebenes an jemand anderen, Prüfziffer, Bücherei-Exemplar, ohne Person
    await fails(scanIssue(h.db, s, numbers[1]!, LEA, day), /Hat „Probe-Lesebuch 7 \(BU-11\)“ schon/);
    await fails(issueCopy(h.db, s, JANA, numbers[0]!, day), /schon ausgegeben/);
    await fails(scanIssue(h.db, s, numbers[1]!.slice(0, -1) + ((Number(numbers[1]!.at(-1)) + 1) % 10), LEA, day), /keine gültige Inventarnummer/);
    await fails(scanIssue(h.db, s, "B-000001-8", LEA, day), /Bücherei-Exemplar – an der Theke/);
    await fails(scanIssue(h.db, s, numbers[1]!, null, day), /erst die Person wählen/);
    await fails(scanIssue(h.db, s, numbers[1]!, null, day, { finding: "kaputt" }), /Befund gehört zur Rücknahme/);
    await fails(issueCopy(h.db, s, MUTTER, numbers[1]!, day), /bekommt keine Schulbücher/);
    const [c3] = await h.db.select({ id: buechereiMaterialCopies.id }).from(buechereiMaterialCopies).where(eq(buechereiMaterialCopies.inventoryNumber, numbers[3]!));
    await withdrawMaterialCopy(h.db, s, c3!.id, "verloren", day);
    await fails(issueCopy(h.db, s, JANA, numbers[3]!, day), /ausgesondert/);
  });

  it("gleichzeitig dasselbe Schulbuch an zwei Personen: genau eine Ausgabe", async () => {
    const s = await p(SABINE);
    const r = await Promise.allSettled([issueCopy(h.db, s, JANA, numbers[2]!, day), issueCopy(h.db, s, "u-frank.schulte", numbers[2]!, day)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((r.find((x) => x.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);
    await takeBack(h.db, s, numbers[2]!, day);
  });

  it("eigene Sicht, Eltern (lesend), Auskunft und Eigenexport", async () => {
    expect((await schoolbooksOf(h.db, LEA, day)).map((b) => b.title)).toEqual([MAT]);
    const kids = await childrenSchoolbooks(h.db, await p(MUTTER), day);
    expect(kids.find((k) => k.id === LEA)!.books.map((b) => b.inventoryNumber)).toEqual([numbers[0]]);
    expect(await childrenSchoolbooks(h.db, await p(JANA), day)).toEqual([]);
    const rows = await schoolbookAuskunft(h.db, LEA);
    expect(rows).toEqual([expect.objectContaining({ titel: MAT, inventarnummer: numbers[0], schuljahr: "2026/27", befund: null })]);
    expect(schoolbookText(rows)).toContain(`- ${MAT} (${numbers[0]}), Schuljahr 2026/27`);
    expect(schoolbookText([])).toBeNull();
  });

  it("Mahnung nach Ablauf der Frist: nur an Schultagen, Eltern Minderjähriger ab der 1. Stufe, ohne Titel, je Stufe einmal", async () => {
    await h.db.update(users).set({ email: "lea@example.org", emailVerified: true }).where(eq(users.id, LEA));
    await h.db.update(users).set({ email: "mutter@example.org", emailVerified: true }).where(eq(users.id, MUTTER));
    await writeModuleSetting(h.db, DUNNING_MAIL, "1");
    await h.db.update(buechereiMaterialIssues).set({ dueOn: addDays(day, -3) }).where(eq(buechereiMaterialIssues.userId, LEA));
    const saturday = addDays(day, 5);
    expect(await runSchoolbookDunning(h.db, saturday, { mail: true, school: "Testschule" })).toEqual({ dunned: 0, parents: 0 });
    expect(await runSchoolbookDunning(h.db, day, { mail: true, school: "Testschule" })).toEqual({ dunned: 1, parents: 1 });
    expect(await runSchoolbookDunning(h.db, day, { mail: true, school: "Testschule" })).toEqual({ dunned: 0, parents: 0 });
    const [row] = await h.db.select().from(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.userId, LEA));
    expect(row).toMatchObject({ dunningLevel: 1, dunnedOn: day });
    const gongs = await h.db.select().from(notifications).where(and(eq(notifications.moduleId, "buecherei"), like(notifications.title, "%Schulbücher%")));
    expect(gongs.map((g) => g.userId).sort()).toEqual([MUTTER, LEA].sort());
    expect(gongs.find((g) => g.userId === LEA)!.body).toContain("Deine Eltern werden ebenfalls benachrichtigt");
    for (const g of gongs) expect(`${g.title} ${g.body}`).not.toContain(MAT);
    const mails = await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "buecherei-schulbuch"));
    expect(mails.map((m) => m.to).sort()).toEqual(["lea@example.org", "mutter@example.org"]);
    for (const m of mails) expect(`${m.subject} ${m.text}`).not.toContain(MAT);
    expect((await issuePerson(h.db, await p(SABINE), LEA, day))!.books[0]).toMatchObject({ overdue: true, dunningLevel: 1 });
  });

  it("Rücknahme: Zustand und Vermerk ans Exemplar, Zuordnung weg; mit Befund bleibt sie bis zur Erledigung", async () => {
    const s = await p(SABINE);
    const r = await scanIssue(h.db, s, numbers[0]!, null, day, { condition: "schlecht", conditionNote: "Einband lose" });
    expect(r).toMatchObject({ kind: "return", inventoryNumber: numbers[0], finding: false, condition: "schlecht", overdueDays: 3 });
    const [copy] = await h.db.select().from(buechereiMaterialCopies).where(eq(buechereiMaterialCopies.inventoryNumber, numbers[0]!));
    expect(copy).toMatchObject({ condition: "schlecht", conditionNote: "Einband lose" });
    expect(await h.db.select().from(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.userId, LEA))).toEqual([]);
    await fails(takeBack(h.db, s, numbers[0]!, day), /nicht ausgegeben/);
    await fails(takeBack(h.db, s, numbers[0]!, day, { condition: "zerfleddert" }), /Zustand/);

    await issueCopy(h.db, s, LEA, numbers[1]!, day);
    const back = await takeBack(h.db, s, numbers[1]!, day, { finding: "Wasserschaden" });
    expect(back.finding).toBe(true);
    const findings = await issueFindings(h.db, s);
    const mine = findings.find((f) => f.userId === LEA)!;
    expect(mine).toMatchObject({ inventoryNumber: numbers[1], finding: "Wasserschaden", name: "Lea Schäfer", className: "7b" });
    expect((await schoolbookAuskunft(h.db, LEA)).map((x) => x.befund)).toEqual(["Wasserschaden"]);
    // das Exemplar ist wieder frei
    await issueCopy(h.db, s, JANA, numbers[1]!, day);
    await takeBack(h.db, s, numbers[1]!, day);
    await resolveIssueFinding(h.db, s, mine.id, day);
    await fails(resolveIssueFinding(h.db, s, mine.id, day), /schon erledigt/);

    // Audit: Ausgabe/Rücknahme nur mit Inventarnummer, nie mit Person; Befund mit der Ausgabe-ID
    const audits = await h.db.select().from(auditLog).where(like(auditLog.action, "buecherei.material.%"));
    expect(audits.filter((a) => a.action === "buecherei.material.issue").length).toBeGreaterThan(2);
    expect(audits.find((a) => a.action === "buecherei.material.finding")).toMatchObject({ target: mine.id, meta: { inventoryNumber: numbers[1], finding: "Wasserschaden" } });
    for (const a of audits) expect(JSON.stringify([a.target, a.meta])).not.toContain(LEA);
  });

  it("Schuljahr mit Schulbuch-Ausgaben lässt sich nicht löschen", async () => {
    const [old] = await h.db.insert(schoolYears).values({ name: "2025/26", startsOn: "2025-08-01", endsOn: "2026-07-31" }).returning({ id: schoolYears.id });
    const [c] = await h.db.select({ id: buechereiMaterialCopies.id }).from(buechereiMaterialCopies).where(eq(buechereiMaterialCopies.inventoryNumber, numbers[2]!));
    await h.db.insert(buechereiMaterialIssues).values({ copyId: c!.id, userId: JANA, schoolYearId: old!.id, issuedOn: "2025-09-01", dueOn: "2026-07-31" });
    await fails(deleteSchoolYear(h.db, SABINE, old!.id), /1 ausgegebenes Schulbuch/);
    // offener Posten aus dem Vorjahr: an der Person sichtbar, Rücknahme per Scan wie immer
    expect((await issuePerson(h.db, await p(SABINE), JANA, day))!.books[0]).toMatchObject({ previousYear: true, overdue: true });
    await takeBack(h.db, await p(SABINE), numbers[2]!, day);
    await deleteSchoolYear(h.db, SABINE, old!.id);
  });
});
