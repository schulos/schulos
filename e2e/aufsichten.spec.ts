import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test("Pausenaufsichten: Lehrkraft fehlt → Aufsicht offen, Vertretung übernehmen, Lehrerzimmer-Monitor zeigt sie; Plan pflegen", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung");
  await page.getByRole("navigation", { name: "Verwaltung" }).getByRole("link", { name: "Aufsichten" }).click();
  await expect(page.getByRole("heading", { name: "Pausenaufsichten", level: 1 })).toBeVisible();
  const day = page.getByRole("table", { name: /^Aufsichten am/ });
  const firstRow = day.getByRole("row").nth(1);
  const code = (await firstRow.getByRole("cell").nth(2).textContent())!.trim();

  // Lehrkraft krank melden
  await page.goto("/verwaltung/vertretungen");
  const form = page.getByRole("form", { name: "Abwesenheit eintragen" });
  const option = form.getByLabel("Lehrkraft", { exact: true }).locator("option", { hasText: `${code} – ` });
  await form.getByLabel("Lehrkraft", { exact: true }).selectOption({ label: (await option.textContent())! });
  await form.getByLabel("Grund").selectOption({ label: "krank" });
  await form.getByRole("button", { name: "Abwesenheit eintragen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Abwesenheit eingetragen." })).toBeVisible();

  await page.goto("/verwaltung/aufsichten");
  await expect(page.getByText(/^\d+ offen$/)).toBeVisible();
  const openRow = day.getByRole("row").filter({ hasText: "offen" }).first();
  const sub = (await openRow.getByRole("combobox").locator("option").first().textContent())!.split(" ")[0]!;
  await page.screenshot({ path: ".data/shots/e2e/aufsichten.png", fullPage: true });
  await openRow.getByRole("button", { name: "Übernehmen" }).click();
  await expect(day.getByRole("row").filter({ hasText: "vertreten" }).first()).toContainText(sub);

  // Lehrerzimmer-Monitor
  await page.goto("/monitor/demo-lehrerzimmer-lindenhof-2026");
  await expect(page.getByRole("region", { name: "Pausenaufsichten" })).toContainText(`${sub} für ${code}`);

  // Plan: Aufsicht einteilen und wieder entfernen
  await page.goto("/verwaltung/aufsichten");
  const plan = page.getByRole("form", { name: "Aufsicht einteilen" });
  await plan.getByLabel("Bereich").selectOption({ label: "Mensa" });
  await plan.getByLabel("Tag").selectOption({ label: "Fr" });
  await plan.getByLabel("Pause").selectOption({ index: 1 });
  await plan.getByLabel("Lehrkraft").selectOption({ label: "BRA – Jana Brandt" });
  await plan.getByRole("button", { name: "Einteilen" }).click();
  const remove = page.getByRole("button", { name: /^BRA aus Mensa Fr .* entfernen$/ });
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(remove).toHaveCount(0);

  // aufräumen
  await page.goto("/verwaltung/vertretungen");
  await page.getByRole("button", { name: `Abwesenheit ${code} aufheben` }).click();
  await expect(page.getByText("Für diesen Tag ist keine Abwesenheit eingetragen.")).toBeVisible();
  expect(errors).toEqual([]);
});
