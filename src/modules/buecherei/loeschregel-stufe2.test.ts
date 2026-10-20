// Löschregel Stufe 2 (BU-11, docs/BUECHEREI.md „Stufe 2 – Festlegungen“ 4) – Gegenstück zu `gate-bu1.test.ts`: Querschnitt über
// alle Bücherei-Tabellen. Nach Ausgabe, Mahnung (mit Eltern und Mail) und Rücknahme ohne Befund hängt an keiner Bücherei-Zeile
// mehr die Person (außer dem Ausweis), der Zustand steht am Exemplar ohne Person, das Audit-Log nennt sie nicht, Gong und Mail
// nennen keinen Titel. Rücknahme mit Befund bleibt bis zur Erledigung und geht dann mit LK-SJ-1J; nicht Zurückgegebenes bleibt
// über das Schuljahresende als offener Posten (kein Löschlauf) und verliert mit der Kontolöschung die Person.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { DbHandle } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { auditLog, buechereiMaterialCopies, buechereiMaterialIssues, mailOutbox, notifications, schoolYears, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { loadPermissions } from "@/core/permissions";
import { planDeletion, runDeletion } from "@/core/privacy/loeschlauf";
import { addDays } from "@/core/time";
import { issueCopy, resolveIssueFinding, runSchoolbookDunning, takeBack } from "./ausgabe";
import { ensureCards } from "./cards";
import { dueDate } from "./dates";
import { createMaterial } from "./lernmittel";
import { DUNNING_MAIL } from "./settings";

const SABINE = "u-sabine.kowalski"; // Verwaltung: `buecherei.materials`
const LEA = "u-lea.schaefer"; // Schülerin 7b (minderjährig)
const MUTTER = "u-daniela.schaefer"; // Elternteil von Lea
const TITLE = "Löschprobe Geheimes Rechenbuch";

