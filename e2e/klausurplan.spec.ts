import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

/** Mittwoch in drei Wochen – frei von den Demo-Arbeiten */
function wednesdayInThreeWeeks(): string {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 21 + 2);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("Lehrkraft trägt eine Klassenarbeit ein; zweite am selben Tag wird abgelehnt", async ({ page }) => {
  const errors = collectErrors(page);
  const date = wednesdayInThreeWeeks();
  await login(page, "jana.brandt");
  await page.goto("/klausurplan");
  await page.getByLabel("Klasse/Kurs").selectOption({ label: "Klasse 7b" });
  await page.getByLabel("Fach").selectOption({ label: "Deutsch" });
  await page.getByLabel("Bezeichnung").fill("2. Klassenarbeit");
  await page.getByLabel("Datum").fill(date);
  await page.getByRole("button", { name: "Arbeit eintragen" }).click();
  await expect(page.getByRole("status")).toContainText("Eingetragen");
  await expect(page.getByRole("listitem").filter({ hasText: "Deutsch · Klasse 7b" })).toContainText("2. Klassenarbeit");

  await page.getByLabel("Klasse/Kurs").selectOption({ label: "Klasse 7b" });
  await page.getByLabel("Fach").selectOption({ label: "Englisch" });
  await page.getByLabel("Bezeichnung").fill("1. Klassenarbeit");
  await page.getByLabel("Datum").fill(date);
  await page.getByRole("button", { name: "Arbeit eintragen" }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText("an diesem Tag schon eine Arbeit: Deutsch (Klasse 7b)");
  await expect(page.getByLabel("Fach")).toHaveValue("E");
  await page.screenshot({ path: ".data/shots/e2e/klausurplan.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("Schülerin sieht die Klassenarbeit im Wochenplan und im Kalender", async ({ page }) => {
  await login(page, "lea.schaefer");
  await page.goto("/klausurplan");
  await expect(page.getByRole("button", { name: "Arbeit eintragen" })).toHaveCount(0);
  const item = page.getByRole("listitem").filter({ hasText: "Mathematik · Klasse 7b" });
  await item.getByRole("link", { name: "Im Stundenplan" }).click();
  await expect(page.getByRole("heading", { name: "Mein Stundenplan" })).toBeVisible();
  await expect(page.getByRole("table").getByText("Klassenarbeit · 2. Klassenarbeit").first()).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/stundenplan-klassenarbeit.png", fullPage: true });
  await page.goto("/kalender?ansicht=agenda");
  await expect(page.getByRole("link", { name: /Klassenarbeit Mathematik \(7b\)/ })).toHaveAttribute("href", "/klausurplan");
});
