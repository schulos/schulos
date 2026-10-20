// Schulbücherei Stufe 2 – Ersatzforderungen (BU-12): Kandidaten (Befunde beider Stufen, Verlust), anlegen mit Prüfungen, je Befund
// eine Forderung, Verlust schließt die Ausgabe und sondert aus, Status bezahlt/erlassen erledigt den Befund (Löschfrist), Brief an
// die Eltern Minderjähriger bzw. an die Person, Rechte (S83), eigene Sicht, Eltern, Auskunft, Löschklassen.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, buechereiCompensations, buechereiLoans, buechereiMaterialCopies, buechereiMaterialIssues, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { planDeletion } from "@/core/privacy/loeschlauf";
import { addDays } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { issueCopy, issueFindings, takeBack } from "./ausgabe";
import { dueDate } from "./dates";
import {
  LOSS_REASON,
  childrenCompensations,
  compensationAuskunft,
  compensationCandidates,
  compensationLetter,
  compensationText,
  createCompensation,
  listCompensations,
  openCompensationsOf,
  setCompensationStatus,
  updateCompensation,
} from "./ersatz";
import { createMaterial } from "./lernmittel";
import { checkin, checkout, listFindings } from "./loans";
import { createTitle } from "./service";
import { LERNMITTEL } from "./settings";

const SABINE = "u-sabine.kowalski"; // Verwaltung: `buecherei.materials`
const AYLIN = "u-aylin.demir"; // Büchereiteam
const JANA = "u-jana.brandt"; // Lehrkraft (volljährig)
const LEA = "u-lea.schaefer"; // Schülerin 7b (minderjährig)
const MUTTER = "u-daniela.schaefer";
const MAT = "Ersatzprobe Rechnen 7";

const fails = (pr: Promise<unknown>, re: RegExp) =>
  expect(pr).rejects.toSatisfy((e: unknown) => e instanceof ValidationError && re.test(Object.values(e.fieldErrors).join(" | ")));

