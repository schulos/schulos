// INV-05: Ausleihe von Inventar – Rechte (verleihen nur Pflegende der Kategorie, Sicht auf Namen nur für sie und die Person selbst),
// Regeln (Einzelstücke in Betrieb, eine offene Ausleihe je Gerät, Ausleih-Rollen, Rückgabedatum), Frist ändern/Rückgabe/Stornieren,
// Ausmustern gesperrt, Inventur „verliehen“ statt „fehlt“, Erinnerungen (vorher, überfällig 1–3, Eltern ab 2, Pflegende bei 1,
// ohne Gerät, Mail optional), Löschklasse LK-ENDE-1J, Auskunft/Eigenexport, Kontolöschung, Leihvertrag.
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, gebaeudeAssetCategories, gebaeudeLoans, mailOutbox, notifications, rooms, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { collectPersonalData } from "@/core/privacy/auskunft";
import { planOwnExport } from "@/core/privacy/eigenexport";
import { deleteAccounts } from "@/core/privacy/konto";
import { planDeletion } from "@/core/privacy/loeschlauf";
import { userRefs } from "@/core/privacy/refs";
import { SCHEDULED_JOBS } from "@/core/scheduler";
import { addDays, weekdayMon0 } from "@/core/time";
import { dueDate } from "@/modules/buecherei/dates";
import { ValidationError } from "@/modules/verwaltung/users";
import { assetHistory } from "./asset-seite";
import { ensureCategories } from "./inventar";
import { closeInventory, getInventory, startInventory } from "./inventur";
import { loanState } from "./labels";
import {
  assetLoans,
  cancelLoan,
  extendLoan,
  hasOpenLoan,
  lendAsset,
  listOpenLoans,
  loanAuskunft,
  loanBorrower,
  loanContract,
  loanText,
  myLoans,
  openLoanCounts,
  overdueLoanMail,
  returnLoan,
  runLoanReminders,
  searchLoanBorrowers,
} from "./leihe";
import { createAsset, setAssetActive } from "./pruefungen";
import { LOAN_MAIL, LOAN_REMIND_DAYS } from "./settings";

const SABINE = "u-sabine.kowalski"; // Verwaltung: configure
const KLAUS = "u-klaus.berger"; // Hausmeisterei: inventory über die Gruppe
const JANA = "u-jana.brandt"; // Lehrkraft: report
const LEA = "u-lea.schaefer"; // Schülerin 7b (minderjährig)
const MUTTER = "u-daniela.schaefer"; // Elternteil von Lea
const OPTS = { mail: true, school: "Testschule" };
const DEVICE = "Tablet Geheimname";

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("INV-05 (rein)", () => {
  it("Stand einer Ausleihe und Mail ohne Gerät", () => {
    expect(loanState({ dueOn: "2026-11-10", returnedAt: null }, "2026-11-10")).toBe("offen");
    expect(loanState({ dueOn: "2026-11-09", returnedAt: null }, "2026-11-10")).toBe("ueberfaellig");
    expect(loanState({ dueOn: "2026-11-09", returnedAt: new Date() }, "2026-11-10")).toBe("zurueck");
    const m = overdueLoanMail({ school: "S", level: 2, count: 1, since: "2026-11-02", link: "https://x/gebaeude/leihen/meine", child: "Lea" });
    expect(m.subject).toBe("S: Leihgerät zurückgeben (2. Erinnerung)");
    expect(m.text).toContain("das Lea ausgeliehen hat");
    expect(m.text).toContain("02.11.2026");
  });

  it("Job `gebaeude-leihe` steht im Zeitplan", () => {
    expect(SCHEDULED_JOBS.find((j) => j.name === "gebaeude-leihe")).toMatchObject({ at: "06:50", until: "20:00" });
  });

  it("Personenbezug: Verweis auf das Konto wird bei Kontolöschung geleert (set null), nicht gelöscht", () => {
    expect(userRefs().find((r) => r.table === "gebaeude_loans")).toMatchObject({ column: "user_id", onDelete: "set null" });
  });
});

