// GT-11/GT-12: Speiseplan je Woche, An-/Abmeldung je Tag mit Menüwahl bis zur Frist, Zählung (CSV) und Ausgabeliste ohne
// Gesundheitsbezug. Feste Daten (`now` wird übergeben).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { ganztagMealOrders, parentChild, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { deleteAccounts } from "@/core/privacy/konto";
import { ValidationError } from "@/modules/verwaltung/users";
import { familyMeals, kitchenCsvRows, mealDeadline, mealOpen, servingList, setDayMenus, setMealOrder, weekPlan } from "./essen";
import { MEAL_DEADLINE } from "./settings";

const SEKRETARIAT = "u-sabine.kowalski";
const SCHULLEITUNG = "u-petra.lindner";
const LEHRKRAFT = "u-jana.brandt";
const DAY = "2027-03-11"; // Donnerstag
const BEFORE = new Date("2027-03-09T10:00:00Z"); // Di 11:00 Berlin
const EVE_NOON = new Date("2027-03-10T11:30:00Z"); // Mi 12:30 Berlin – nach dem Anmeldeschluss (Vortag 12:00)

describe("Mittagessen (rein)", () => {
  it("Frist: Vorgabe Vortag 12:00, auch am Tag selbst einstellbar", () => {
    expect(mealDeadline(DAY, "vortag-12")).toEqual({ date: "2027-03-10", time: "12:00" });
    expect(mealOpen(DAY, BEFORE, "vortag-12")).toBe(true);
    expect(mealOpen(DAY, EVE_NOON, "vortag-12")).toBe(false);
    expect(mealOpen(DAY, EVE_NOON, "tag-09")).toBe(true);
    expect(mealOpen(DAY, new Date("2027-03-11T08:30:00Z"), "tag-09")).toBe(false);
    expect(mealDeadline(DAY, "zwei-12")).toEqual({ date: "2027-03-09", time: "12:00" });
    // Montag: Werktag davor ist der Freitag
    expect(mealDeadline("2027-03-08", "vortag-12")).toEqual({ date: "2027-03-05", time: "12:00" });
    expect(mealDeadline("2027-03-09", "zwei-12")).toEqual({ date: "2027-03-05", time: "12:00" });
  });
});