describe("Löschregel Stufe 2 – Schulbuch-Zuordnung nur im laufenden Schuljahr", () => {
  let h: DbHandle;
  let numbers: string[];
  let day: string;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    day = await dueDate(h.db, "2026-11-09", 0);
    ({ numbers } = await createMaterial(h.db, await p(SABINE), { title: TITLE, grades: [7], provision: "leihe" }, { count: 3 }));
  });
  afterAll(async () => {
    await h.close();
  });

  async function allLibraryRows(): Promise<Map<string, string[]>> {
    const tables = rowsOf<{ name: string }>(await h.db.execute(sql`select tablename as name from pg_tables where schemaname = 'public' and tablename like 'buecherei\_%' order by tablename`));
    const out = new Map<string, string[]>();
    for (const { name } of tables)
      out.set(
        name,
        rowsOf<{ j: string }>(await h.db.execute(sql`select row_to_json(t)::text as j from ${sql.identifier(name)} t`)).map((r) => r.j),
      );
    return out;
  }

  it("die Zuordnung hat genau eine Personenspalte und hängt am Schuljahr", () => {
    const cfg = getTableConfig(buechereiMaterialIssues);
    expect(cfg.columns.map((c) => c.name).filter((n) => /user|person|student|parent|name$/.test(n))).toEqual(["user_id"]);
    expect(cfg.columns.find((c) => c.name === "school_year_id")!.notNull).toBe(true);
    expect(cfg.foreignKeys.map((fk) => getTableConfig(fk.reference().foreignTable).name).sort()).toEqual(["buecherei_material_copies", "school_years", "users"]);
  });

  it("nach Ausgabe, Mahnung und Rücknahme ohne Befund nennt keine Bücherei-Zeile die Person; Gong und Mail ohne Titel", async () => {
    const s = await p(SABINE);
    await h.db.update(users).set({ email: "lea@example.org", emailVerified: true }).where(eq(users.id, LEA));
    await h.db.update(users).set({ email: "mutter@example.org", emailVerified: true }).where(eq(users.id, MUTTER));
    await writeModuleSetting(h.db, DUNNING_MAIL, "1");
    await ensureCards(h.db, s, [LEA]);

    await issueCopy(h.db, s, LEA, numbers[0]!, addDays(day, -60));
    await h.db.update(buechereiMaterialIssues).set({ dueOn: addDays(day, -1) }).where(eq(buechereiMaterialIssues.userId, LEA));
    expect(await runSchoolbookDunning(h.db, day, { mail: true, school: "Testschule" })).toEqual({ dunned: 1, parents: 1 });
    await takeBack(h.db, s, numbers[0]!, day, { condition: "gebraucht", conditionNote: "Eselsohren" });

    const rows = await allLibraryRows();
    expect([...rows.keys()]).toContain("buecherei_material_issues");
    for (const [table, list] of rows) {
      if (table === "buecherei_cards") continue; // Ausweis gehört zum Konto (LK-KONTO), siehe gate-bu1.test.ts
      for (const j of list) expect(j, table).not.toContain(LEA);
    }
    const [copy] = await h.db.select().from(buechereiMaterialCopies).where(eq(buechereiMaterialCopies.inventoryNumber, numbers[0]!));
    expect(copy).toMatchObject({ condition: "gebraucht", conditionNote: "Eselsohren" });
    const audits = await h.db.select({ target: auditLog.target, meta: auditLog.meta }).from(auditLog).where(like(auditLog.action, "buecherei.%"));
    for (const a of audits) expect(JSON.stringify(a)).not.toContain(LEA);

    const gongs = await h.db.select().from(notifications).where(eq(notifications.moduleId, "buecherei"));
    expect(gongs.some((g) => g.userId === MUTTER)).toBe(true);
    for (const g of gongs) expect(`${g.title} ${g.body}`).not.toContain(TITLE);
    for (const m of await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "buecherei-schulbuch"))) expect(`${m.subject} ${m.text}`).not.toContain(TITLE);
  });

  it("Rücknahme mit Befund: bleibt bis zur Erledigung, danach Löschung nach Schuljahresende + 1 Jahr", async () => {
    const s = await p(SABINE);
    await issueCopy(h.db, s, LEA, numbers[1]!, day);
    await takeBack(h.db, s, numbers[1]!, day, { finding: "Einband abgerissen" });
    const item = async (today: string) => (await planDeletion(h.db, today)).find((x) => x.table === "buecherei_material_issues" && x.scope === "Schulbuch-Rücknahmen mit Befund")!;
    expect((await item("2028-09-01")).count).toBe(0); // unerledigt → bleibt
    const [row] = await h.db.select().from(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.userId, LEA));
    await resolveIssueFinding(h.db, s, row!.id, day);
    expect((await item("2027-09-01")).count).toBe(0); // Schuljahr 2026/27 erst seit einem Monat vorbei
    expect((await item("2028-09-01")).count).toBe(1);
  });

  it("nicht zurückgegeben: offener Posten über das Schuljahresende, kein Löschlauf; Kontolöschung entfernt die Person", async () => {
    const s = await p(SABINE);
    const KIND = "u-fremd-bu11";
    await h.db.insert(users).values({ id: KIND, username: "bu11.probe", name: "Probe Kind", firstName: "Probe", lastName: "Kind", role: "schueler", email: "bu11.probe@example.org" });
    await issueCopy(h.db, s, KIND, numbers[2]!, day);
    const [y] = await h.db.select({ endsOn: schoolYears.endsOn }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
    const plan = (await planDeletion(h.db, "2028-09-01")).find((x) => x.table === "buecherei_material_issues" && x.scope === "offene Schulbuch-Ausgaben")!;
    expect(plan.status).toBe("skipped"); // geht mit dem Konto (LK-KONTO), nicht mit dem Schuljahr
    await runDeletion(h.db, null, "2028-09-01");
    const [open] = await h.db.select().from(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.userId, KIND));
    expect(open).toMatchObject({ dueOn: y!.endsOn, returnedOn: null });
    // der Befund von oben ist mit dem Löschlauf weg
    expect(await h.db.select().from(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.userId, LEA))).toEqual([]);

    await h.db.delete(users).where(eq(users.id, KIND));
    const [after] = await h.db.select().from(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.id, open!.id));
    expect(after).toMatchObject({ userId: null, returnedOn: null });
  });
});
