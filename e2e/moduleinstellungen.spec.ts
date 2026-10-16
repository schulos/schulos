import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { collectErrors, login } from "./helpers";

const SETTING = "Direktchats unter Schüler:innen";

async function setStudentDirect(page: Page, label: string) {
  await page.goto("/verwaltung/rechte");
  const select = page.getByLabel(SETTING);
  await select.selectOption({ label });
  await expect(select).toHaveValue(label === "aus" ? "aus" : label.startsWith("nur") ? "klasse" : "gruppen");
  await page.reload();
  await expect(page.getByLabel(SETTING)).toHaveValue(label === "aus" ? "aus" : label.startsWith("nur") ? "klasse" : "gruppen");
}

test("Moduleinstellungen: Direktchats unter Schüler:innen ausschalten (Q5-14)", async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  const lea = await (await browser.newContext()).newPage();
  const errors = collectErrors(admin);
  await login(admin, "admin");
  await login(lea, "lea.schaefer");

  // Klassenkamerad:in aus dem Adressbuch
  await lea.goto("/adressbuch/gruppe/g-7b");
  const mate = (await lea.getByRole("link", { name: /Schüler:in/ }).filter({ hasNotText: "Lea Schäfer" }).first().locator("span.font-medium").textContent())!;

  /** Suche im Dialog „Neuer Chat“ – wartet auf die Antwort der Server Action (Ergebnis kommt verzögert). */
  const search = async () => {
    await lea.goto("/messenger");
    await lea.getByRole("button", { name: "Neuer Chat" }).click();
    const answered = lea.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/messenger"));
    await lea.getByLabel("Person suchen").fill(mate);
    await answered;
  };

  // Vorgabe „nur innerhalb der eigenen Klasse“: Klassenkamerad:in ist auffindbar
  await admin.goto("/verwaltung/rechte");
  await expect(admin.getByLabel(SETTING)).toHaveValue("klasse");
  await expect(admin.getByRole("region", { name: "Einstellungen Klassenbuch" }).getByLabel("Hausaufgaben für Eltern sichtbar")).toHaveValue("0");
  await search();
  await expect(lea.getByRole("button", { name: new RegExp(mate) })).toBeVisible();

  // ausgeschaltet → nicht mehr auffindbar
  await setStudentDirect(admin, "aus");
  await admin.screenshot({ path: ".data/shots/e2e/moduleinstellungen.png", fullPage: true });
  await search();
  await expect(lea.getByRole("button", { name: new RegExp(mate) })).toHaveCount(0);
  await expect(lea.getByText("Niemand gefunden.")).toBeVisible();

  // zurück auf die Vorgabe (gemeinsame E2E-Datenbank)
  await setStudentDirect(admin, "nur innerhalb der eigenen Klasse");
  expect(errors).toEqual([]);
  await admin.context().close();
  await lea.context().close();
});