describe("Ersatzforderungen", () => {
  let h: DbHandle;
  let day: string;
  let numbers: string[];
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    day = await dueDate(h.db, "2026-11-09", 0);
    ({ numbers } = await createMaterial(h.db, await p(SABINE), { title: MAT, grades: [7], provision: "leihe", price: "24,50" }, { count: 3 }));
  });
  afterAll(async () => {
    await h.close();
  });

  it("S83: nur mit `buecherei.materials` und eingeschalteter Schulbuchausleihe", async () => {
    for (const who of [AYLIN, JANA, LEA, MUTTER]) {
      const v = await p(who);
      await expect(compensationCandidates(h.db, v, day)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createCompensation(h.db, v, { issueId: "x" }, { amount: "1" }, day)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setCompensationStatus(h.db, v, "x", "bezahlt", day)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(compensationLetter(h.db, v, "x", day)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await writeModuleSetting(h.db, LERNMITTEL, "0");
    try {
      await fails(listCompensations(h.db, await p(SABINE), { open: true }), /ausgeschaltet/);
    } finally {
      await writeModuleSetting(h.db, LERNMITTEL, "1");
    }
  });

  it("Demo: offene Forderung zum Schulbuch-Befund, Bücherei-Befund noch zu klären", async () => {
    const s = await p(SABINE);
    const open = await listCompensations(h.db, s, { open: true });
    expect(open).toEqual([expect.objectContaining({ reason: "Wasserschaden, Seiten gewellt", amountCents: 2890, className: "5a" })]);
    const cands = await compensationCandidates(h.db, s, day);
    expect(cands.map((c) => [c.kind, c.reason])).toContainEqual(["ausleihe", "Seiten eingerissen"]);
    // der Befund mit Forderung steht nicht mehr in der Liste „Offene Befunde“
    expect((await issueFindings(h.db, s)).length).toBe(0);
  });

  it("Schulbuch-Befund → Forderung (Preis als Vorschlag), Prüfungen, je Befund nur eine, Status schließt den Befund ab", async () => {
    const s = await p(SABINE);
    await issueCopy(h.db, s, LEA, numbers[0]!, day);
    await takeBack(h.db, s, numbers[0]!, day, { finding: "Einband abgerissen" });
    const [issue] = await h.db.select().from(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.userId, LEA));
    const cand = (await compensationCandidates(h.db, s, day)).find((c) => c.id === issue!.id)!;
    expect(cand).toMatchObject({ kind: "schulbuch", suggestedCents: 2450, reason: "Einband abgerissen", name: "Lea Schäfer", className: "7b" });

    await fails(createCompensation(h.db, s, { issueId: issue!.id }, { amount: "zwölf" }, day), /Betrag/);
    await fails(createCompensation(h.db, s, { issueId: issue!.id }, { amount: "0" }, day), /Betrag/);
    await fails(createCompensation(h.db, s, { issueId: "gibtsnicht" }, { amount: "5" }, day), /gibt es nicht/);
    const id = await createCompensation(h.db, s, { issueId: issue!.id }, { amount: "24,50" }, day);
    await fails(createCompensation(h.db, s, { issueId: issue!.id }, { amount: "1" }, day), /schon eine Ersatzforderung/);
    expect((await compensationCandidates(h.db, s, day)).some((c) => c.id === issue!.id)).toBe(false);
    const [row] = await h.db.select().from(buechereiCompensations).where(eq(buechereiCompensations.id, id));
    expect(row).toMatchObject({ userId: LEA, item: `${MAT} (${numbers[0]})`, reason: "Einband abgerissen", amountCents: 2450, status: "offen", createdOn: day });

    await updateCompensation(h.db, s, id, { amount: "12", reason: "Einband abgerissen, Seiten ok" });
    expect((await openCompensationsOf(h.db, LEA)).map((c) => c.amountCents)).toEqual([1200]);
    expect((await childrenCompensations(h.db, await p(MUTTER))).get(LEA)!.map((c) => c.item)).toEqual([`${MAT} (${numbers[0]})`]);

    // Brief: an die Eltern (minderjährig), vermerkt das Druckdatum
    const letter = await compensationLetter(h.db, s, id, day);
    expect(letter).toMatchObject({ toParents: true, person: "Lea Schäfer", className: "7b", amountCents: 1200 });
    expect(letter!.recipients).toContain("Daniela Schäfer");
    expect((await h.db.select().from(buechereiCompensations).where(eq(buechereiCompensations.id, id)))[0]!.letterOn).toBe(day);

    await setCompensationStatus(h.db, s, id, "bezahlt", day);
    await fails(setCompensationStatus(h.db, s, id, "bezahlt", day), /schon diesen Status/);
    await fails(setCompensationStatus(h.db, s, id, "verschenkt", day), /Status/);
    await fails(updateCompensation(h.db, s, id, { amount: "3", reason: "anders" }), /Nur offene/);
    const [after] = await h.db.select().from(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.id, issue!.id));
    expect(after!.findingResolvedOn).toBe(day);
    expect(await openCompensationsOf(h.db, LEA)).toEqual([]);
    // wieder öffnen nimmt auch die Erledigung des Befunds zurück
    await setCompensationStatus(h.db, s, id, "offen", day);
    expect((await h.db.select().from(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.id, issue!.id)))[0]!.findingResolvedOn).toBeNull();
    await setCompensationStatus(h.db, s, id, "erlassen", day);

    const auskunft = await compensationAuskunft(h.db, LEA);
    expect(auskunft).toEqual([expect.objectContaining({ status: "erlassen", betragCent: 1200, abgeschlossen: day })]);
    expect(compensationText(auskunft)).toContain("12,00 €");
    expect(compensationText([])).toBeNull();
  });

  it("Verlust: nicht zurückgegebenes Schulbuch → Forderung schließt die Ausgabe (Mahnung endet) und sondert das Exemplar aus", async () => {
    const s = await p(SABINE);
    await issueCopy(h.db, s, JANA, numbers[1]!, day);
    const [issue] = await h.db.select().from(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.userId, JANA));
    expect((await compensationCandidates(h.db, s, day)).some((c) => c.id === issue!.id)).toBe(false); // Frist läuft noch
    await h.db.update(buechereiMaterialIssues).set({ dueOn: addDays(day, -10), dunningLevel: 2 }).where(eq(buechereiMaterialIssues.id, issue!.id));
    expect((await compensationCandidates(h.db, s, day)).find((c) => c.id === issue!.id)).toMatchObject({ kind: "verlust", reason: LOSS_REASON, suggestedCents: 2450 });
    const id = await createCompensation(h.db, s, { issueId: issue!.id }, { amount: "24,50", reason: "" }, day);
    const [i] = await h.db.select().from(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.id, issue!.id));
    expect(i).toMatchObject({ returnedOn: day, finding: LOSS_REASON, dunningLevel: 0 });
    const [c] = await h.db.select().from(buechereiMaterialCopies).where(eq(buechereiMaterialCopies.inventoryNumber, numbers[1]!));
    expect(c).toMatchObject({ withdrawnOn: day, withdrawnReason: "verloren (Ersatzforderung)" });
    // Brief an eine volljährige Person geht an sie selbst
    expect(await compensationLetter(h.db, s, id, day)).toMatchObject({ toParents: false, recipients: ["Jana Brandt"] });
  });

  it("Bücherei-Befund (Stufe 1) → Forderung; Theke-Befundliste zeigt ihn dann nicht mehr", async () => {
    const s = await p(SABINE);
    const { barcodes } = await createTitle(h.db, s, { title: "Ersatzprobe Roman", mediaType: "buch" }, { count: 1 });
    await checkout(h.db, s, LEA, barcodes[0]!, day);
    await checkin(h.db, s, barcodes[0]!, day, "Kaffeefleck");
    const [loan] = await h.db.select().from(buechereiLoans).where(eq(buechereiLoans.finding, "Kaffeefleck"));
    expect((await listFindings(h.db, s)).some((f) => f.id === loan!.id)).toBe(true);
    await createCompensation(h.db, s, { loanId: loan!.id }, { amount: "8" }, day);
    expect((await listFindings(h.db, s)).some((f) => f.id === loan!.id)).toBe(false);
    const audits = await h.db.select().from(auditLog).where(like(auditLog.action, "buecherei.compensation.%"));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["buecherei.compensation.create", "buecherei.compensation.status", "buecherei.compensation.letter", "buecherei.compensation.update"]));
  });

  it("Löschklassen: offen bleibt (mit dem Konto), abgeschlossen nach Schuljahresende + 1 Jahr; Kontolöschung leert die Person", async () => {
    const item = async (today: string, scope: string) => (await planDeletion(h.db, today)).find((x) => x.table === "buecherei_compensations" && x.scope === scope)!;
    expect((await item("2028-09-01", "offene Ersatzforderungen")).status).toBe("skipped");
    expect((await item("2027-09-01", "abgeschlossene Ersatzforderungen")).count).toBe(0);
    expect((await item("2028-09-01", "abgeschlossene Ersatzforderungen")).count).toBe(1);
    const KIND = "u-ersatz-probe";
    await h.db.insert(users).values({ id: KIND, username: "ersatz.probe", name: "Probe", firstName: "P", lastName: "K", role: "schueler", email: "ersatz.probe@example.org" });
    const s = await p(SABINE);
    await issueCopy(h.db, s, KIND, numbers[2]!, day);
    await takeBack(h.db, s, numbers[2]!, day, { finding: "kaputt" });
    const [i] = await h.db.select().from(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.userId, KIND));
    const id = await createCompensation(h.db, s, { issueId: i!.id }, { amount: "3" }, day);
    await h.db.delete(users).where(eq(users.id, KIND));
    expect((await h.db.select().from(buechereiCompensations).where(eq(buechereiCompensations.id, id)))[0]).toMatchObject({ userId: null, status: "offen" });
    expect(await compensationLetter(h.db, s, id, day)).toBeNull();
  });
});
