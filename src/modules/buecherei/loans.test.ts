// Schulbücherei – Theke (BU-02): Ausleihe, Rückgabe ohne Personenbezug danach, Befund, Verlängern, Sichtbarkeit (SICHERHEIT S73).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, buechereiCopies, buechereiLoans, buechereiStats, groupMembers } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { addDays } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { checkin, checkout, deskPerson, deskSummary, dueDate, listFindings, nextOpenDay, normalizeScan, renewLoan, resolveFinding, scanAtDesk, searchBorrowers } from "./loans";
import { createTitle, getTitle, withdrawCopy } from "./service";
import { DEFAULT_LOAN_DAYS, LOAN_DAYS, MAX_RENEWALS } from "./settings";

const TODAY = "2026-10-19";
const SABINE = "u-sabine.kowalski"; // Sekretariat (Rolle verwaltung)
const JANA = "u-jana.brandt"; // Lehrkraft ohne Team
const LEA = "u-lea.schaefer"; // Schülerin 7b

/** ValidationError mit passender Feldmeldung (die Meldung des Fehlers selbst ist allgemein). */
const fails = (pr: Promise<unknown>, re: RegExp) =>
  expect(pr).rejects.toSatisfy((e: unknown) => e instanceof ValidationError && Object.values(e.fieldErrors).some((m) => re.test(m)));

describe("Bücherei-Theke – rein", () => {
  it("Fälligkeit nie am Wochenende oder in Schließzeiten", () => {
    expect(nextOpenDay("2026-10-21", [])).toBe("2026-10-21"); // Mittwoch
    expect(nextOpenDay("2026-10-24", [])).toBe("2026-10-26"); // Samstag → Montag
    expect(nextOpenDay("2026-10-21", [{ startsOn: "2026-10-20", endsOn: "2026-10-30" }])).toBe("2026-11-02");
  });

  it("Scan normalisiert", () => {
    expect(normalizeScan(" b-000001-8\n")).toBe("B-000001-8");
  });
});