describe("Ganztag GT-11/GT-12 Mittagessen (DB)", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let kid = "";
  let parent = "";
  let kid2 = "";

  beforeAll(async () => {
    h = await createSeededTestDb();
    const links = await h.db
      .select({ parentId: parentChild.parentId, childId: parentChild.childId })
      .from(parentChild)
      .innerJoin(users, eq(users.id, parentChild.childId))
      .where(eq(users.selfResponsible, false))
      .orderBy(parentChild.childId);
    kid = links[0]!.childId;
    parent = links[0]!.parentId;
    kid2 = links.find((l) => l.childId !== kid)!.childId;
  }, 60_000);
  afterAll(async () => h?.close());

  it("Speiseplan nur „Ganztag verwalten“, nur Mo–Fr, höchstens 80 Zeichen", async () => {
    await expect(setDayMenus(h.db, await p(LEHRKRAFT), DAY, ["Nudeln"])).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setDayMenus(h.db, await p(SEKRETARIAT), "2027-03-13", ["Nudeln"])).rejects.toBeInstanceOf(ValidationError);
    await expect(setDayMenus(h.db, await p(SEKRETARIAT), DAY, ["x".repeat(81)])).rejects.toBeInstanceOf(ValidationError);
    expect(await setDayMenus(h.db, await p(SEKRETARIAT), DAY, ["Nudeln mit Tomatensoße", "  Gemüsecurry  mit Reis ", "", ""])).toBe(2);
    const plan = await weekPlan(h.db, await p(SEKRETARIAT), DAY);
    expect(plan.monday).toBe("2027-03-08");
    expect(plan.days.find((d) => d.date === DAY)!.menus).toEqual([
      { number: 1, title: "Nudeln mit Tomatensoße" },
      { number: 2, title: "Gemüsecurry mit Reis" },
    ]);
    await expect(weekPlan(h.db, await p(LEHRKRAFT), DAY)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Familie meldet bis zur Frist an/ab, Kind (minderjährig) nicht selbst; danach nur die Verwaltung", async () => {
    await expect(setMealOrder(h.db, await p(kid), kid, DAY, 1, BEFORE)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setMealOrder(h.db, await p(parent), kid2 === kid ? kid : kid2, DAY, 1, BEFORE)).rejects.toThrow();
    await expect(setMealOrder(h.db, await p(parent), kid, DAY, 3, BEFORE)).rejects.toBeInstanceOf(ValidationError); // kein Menü 3
    await expect(setMealOrder(h.db, await p(parent), kid, "2027-03-12", 1, BEFORE)).rejects.toBeInstanceOf(ValidationError); // kein Plan
    await setMealOrder(h.db, await p(parent), kid, DAY, 1, BEFORE);
    await setMealOrder(h.db, await p(parent), kid, DAY, 2, BEFORE);
    const fam = (await familyMeals(h.db, await p(parent), BEFORE)).find((c) => c.id === kid)!;
    expect(fam.mayAct).toBe(true);
    expect(fam.days.find((d) => d.date === DAY)).toMatchObject({ ordered: 2, open: true });
    // das Kind sieht seine Anmeldung, ändert aber nicht
    const self = await familyMeals(h.db, await p(kid), BEFORE);
    expect(self[0]).toMatchObject({ id: kid, mayAct: false });
    // nach dem Anmeldeschluss nicht mehr durch die Familie
    await expect(setMealOrder(h.db, await p(parent), kid, DAY, null, EVE_NOON)).rejects.toBeInstanceOf(ValidationError);
    await writeModuleSetting(h.db, MEAL_DEADLINE, "tag-09");
    await setMealOrder(h.db, await p(parent), kid, DAY, 1, EVE_NOON);
    await writeModuleSetting(h.db, MEAL_DEADLINE, "vortag-12");
    // Verwaltung meldet nachträglich an
    await setMealOrder(h.db, await p(SEKRETARIAT), kid2, DAY, 2, EVE_NOON);
    // Menü mit Anmeldungen lässt sich nicht entfernen
    await expect(setDayMenus(h.db, await p(SEKRETARIAT), DAY, ["Nudeln mit Tomatensoße"])).rejects.toBeInstanceOf(ValidationError);
  });

  it("Küche: Zählung je Tag und Menü ohne Namen (CSV), Ausgabeliste nur „Ganztag verwalten“", async () => {
    const csv = await kitchenCsvRows(h.db, await p(SCHULLEITUNG), "2027-03-08", "2027-03-12");
    expect(csv).toEqual([
      ["Datum", "Menü", "Beschreibung", "Anmeldungen"],
      [DAY, "1", "Nudeln mit Tomatensoße", "1"],
      [DAY, "2", "Gemüsecurry mit Reis", "1"],
    ]);
    const text = JSON.stringify(csv);
    for (const id of [kid, kid2]) {
      const [u] = await h.db.select({ name: users.name }).from(users).where(eq(users.id, id));
      expect(text).not.toContain(u!.name);
    }
    await expect(kitchenCsvRows(h.db, await p(LEHRKRAFT), "2027-03-08", "2027-03-12")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(servingList(h.db, await p(SCHULLEITUNG), DAY)).rejects.toBeInstanceOf(ForbiddenError);
    const list = await servingList(h.db, await p(SEKRETARIAT), DAY);
    expect(list.rows.map((r) => r.menu)).toEqual([1, 2]);
    expect(Object.keys(list.rows[0]!).sort()).toEqual(["className", "menu", "name"]);
  });

  it("Anmeldungen gehen mit dem Konto der Schüler:in", async () => {
    await deleteAccounts(h.db, [kid2]);
    expect(await h.db.select().from(ganztagMealOrders).where(eq(ganztagMealOrders.studentId, kid2))).toHaveLength(0);
  });
});