describe("INV-05: Ausleihe – Service", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  const cats = new Map<string, string>();
  const cat = (key: string) => cats.get(key)!;
  let tablet: string;
  let laptop: string;
  let stuehle: string;
  let today: string;
  const school = (ymd: string) => dueDate(h.db, ymd, 0);
  const gong = async (userId: string, key: string) => {
    const [n] = await h.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.bundleKey, key)));
    return n ?? null;
  };
  const loanOf = async (id: string) => (await h.db.select().from(gebaeudeLoans).where(eq(gebaeudeLoans.id, id)))[0]!;

  beforeAll(async () => {
    h = await createSeededTestDb();
    await ensureCategories(h.db);
    for (const c of await h.db.select({ id: gebaeudeAssetCategories.id, key: gebaeudeAssetCategories.key }).from(gebaeudeAssetCategories)) cats.set(c.key, c.id);
    await h.db.insert(rooms).values([{ id: "LEI1", name: "Medienraum" }]);
    today = await school("2026-11-09");
    const klaus = await p(KLAUS);
    tablet = await createAsset(h.db, klaus, { name: DEVICE, categoryId: cat("it"), roomId: "LEI1", inventoryNo: "IT-8001", serial: "SN-1" }, today);
    laptop = await createAsset(h.db, klaus, { name: "Laptop", categoryId: cat("it"), roomId: "LEI1", inventoryNo: "IT-8002" }, today);
    stuehle = await createAsset(h.db, klaus, { name: "Stühle", categoryId: cat("moebel"), roomId: "LEI1", inventoryNo: "MOE-8001", quantity: 12 }, today);
  }, 60_000);
  afterAll(async () => {
    await h.close();
  });

  it("Rechte und Regeln: nur Pflegende verleihen, nur Einzelstücke in Betrieb, Ausleih-Rollen, Rückgabedatum", async () => {
    const [klaus, jana, lea, mutter] = await Promise.all([p(KLAUS), p(JANA), p(LEA), p(MUTTER)]);
    const due = addDays(today, 14);
    await expect(lendAsset(h.db, jana, tablet, { userId: LEA, dueOn: due }, today)).rejects.toThrow(ForbiddenError);
    await expect(lendAsset(h.db, lea, tablet, { userId: LEA, dueOn: due }, today)).rejects.toThrow(ForbiddenError);
    await expect(searchLoanBorrowers(h.db, jana, "lea")).rejects.toThrow(ForbiddenError);
    await expect(listOpenLoans(h.db, mutter, today)).rejects.toThrow(ForbiddenError);
    // Eltern leihen nicht aus; Rückgabedatum nicht in der Vergangenheit, nicht weiter als zwei Jahre
    expect(await fieldErrors(lendAsset(h.db, klaus, tablet, { userId: MUTTER, dueOn: due }, today))).toEqual({ userId: "Diese Person kann nichts ausleihen" });
    expect(await fieldErrors(lendAsset(h.db, klaus, tablet, { userId: LEA, dueOn: addDays(today, -1) }, today))).toEqual({ dueOn: "Das Rückgabedatum liegt in der Vergangenheit" });
    expect(await fieldErrors(lendAsset(h.db, klaus, tablet, { userId: LEA, dueOn: addDays(today, 800) }, today))).toEqual({ dueOn: "Höchstens zwei Jahre im Voraus" });
    expect(await fieldErrors(lendAsset(h.db, klaus, tablet, { userId: LEA, dueOn: "morgen" }, today))).toEqual({ dueOn: "Rückgabedatum wählen" });
    expect((await fieldErrors(lendAsset(h.db, klaus, stuehle, { userId: LEA, dueOn: due }, today))).asset).toContain("Sammelposten");
    // Personensuche: Name oder Klasse, keine Eltern
    expect((await searchLoanBorrowers(h.db, klaus, "lea 7b")).map((b) => b.id)).toContain(LEA);
    expect((await searchLoanBorrowers(h.db, klaus, "schäfer")).map((b) => b.id)).not.toContain(MUTTER);
    expect(await loanBorrower(h.db, klaus, LEA)).toMatchObject({ id: LEA, className: "7b" });
    expect(await loanBorrower(h.db, klaus, MUTTER)).toBeNull();
  });

  it("Verleihen, Sicht, Frist ändern, Ausmustern gesperrt, Rückgabe, Stornieren, Historie ohne Namen", async () => {
    const [klaus, jana, lea, mutter, sabine] = await Promise.all([p(KLAUS), p(JANA), p(LEA), p(MUTTER), p(SABINE)]);
    const id = await lendAsset(h.db, klaus, tablet, { userId: LEA, dueOn: addDays(today, 14), accessories: " Ladekabel, Hülle " }, today);
    expect(await hasOpenLoan(h.db, tablet)).toBe(true);
    expect(await fieldErrors(lendAsset(h.db, sabine, tablet, { userId: JANA, dueOn: addDays(today, 14) }, today))).toEqual({ asset: "Das Gerät ist schon verliehen – erst die Rückgabe buchen" });

    // Pflegende: Person + Klasse; Lehrkraft ohne Recht: nichts; die Schülerin selbst: ihre Ausleihe
    const full = await assetLoans(h.db, klaus, { id: tablet, categoryId: cat("it") }, today);
    expect(full.current).toMatchObject({ borrower: "Lea Schäfer", className: "7b", accessories: "Ladekabel, Hülle", state: "offen" });
    expect(full.maintain).toBe(true);
    expect((await assetLoans(h.db, jana, { id: tablet, categoryId: cat("it") }, today)).current).toBeNull();
    const own = await assetLoans(h.db, lea, { id: tablet, categoryId: cat("it") }, today);
    expect(own).toMatchObject({ mine: true, maintain: false, past: [] });
    expect(own.current).toMatchObject({ borrower: "Lea Schäfer" });
    // Meine Leihgeräte: Schülerin selbst, Mutter (Kind, lesend)
    expect((await myLoans(h.db, lea, today)).own.map((l) => l.assetName)).toEqual([DEVICE]);
    expect((await myLoans(h.db, mutter, today)).children).toMatchObject([{ id: LEA, loans: [{ assetName: DEVICE }] }]);
    expect((await myLoans(h.db, jana, today)).own).toEqual([]);
    // Übersicht und Abgang-Hinweis
    expect((await listOpenLoans(h.db, klaus, today)).map((l) => l.id)).toEqual([id]);
    expect((await openLoanCounts(h.db, [LEA, JANA])).get(LEA)).toBe(1);

    // Ausmustern erst nach der Rückgabe
    expect(await fieldErrors(setAssetActive(h.db, klaus, tablet, false, today, "defekt"))).toEqual({ asset: "Das Gerät ist verliehen – erst die Rückgabe buchen" });

    // Frist ändern setzt Erinnerungen zurück
    await h.db.update(gebaeudeLoans).set({ remindedDueOn: addDays(today, 14), overdueLevel: 1, overdueOn: today }).where(eq(gebaeudeLoans.id, id));
    await expect(extendLoan(h.db, jana, id, addDays(today, 30), today)).rejects.toThrow(ForbiddenError);
    await extendLoan(h.db, klaus, id, addDays(today, 30), today);
    expect(await loanOf(id)).toMatchObject({ dueOn: addDays(today, 30), remindedDueOn: null, overdueLevel: 0, overdueOn: null });

    // Leihvertrag: nur Pflegende, mit Minderjährigen-Unterschrift
    const contract = await loanContract(h.db, klaus, id, "Testschule");
    expect(contract).toMatchObject({ borrower: "Lea Schäfer", className: "7b", minor: true, serial: "SN-1", inventoryNo: "IT-8001", returned: false });
    expect(await loanContract(h.db, jana, id, "Testschule")).toBeNull();
    expect(await loanContract(h.db, lea, id, "Testschule")).toBeNull();

    // Rückgabe mit Befund, zweite Rückgabe abgewiesen
    await expect(returnLoan(h.db, jana, id, null)).rejects.toThrow(ForbiddenError);
    await returnLoan(h.db, klaus, id, "Hülle eingerissen");
    expect(await loanOf(id)).toMatchObject({ returnNote: "Hülle eingerissen", overdueLevel: 0 });
    expect((await loanOf(id)).returnedAt).toBeInstanceOf(Date);
    expect(await fieldErrors(returnLoan(h.db, klaus, id, null))).toEqual({ loan: "Die Rückgabe ist schon gebucht" });
    expect(await hasOpenLoan(h.db, tablet)).toBe(false);
    const after = await assetLoans(h.db, klaus, { id: tablet, categoryId: cat("it") }, today);
    expect(after.current).toBeNull();
    expect(after.past).toMatchObject([{ id, borrower: "Lea Schäfer", state: "zurueck" }]);
    // Ehemalige Ausleihe sieht die Person weiter unter „Meine Leihgeräte“, auf der Geräteseite nicht mehr
    expect((await assetLoans(h.db, lea, { id: tablet, categoryId: cat("it") }, today)).current).toBeNull();
    expect((await myLoans(h.db, lea, today)).own).toMatchObject([{ state: "zurueck", returnNote: "Hülle eingerissen" }]);

    // Stornieren: nur offene, Zeile weg
    const wrong = await lendAsset(h.db, klaus, laptop, { userId: JANA, dueOn: addDays(today, 7) }, today);
    await cancelLoan(h.db, klaus, wrong);
    expect(await h.db.select().from(gebaeudeLoans).where(eq(gebaeudeLoans.id, wrong))).toEqual([]);
    expect(await fieldErrors(cancelLoan(h.db, klaus, id))).toEqual({ loan: "Zurückgegebene Ausleihen lassen sich nicht stornieren" });

    // Historie und Audit: ohne Namen der entleihenden Person
    const history = await assetHistory(h.db, klaus, tablet);
    expect(history.map((x) => x.label)).toEqual(expect.arrayContaining(["Leihgerät verliehen", "Leihgerät: Rückgabedatum geändert", "Leihgerät zurückgenommen"]));
    expect(history.find((x) => x.label === "Leihgerät zurückgenommen")!.detail).toBe("mit Befund");
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.target, tablet));
    expect(JSON.stringify(audits.map((a) => a.meta))).not.toMatch(/Lea|Schäfer|u-lea/);
  });

  it("Inventur: verliehene Geräte stehen als „verliehen“, nicht „fehlt“; Scan macht „gefunden“", async () => {
    const klaus = await p(KLAUS);
    const loan = await lendAsset(h.db, klaus, laptop, { userId: JANA, dueOn: addDays(today, 7) }, today);
    const { id } = await startInventory(h.db, klaus, "LEI1");
    let inv = (await getInventory(h.db, klaus, id))!;
    expect(inv.items.find((i) => i.assetId === laptop)!.state).toBe("verliehen");
    expect(inv.summary).toMatchObject({ lent: 1 });
    // während der Inventur verliehen → beim Abschluss „verliehen“ statt „fehlt“
    await returnLoan(h.db, klaus, loan, null);
    await lendAsset(h.db, klaus, tablet, { userId: LEA, dueOn: addDays(today, 7) }, today);
    const summary = await closeInventory(h.db, klaus, id);
    inv = (await getInventory(h.db, klaus, id))!;
    expect(inv.items.find((i) => i.assetId === tablet)!.state).toBe("verliehen");
    expect(inv.items.find((i) => i.assetId === laptop)!.state).toBe("verliehen");
    expect(inv.items.find((i) => i.assetId === stuehle)!.state).toBe("fehlt");
    expect(summary).toMatchObject({ lent: 2, missing: 1 });
  });

  it("Erinnerungen: vorher an die Person, überfällig 1–3 an Schultagen, Eltern ab der 2., Pflegende bei der 1.; ohne Gerät; Mail optional", async () => {
    const klaus = await p(KLAUS);
    await h.db.delete(gebaeudeLoans);
    await h.db.update(users).set({ email: "lea@example.org", emailVerified: true }).where(eq(users.id, LEA));
    await h.db.update(users).set({ email: "mutter@example.org", emailVerified: true }).where(eq(users.id, MUTTER));
    await writeModuleSetting(h.db, LOAN_REMIND_DAYS, "3");
    const id = await lendAsset(h.db, klaus, tablet, { userId: LEA, dueOn: addDays(today, 2) }, today);

    // vorab: einmal je Rückgabedatum
    expect((await runLoanReminders(h.db, today, OPTS)).reminded).toBe(1);
    const pre = await gong(LEA, "gebaeude:leihe:erinnerung");
    expect(pre).toMatchObject({ title: "Leihgerät: Rückgabe bald fällig", href: "/gebaeude/leihen/meine" });
    expect(pre!.body).not.toContain(DEVICE);
    expect((await runLoanReminders(h.db, today, OPTS)).reminded).toBe(0);
    await writeModuleSetting(h.db, LOAN_REMIND_DAYS, "0");

    // überfällig: am Wochenende nichts
    await h.db.update(gebaeudeLoans).set({ dueOn: addDays(today, -1) }).where(eq(gebaeudeLoans.id, id));
    let closed = addDays(today, 1);
    while (weekdayMon0(closed) < 5) closed = addDays(closed, 1);
    expect((await runLoanReminders(h.db, closed, OPTS)).overdue).toBe(0);

    // 1.: Person + Pflegende, keine Eltern, keine Mail (Vorgabe aus)
    const r1 = await runLoanReminders(h.db, today, OPTS);
    expect(r1).toMatchObject({ overdue: 1, parents: 0 });
    expect(r1.staff).toBeGreaterThan(0);
    expect(await loanOf(id)).toMatchObject({ overdueLevel: 1, overdueOn: today });
    const g1 = await gong(LEA, "gebaeude:leihe:mahnung");
    expect(g1).toMatchObject({ title: "Leihgerät überfällig (1. Erinnerung)", href: "/gebaeude/leihen/meine" });
    expect(g1!.body).not.toContain(DEVICE);
    expect(g1!.body).not.toContain("Eltern");
    const staff = await gong(KLAUS, "gebaeude:leihe:ueberfaellig");
    expect(staff).toMatchObject({ title: "Leihgeräte überfällig", href: "/gebaeude/leihen" });
    expect(staff!.body).not.toMatch(/Lea|Schäfer/);
    expect(await gong(MUTTER, `gebaeude:leihe:mahnung:${LEA}`)).toBeNull();
    expect(await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "gebaeude-leihe"))).toEqual([]);
    expect((await runLoanReminders(h.db, today, OPTS)).overdue).toBe(0);

    // 2. mit Mail: Person + Eltern, beides ohne Gerät
    await writeModuleSetting(h.db, LOAN_MAIL, "1");
    const d2 = await school(addDays(today, 7));
    expect(await runLoanReminders(h.db, d2, OPTS)).toMatchObject({ overdue: 1, parents: 1 });
    expect((await gong(LEA, "gebaeude:leihe:mahnung"))!.body).toContain("Deine Eltern werden ebenfalls benachrichtigt");
    expect(await gong(MUTTER, `gebaeude:leihe:mahnung:${LEA}`)).toMatchObject({ title: "Leihgerät von Lea überfällig", href: "/gebaeude/leihen/meine" });
    const mails = await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "gebaeude-leihe"));
    expect(mails.map((m) => m.to).sort()).toEqual(["lea@example.org", "mutter@example.org"]);
    for (const m of mails) {
      expect(`${m.subject} ${m.text}`).not.toContain(DEVICE);
      expect(m.text).toContain("/gebaeude/leihen/meine");
    }
    await writeModuleSetting(h.db, LOAN_MAIL, "0");
    // 3. und dann Schluss
    const d3 = await school(addDays(d2, 7));
    expect((await runLoanReminders(h.db, d3, OPTS)).overdue).toBe(1);
    expect((await runLoanReminders(h.db, await school(addDays(d3, 30)), OPTS)).overdue).toBe(0);
    expect((await loanOf(id)).overdueLevel).toBe(3);
  });

  it("Auskunft, Eigenexport, Löschfrist (LK-ENDE-1J ab Rückgabe), Kontolöschung lässt offene Ausleihe ohne Person stehen", async () => {
    const klaus = await p(KLAUS);
    await h.db.delete(gebaeudeLoans);
    const open = await lendAsset(h.db, klaus, tablet, { userId: LEA, dueOn: addDays(today, 7), accessories: "Stift" }, today);
    const done = await lendAsset(h.db, klaus, laptop, { userId: LEA, dueOn: addDays(today, 7) }, today);
    await returnLoan(h.db, klaus, done, null, new Date("2024-01-10T10:00:00Z"));

    // Auskunft: Rohdaten über den Verweis + lesbarer Teil mit Gerät
    const rows = await loanAuskunft(h.db, LEA);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ geraet: expect.any(String), inventarnummer: expect.stringMatching(/^IT-800/) });
    const data = (await collectPersonalData(h.db, LEA))!;
    expect(data.sections.find((s) => s.table === "gebaeude_loans")!.rows).toHaveLength(2);
    expect(data.sections.find((s) => s.owner === "gebaeude" && s.table === "leihgeraete")!.rows).toHaveLength(2);
    expect(loanText(rows)).toContain(DEVICE);
    expect((await planOwnExport(h.db, LEA)).entries.map((e) => e.path)).toContain("Leihgeräte.txt");

    // Löschfrist: die vor über einem Jahr zurückgegebene ist fällig, die offene nicht
    const item = (await planDeletion(h.db, "2026-11-09")).find((i) => i.table === "gebaeude_loans")!;
    expect(item).toMatchObject({ status: "due", count: 1, classId: "LK-ENDE-1J" });

    // Kontolöschung: offene Ausleihe bleibt ohne Person (Gerät bleibt „verliehen“)
    await deleteAccounts(h.db, [LEA]);
    expect(await loanOf(open)).toMatchObject({ userId: null });
    expect((await assetLoans(h.db, klaus, { id: tablet, categoryId: cat("it") }, today)).current).toMatchObject({ borrower: null, userId: null });
    expect(await hasOpenLoan(h.db, tablet)).toBe(true);
  });
});
