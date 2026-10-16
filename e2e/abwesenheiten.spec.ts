import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test("Elternteil meldet Krankheit, Klassenleitung entschuldigt, Mutter sieht den Status", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "daniela.schaefer");
  await page.goto("/abwesenheiten");
  await expect(page.getByRole("heading", { name: "Kind abwesend melden" })).toBeVisible();
  // DS-18: Hinweis nach Art. 13 am Formular
  const note = page.getByRole("group", { name: "Hinweise zum Datenschutz" });
  await note.getByText("Hinweise zum Datenschutz").click();
  await expect(note).toContainText("§ 122 Abs. 1 Satz 2 SchulG NRW");
  await expect(note).toContainText("Atteste und ärztliche Bescheinigungen bitte nicht über den Messenger oder als Datei schicken");
  await expect(note).toContainText("Admin-Konten");
  await page.getByLabel("Schüler:in").selectOption({ label: "Lea Schäfer" });
  await page.getByLabel("krank").check();
  await page.getByRole("button", { name: "Abwesenheit melden" }).click();
  await expect(page.getByRole("status")).toContainText("Klassenleitung ist benachrichtigt");
  await expect(page.locator("section", { has: page.getByRole("heading", { name: "Meine Meldungen" }) })).toContainText("gemeldet");
  await page.screenshot({ path: ".data/shots/e2e/abwesenheit-eltern.png", fullPage: true });

  const ctx = await browser.newContext();
  const jana = await ctx.newPage();
  await login(jana, "jana.brandt");
  await jana.getByRole("button", { name: /Gong/ }).click();
  await expect(jana.getByText("Abwesenheit gemeldet: Lea Schäfer").first()).toBeVisible();
  await jana.goto("/abwesenheiten");
  await jana.getByRole("button", { name: "Entschuldigen: Lea Schäfer", exact: true }).click();
  await expect(jana.getByText("Alles bearbeitet.")).toBeVisible();
  await expect(jana.getByRole("region", { name: "Verlauf" }).or(jana.locator("section", { hasText: "Verlauf" })).first()).toContainText("entschuldigt");
  await jana.screenshot({ path: ".data/shots/e2e/abwesenheit-klassenleitung.png", fullPage: true });
  await ctx.close();

  await page.reload();
  await expect(page.locator("section", { has: page.getByRole("heading", { name: "Meine Meldungen" }) })).toContainText("entschuldigt");
  expect(errors).toEqual([]);
});

test("Q5-13: Schülerin sieht eigene Fehlzeiten, Eltern die ihres Kindes; Klassenleitung entscheidet Fehltage ohne Meldung", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "lea.schaefer");
  await page.goto("/abwesenheiten");
  await expect(page.getByRole("heading", { name: "Meine Fehlzeiten", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fehlstunden und Verspätungen" })).toBeVisible();
  // kein Meldeformular für Schüler:innen
  await expect(page.getByRole("button", { name: "Abwesenheit melden" })).toHaveCount(0);

  const ctx = await browser.newContext();
  const mutter = await ctx.newPage();
  await login(mutter, "daniela.schaefer");
  await mutter.goto("/abwesenheiten");
  await expect(mutter.getByRole("heading", { name: "Fehlzeiten: Lea Schäfer" })).toBeVisible();
  await ctx.close();

  // Seed: eine Schülerin der 7b fehlte am letzten Tag ohne Meldung
  const ctx2 = await browser.newContext();
  const jana = await ctx2.newPage();
  await login(jana, "jana.brandt");
  await jana.goto("/abwesenheiten");
  const section = jana.locator("section", { has: jana.getByRole("heading", { name: /Fehltage ohne Meldung/ }) });
  const items = section.getByRole("listitem");
  const n = await items.count();
  expect(n).toBeGreaterThan(0);
  await section.getByRole("button", { name: /^Fehltag nicht entschuldigen:/ }).first().click();
  await expect(items).toHaveCount(n - 1);
  await jana.screenshot({ path: ".data/shots/e2e/abwesenheit-fehltage.png", fullPage: true });
  await ctx2.close();
  expect(errors).toEqual([]);
});

test("Q5-16: Mutter beantragt eine Beurlaubung, Klassenleitung genehmigt, Schulleitung sieht ihren Bereich", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "daniela.schaefer");
  await page.goto("/abwesenheiten");
  await page.getByRole("link", { name: "Beurlaubung beantragen" }).click();
  await expect(page).toHaveURL(/\/abwesenheiten\/beurlaubung$/);
  await expect(page.getByRole("heading", { name: "Beurlaubung vorab", level: 1 })).toBeVisible();
  const select = page.getByLabel("Schüler:in");
  if (await select.count()) await select.selectOption({ label: "Lea Schäfer" });
  // Gründe nur als Auswahl, ohne Religion/Gesundheit
  await expect(page.getByRole("radio")).toHaveCount(3);
  await page.getByLabel("familiärer Anlass").check();
  await page.getByRole("button", { name: "Beurlaubung beantragen" }).click();
  await expect(page.getByRole("status")).toContainText("Beantragt");
  const antraege = page.locator("section", { has: page.getByRole("heading", { name: "Anträge" }) });
  await expect(antraege).toContainText("Lea Schäfer");
  await expect(antraege).toContainText("entscheidet: Klassenleitung");
  await page.screenshot({ path: ".data/shots/e2e/beurlaubung-eltern.png", fullPage: true });

  const ctx = await browser.newContext();
  const jana = await ctx.newPage();
  await login(jana, "jana.brandt");
  await jana.goto("/abwesenheiten");
  await jana.getByRole("button", { name: "Beurlaubung genehmigen: Lea Schäfer" }).first().click();
  await expect(jana.locator("section", { has: jana.getByRole("heading", { name: /^Beurlaubungen/ }) }).first()).toContainText("genehmigt");
  await ctx.close();

  await page.reload();
  await expect(antraege).toContainText("genehmigt");

  const sl = await browser.newContext();
  const petra = await sl.newPage();
  await login(petra, "petra.lindner");
  await petra.goto("/abwesenheiten");
  await expect(petra.getByRole("heading", { name: /Beurlaubungen \(Schulleitung\)/ })).toBeVisible();
  await sl.close();
  expect(errors).toEqual([]);
});