describe("Bücherei-Theke", () => {
  let h: DbHandle;
  let helper: string;
  const p = (id: string) => loadPermissions(h.db, id);
  let book: string[];

  beforeAll(async () => {
    h = await createSeededTestDb();
    const [m] = await h.db
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, "g-buecherei"), eq(groupMembers.role, "member")));
    helper = m!.userId;
    ({ barcodes: book } = await createTitle(h.db, await p(SABINE), { title: "Thekenbuch", mediaType: "buch" }, { count: 3 }));
  });
  afterAll(async () => {
    await h.close();
  });

  it("S73: nur mit `buecherei.desk` – Lehrkraft und Schülerin ohne Team bekommen nichts", async () => {
    for (const id of [JANA, LEA]) {
      const perms = await p(id);
      await expect(searchBorrowers(h.db, perms, "Schäfer")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deskPerson(h.db, perms, LEA, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(scanAtDesk(h.db, perms, book[0]!, LEA, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(renewLoan(h.db, perms, "x", TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("S73: Personensuche liefert nur Name und Klasse, nur Konten, die ausleihen können", async () => {
    const perms = await p(helper); // Schüler-Helfer:in im Büchereiteam
    const hits = await searchBorrowers(h.db, perms, "lea 7b");
    expect(hits).toContainEqual({ id: LEA, name: expect.stringContaining("Schäfer"), className: "7b" });
    expect(hits.every((x) => x.className === "7b" && Object.keys(x).length === 3)).toBe(true);
    expect(await searchBorrowers(h.db, perms, "a")).toEqual([]); // zu kurz
    // Eltern und Admin-Konten nicht
    const all = await searchBorrowers(h.db, await p(SABINE), "admin");
    expect(all.map((x) => x.id)).not.toContain("u-admin");
    expect(await deskPerson(h.db, perms, "u-admin", TODAY)).toBeNull();
  });

  it("Ausleihe: Fälligkeit nach Leihfrist der Medienart, Zähler ohne Person, Doppel- und Fehlscans abgewiesen", async () => {
    const team = await p(helper);
    const before = await h.db.select().from(buechereiStats).where(and(eq(buechereiStats.month, "2026-10"), eq(buechereiStats.mediaType, "buch")));
    const r = await scanAtDesk(h.db, team, book[0]!.toLowerCase(), LEA, TODAY);
    expect(r).toMatchObject({ kind: "loan", title: "Thekenbuch", barcode: book[0], dueOn: await dueDate(h.db, TODAY, DEFAULT_LOAN_DAYS.buch) });
    if (r.kind !== "loan") throw new Error("Ausleihe erwartet");
    const [after] = await h.db.select().from(buechereiStats).where(and(eq(buechereiStats.month, "2026-10"), eq(buechereiStats.mediaType, "buch")));
    expect(after!.loans).toBe((before[0]?.loans ?? 0) + 1);
    await fails(checkout(h.db, team, JANA, book[0]!, TODAY), /schon ausgeliehen/);
    const [p0, d0, c0] = book[1]!.split("-");
    await fails(scanAtDesk(h.db, team, `${p0}-${d0}-${(Number(c0) + 1) % 10}`, LEA, TODAY), /Prüfziffer/);
    await fails(scanAtDesk(h.db, team, book[1]!, null, TODAY), /erst die Person wählen/);
    // Leihfrist aus der Moduleinstellung
    await writeModuleSetting(h.db, LOAN_DAYS.buch, "7");
    const r2 = await checkout(h.db, team, LEA, book[1]!, TODAY);
    expect(r2.dueOn).toBe(await dueDate(h.db, TODAY, 7));
    expect(r2.dueOn >= addDays(TODAY, 7)).toBe(true);
    await writeModuleSetting(h.db, LOAN_DAYS.buch, String(DEFAULT_LOAN_DAYS.buch));
    // Theke sieht Name, Klasse, offene Ausleihen – sonst nichts
    const view = await deskPerson(h.db, team, LEA, TODAY);
    expect(Object.keys(view!).sort()).toEqual(["active", "className", "id", "loans", "name"]);
    expect(view!.loans.map((l) => l.barcode).sort()).toEqual([book[0], book[1]].sort());
    // Bestand zeigt „ausgeliehen bis“ ohne Person; Aussondern erst nach Rückgabe
    const [copy] = await h.db.select().from(buechereiCopies).where(eq(buechereiCopies.barcode, book[0]!));
    const t = await getTitle(h.db, await p(SABINE), copy!.titleId);
    expect(t!.copies.find((c) => c.id === copy!.id)!.loanDueOn).toBe(r.dueOn);
    expect(JSON.stringify(t)).not.toContain(LEA);
    await fails(withdrawCopy(h.db, await p(SABINE), copy!.id, "verloren", TODAY), /ausgeliehen/);
    expect((await deskSummary(h.db, team, TODAY)).open).toBeGreaterThanOrEqual(2);
  });

  it("Rückgabe ohne Befund löscht die Ausleihe – kein Verlauf, auch nicht im Audit-Log", async () => {
    const team = await p(helper);
    const r = await scanAtDesk(h.db, team, book[0]!, null, TODAY);
    expect(r).toMatchObject({ kind: "return", barcode: book[0], finding: false, overdueDays: 0 });
    const [copy] = await h.db.select().from(buechereiCopies).where(eq(buechereiCopies.barcode, book[0]!));
    expect(await h.db.select().from(buechereiLoans).where(eq(buechereiLoans.copyId, copy!.id))).toEqual([]);
    expect((await deskPerson(h.db, team, LEA, TODAY))!.loans.map((l) => l.barcode)).toEqual([book[1]]);
    const audits = await h.db.select({ action: auditLog.action, target: auditLog.target, meta: auditLog.meta }).from(auditLog);
    expect(audits.filter((a) => a.action.startsWith("buecherei.") && (a.target === LEA || JSON.stringify(a.meta ?? "").includes(LEA)))).toEqual([]);
    await fails(checkin(h.db, team, book[0]!, TODAY), /nicht ausgeliehen/);
    // überfällig: Zahl der Tage
    await checkout(h.db, team, LEA, book[0]!, addDays(TODAY, -40));
    expect((await checkin(h.db, team, book[0]!, TODAY)).overdueDays).toBeGreaterThan(0);
  });

  it("Verlängern höchstens n-mal, Frist ab heute, nie früher", async () => {
    const team = await p(helper);
    await writeModuleSetting(h.db, MAX_RENEWALS, "1");
    const loan = (await deskPerson(h.db, team, LEA, TODAY))!.loans[0]!;
    const later = addDays(TODAY, 10);
    const r = await renewLoan(h.db, team, loan.id, later);
    const next = await dueDate(h.db, later, DEFAULT_LOAN_DAYS.buch);
    expect(r).toEqual({ dueOn: next > loan.dueOn ? next : loan.dueOn, renewals: 1 });
    await fails(renewLoan(h.db, team, loan.id, later), /Schon 1-mal verlängert/);
    await writeModuleSetting(h.db, MAX_RENEWALS, "0");
    await fails(renewLoan(h.db, team, loan.id, later), /ausgeschaltet/);
    await writeModuleSetting(h.db, MAX_RENEWALS, "2");
  });

  it("Rückgabe mit Befund: bleibt bis zur Erledigung, nur für `materials` sichtbar, nicht an der Theke", async () => {
    const team = await p(helper);
    await expect(checkin(h.db, team, book[1]!, TODAY, "x".repeat(201))).rejects.toBeInstanceOf(ValidationError);
    const r = await checkin(h.db, team, book[1]!, TODAY, "Einband gebrochen");
    expect(r.finding).toBe(true);
    expect((await deskPerson(h.db, team, LEA, TODAY))!.loans).toEqual([]);
    await expect(listFindings(h.db, team)).rejects.toBeInstanceOf(ForbiddenError);
    const sabine = await p(SABINE);
    const open = await listFindings(h.db, sabine);
    const mine = open.find((f) => f.barcode === book[1]);
    expect(mine).toMatchObject({ finding: "Einband gebrochen", userId: LEA, className: "7b", returnedOn: TODAY });
    // Demo-Befund aus dem Seed
    expect(open.some((f) => f.finding === "Seiten eingerissen")).toBe(true);
    await expect(resolveFinding(h.db, team, mine!.id, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    await resolveFinding(h.db, sabine, mine!.id, TODAY);
    await expect(resolveFinding(h.db, sabine, mine!.id, TODAY)).rejects.toBeInstanceOf(ValidationError);
    expect((await listFindings(h.db, sabine)).some((f) => f.id === mine!.id)).toBe(false);
    const actions = (await h.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.target, mine!.id))).map((a) => a.action);
    expect(actions.sort()).toEqual(["buecherei.loan.finding", "buecherei.loan.resolve"]);
    // das Exemplar ist wieder ausleihbar
    const again = await checkout(h.db, team, LEA, book[1]!, TODAY);
    expect(again.barcode).toBe(book[1]);
  });

  it("Demo-Ausleihen vorhanden, unbekannte Konten können nicht ausleihen", async () => {
    const team = await p(helper);
    const seeded = await h.db.select({ userId: buechereiLoans.userId }).from(buechereiLoans).where(isNull(buechereiLoans.returnedOn));
    expect(seeded.length).toBeGreaterThanOrEqual(3);
    await fails(checkout(h.db, team, "u-gibts-nicht", book[2]!, TODAY), /kann nicht ausleihen/);
  });
});
