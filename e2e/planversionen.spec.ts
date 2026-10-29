import AxeBuilder from "./axe";
import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SP3-01: Planversionen – Bestand 1.0, Entwurf aus dem gültigen Plan ab Stichtag, Variante, Verwerfen; Versionsliste mobil + dunkel.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const NAME = `E2E Halbjahr ${Date.now().toString(36)}`;

test("SP3-01: Versionsliste, Entwurf anlegen, Variante, verwerfen – gültiger Plan bleibt, mobil + dunkel", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung");
  await page.getByRole("navigation", { name: "Stundenplanung" }).getByRole("link", { name: "Versionen" }).click();
  await expect(page.getByRole("heading", { name: "Planversionen", level: 1 })).toBeVisible();

  // der vorhandene Plan ist „Bestand 1.0“ und gültig
  const base = page.getByRole("article", { name: "Version 1.0 Bestand" });
  await expect(base).toBeVisible();
  await expect(base.getByText("gültig", { exact: true })).toBeVisible();
  await expect(base.getByTestId("version-zahlen")).toContainText(/\d+ Wochenstunden/);
  const baseHours = (await base.getByTestId("version-zahlen").textContent())!.match(/^([\d.]+) Wochenstunden/)![1];

  // Entwurf aus dem gültigen Plan (Vorgabe) ab dem vorgeschlagenen Stichtag
  const form = page.getByRole("form", { name: "Entwurf anlegen" });
  await expect(form.getByRole("radio", { name: "Aus dem gültigen Plan" })).toBeChecked();
  await expect(form.getByLabel("Gültig ab (Stichtag)")).not.toHaveValue("");
  await form.getByLabel("Name").fill(NAME);
  await form.getByRole("button", { name: "Entwurf anlegen" }).click();
  await expect(page.getByRole("status").filter({ hasText: `„${NAME}“ angelegt` })).toContainText("Der gültige Plan ist unverändert.");
  const draft = page.getByRole("article", { name: new RegExp(`^Version \\d+\\.0 ${NAME}$`) });
  await expect(draft.getByText("Entwurf", { exact: true })).toBeVisible();
  await expect(draft.getByText(/^vorgemerkt ab \d\d\.\d\d\.\d{4}$/)).toBeVisible();
  await expect(draft.getByText("aus dem gültigen Plan (Version 1.0)")).toBeVisible();
  // gültiger Plan unverändert
  await expect(base.getByText("gültig", { exact: true })).toBeVisible();
  await expect(base.getByTestId("version-zahlen")).toContainText(`${baseHours} Wochenstunden`);

  const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await page.screenshot({ path: ".data/shots/e2e/planversionen.png", fullPage: true });

  // Variante: gleiche Nummer, eigener Name
  await draft.getByRole("button", { name: "Variante anlegen" }).click();
  await expect(page.getByRole("status").filter({ hasText: `„${NAME} – Variante“ angelegt` })).toBeVisible();
  const variant = page.getByRole("article", { name: new RegExp(`^Version \\d+\\.0 ${NAME} – Variante$`) });
  await expect(variant.getByText(/^Variante von Entwurf \d+\.0$/)).toBeVisible();

  // verwerfen (mit Rückfrage): bleibt als „verworfen“ stehen, ohne Knöpfe
  page.once("dialog", (d) => void d.accept());
  await variant.getByRole("button", { name: "Verwerfen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "verworfen." })).toBeVisible();
  await expect(variant.getByText("verworfen", { exact: true })).toBeVisible();
  await expect(variant.getByRole("button")).toHaveCount(0);

  // schmal und dunkel: Liste und Formular ohne axe-Befund, ohne seitliches Scrollen
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: "dark", storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  await p.goto("/planung/versionen");
  await expect(p.getByRole("article", { name: "Version 1.0 Bestand" })).toBeVisible();
  const res = await new AxeBuilder({ page: p }).withTags(TAGS).include("main").analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  const btn = await p.getByRole("button", { name: "Entwurf anlegen" }).boundingBox();
  expect(btn!.x + btn!.width).toBeLessThanOrEqual(360);
  await p.screenshot({ path: ".data/shots/e2e/planversionen-mobil-dunkel.png", fullPage: true });
  await narrow.close();

  // aufräumen: eigenen Entwurf verwerfen
  page.once("dialog", (d) => void d.accept());
  await draft.getByRole("button", { name: "Verwerfen" }).click();
  await expect(draft.getByText("verworfen", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
