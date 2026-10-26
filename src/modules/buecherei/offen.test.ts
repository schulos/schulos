// BU-13: offene Bücherei-Posten für Schuljahreswechsel (Prüfschritt „offene Schulbücher“) und Abgang (Hinweis) – nur Zahlen,
// abhängig von Modul und Schulbuchausleihe; der Abgang selbst wird nicht blockiert.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { buechereiMaterialIssues, schoolYears, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { setModuleEnabled } from "@/core/modules/registry";
import { writeModuleSetting } from "@/core/modules/settings";
import { loadPermissions } from "@/core/permissions";
import { setAccountLeft } from "@/core/privacy/konto";
import { issueCopy } from "./ausgabe";
import { checkout } from "./loans";
import { dueDate } from "./dates";
import { createCompensation } from "./ersatz";
import { createMaterial } from "./lernmittel";
import buecherei from "./manifest";
import { noOpenItems, openItemsOf, openItemsText, yearEndCheck } from "./offen";
import { createTitle } from "./service";
import { LERNMITTEL } from "./settings";

const SABINE = "u-sabine.kowalski";
const LEA = "u-lea.schaefer";
const JANA = "u-jana.brandt";

describe("BU-13 – offene Posten", () => {
  let h: DbHandle;
  let yearId: string;
  let day: string;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    day = await dueDate(h.db, "2026-11-09", 0);
    const [y] = await h.db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
    yearId = y!.id;
  });
  afterAll(async () => {
    await h.close();
  });

  it("Text nur mit vorhandenen Teilen", () => {
    expect(openItemsText({ loans: 2, schoolbooks: 1, compensations: 1 })).toBe("2 Ausleihen, 1 Schulbuch, 1 offene Ersatzforderung");
    expect(openItemsText({ loans: 0, schoolbooks: 3, compensations: 0 })).toBe("3 Schulbücher");
    expect(noOpenItems({ loans: 0, schoolbooks: 0, compensations: 0 })).toBe(true);
  });

  it("Schuljahreswechsel: Schulbücher des Jahres, Personen, Abgänger:innen, offene Forderungen (Demo: 5a)", async () => {
    const s = await p(SABINE);
    const demo = await yearEndCheck(h.db, yearId, []);
    expect(demo).toEqual({ schoolbooks: 11, people: 3, leavers: 0, compensations: 1 });
    const { numbers } = await createMaterial(h.db, s, { title: "Offen-Probe 7", grades: [7], provision: "leihe" }, { count: 1 });
    await issueCopy(h.db, s, LEA, numbers[0]!, day);
    expect(await yearEndCheck(h.db, yearId, [LEA])).toEqual({ schoolbooks: 12, people: 4, leavers: 1, compensations: 1 });
    // ein anderes Schuljahr hat nichts offen
    const [other] = await h.db.insert(schoolYears).values({ name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" }).returning({ id: schoolYears.id });
    expect((await yearEndCheck(h.db, other!.id, [LEA]))!.schoolbooks).toBe(0);
  });

  it("Abgang: Zahlen je Person, Abgang bleibt möglich; Schulbuchausleihe aus → nur Ausleihen; Modul aus → nichts", async () => {
    const s = await p(SABINE);
    const { barcodes } = await createTitle(h.db, s, { title: "Offen-Probe Roman", mediaType: "buch" }, { count: 1 });
    await checkout(h.db, s, LEA, barcodes[0]!, day);
    const [issue] = await h.db.select().from(buechereiMaterialIssues).where(eq(buechereiMaterialIssues.userId, LEA));
    await h.db.update(buechereiMaterialIssues).set({ dueOn: "2026-10-01" }).where(eq(buechereiMaterialIssues.id, issue!.id));
    await createCompensation(h.db, s, { issueId: issue!.id }, { amount: "5" }, day); // Verlust → Ausgabe abgeschlossen
    const lea = (await openItemsOf(h.db, [LEA, JANA])).get(LEA)!;
    expect(lea).toEqual({ loans: 1, schoolbooks: 0, compensations: 1 });
    expect((await openItemsOf(h.db, [LEA, JANA])).get(JANA)).toBeUndefined();

    await setAccountLeft(h.db, SABINE, LEA, day);
    expect((await h.db.select({ s: users.status }).from(users).where(eq(users.id, LEA)))[0]!.s).toBe("locked");

    await writeModuleSetting(h.db, LERNMITTEL, "0");
    expect((await openItemsOf(h.db, [LEA])).get(LEA)).toEqual({ loans: 1, schoolbooks: 0, compensations: 1 });
    expect(await yearEndCheck(h.db, yearId, [])).toBeNull();
    await writeModuleSetting(h.db, LERNMITTEL, "1");
    await setModuleEnabled(h.db, buecherei, false);
    expect((await openItemsOf(h.db, [LEA])).size).toBe(0);
    expect(await yearEndCheck(h.db, yearId, [])).toBeNull();
  });
});
