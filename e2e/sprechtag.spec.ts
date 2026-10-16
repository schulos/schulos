import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

test("P4-51: Sekretariat legt einen Sprechtag an, Lehrkraft gibt Zeiten frei und schickt einen Gesprächswunsch", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/sprechtag");
  const form = page.getByRole("form", { name: "Sprechtag anlegen" });
  await form.getByLabel("Titel").fill("Sprechtag E2E-Anlage");
  await form.getByLabel("Pausen").fill("17:30–17:45");
  await form.getByRole("button", { name: "Sprechtag anlegen" }).click();
  await expect(page).toHaveURL(/\/sprechtag\/[\w-]+$/);
  await expect(page.getByRole("heading", { name: "Sprechtag E2E-Anlage" })).toBeVisible();
  await expect(page.getByText(/0 von \d+ Lehrkräften haben Zeiten freigegeben/)).toBeVisible();
  const url = page.url();

  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  await page.goto("/sprechtag");
  await expect(page.getByRole("listitem").filter({ hasText: "Sprechtag E2E-Anlage" })).toContainText("Zeiten noch nicht freigegeben");
  await page.getByRole("link", { name: "Sprechtag E2E-Anlage" }).click();
  await expect(page).toHaveURL(url);
  const zeiten = page.getByRole("form", { name: "Meine Zeiten" });
  await zeiten.getByLabel("18:45").uncheck();
  await zeiten.getByRole("button", { name: "Zeiten freigeben" }).click();
  await expect(zeiten.getByRole("status")).toContainText("Gespeichert");
  await expect(page.getByRole("row", { name: /18:45–18:55 nicht angeboten/ })).toBeVisible();
  const wunsch = page.getByRole("form", { name: "Gesprächswunsch" });
  await wunsch.getByLabel("Schüler:in").selectOption({ label: "Lea Schäfer (7b)" });
  await wunsch.getByRole("button", { name: "Gesprächswunsch schicken" }).click();
  await expect(wunsch.getByRole("status")).toContainText("Verschickt");
  await expect(page.getByRole("listitem").filter({ hasText: "Lea Schäfer" })).toContainText("noch nicht gebucht");
  expect(errors).toEqual([]);
});

/** Sprechtag anlegen (Sekretariat) und Zeiten freigeben (Jana Brandt) – gibt die ID zurück. */
async function eventWithJana(page: import("@playwright/test").Page, title: string, daysAhead: number): Promise<string> {
  await login(page, "sabine.kowalski");
  await page.goto("/sprechtag");
  const form = page.getByRole("form", { name: "Sprechtag anlegen" });
  await form.getByLabel("Titel").fill(title);
  const d = new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
  await form.getByLabel("Datum").fill(d);
  await form.getByLabel("Buchung bis (einschließlich)").fill(d);
  await form.getByRole("button", { name: "Sprechtag anlegen" }).click();
  await expect(page).toHaveURL(/\/sprechtag\/[\w-]+$/);
  const id = page.url().split("/").pop()!;
  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  await page.goto(`/sprechtag/${id}`);
  await page.getByRole("form", { name: "Meine Zeiten" }).getByRole("button", { name: "Zeiten freigeben" }).click();
  await expect(page.getByRole("form", { name: "Meine Zeiten" }).getByRole("status")).toContainText("Gespeichert");
  await logoutForSwitch(page);
  return id;
}

test("P4-52: Mutter bucht einen Termin und sagt ab – die Lehrkraft bekommt einen Gong", async ({ page }) => {
  const errors = collectErrors(page);
  const id = await eventWithJana(page, "Sprechtag E2E-Buchung", 22);
  await login(page, "daniela.schaefer");
  await page.getByRole("link", { name: "Elternsprechtag" }).first().click();
  await page.goto(`/sprechtag/buchen?e=${id}`);
  const lea = page.getByRole("article", { name: "Lehrkräfte von Lea Schäfer" });
  await lea.getByLabel("Zeit bei Jana Brandt").selectOption("16:20");
  await lea.getByRole("button", { name: "Buchen bei Jana Brandt" }).click();
  await expect(page.getByRole("status")).toContainText("Gebucht");
  const meine = page.locator("section", { has: page.getByRole("heading", { name: "Meine Termine" }) });
  await expect(meine).toContainText("16:20–16:30");
  await expect(meine).toContainText("Jana Brandt");
  page.once("dialog", (d) => void d.accept());
  await meine.getByRole("button", { name: "Absagen: Jana Brandt 16:20" }).click();
  await expect(meine).toContainText("Noch keine Termine gebucht");

  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  await page.getByRole("button", { name: /Gong/ }).click();
  await expect(page.getByText(/Termin abgesagt: Lea Schäfer, .*16:20 Uhr/).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("P4-53: Widget „Mein Sprechtag“, Plan drucken, Monitor-Profil „Sprechtag“ ohne Namen der Familien", async ({ page, browser }) => {
  const errors = collectErrors(page);
  const id = await eventWithJana(page, "Sprechtag E2E-Anzeige", 2);
  await login(page, "jana.brandt");
  await expect(page.getByRole("article", { name: "Mein Sprechtag" })).toContainText("Sprechtag E2E-Anzeige");
  await page.goto(`/sprechtag/${id}`);
  await page.getByRole("link", { name: "Meinen Plan drucken" }).click();
  await expect(page.getByRole("heading", { name: "Plan Jana Brandt" })).toBeVisible();
  await logoutForSwitch(page);

  page.on("dialog", (d) => void d.accept());
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/monitore");
  await page.getByLabel("Name", { exact: true }).last().fill("Sprechtag-Foyer");
  await page.getByLabel("Profil").last().selectOption("sprechtag");
  await page.getByRole("button", { name: "Anlegen" }).click();
  const url = await page.getByTestId("monitor-url").textContent();
  const screen = await (await browser.newContext()).newPage();
  const screenErrors = collectErrors(screen);
  await screen.goto(url!);
  await expect(screen.getByRole("heading", { name: "Elternsprechtag", exact: true })).toBeVisible();
  const rooms = screen.getByRole("region", { name: "Räume am Elternsprechtag" });
  await expect(rooms).toContainText("Sprechtag E2E-Anzeige");
  await expect(rooms).toContainText("Jana Brandt");
  await expect(rooms).not.toContainText("Schäfer");
  expect([...errors, ...screenErrors]).toEqual([]);
});

test("P4-54: Eltern buchen zwei Termine hintereinander, Lehrkraft sieht den Plan, Absage → Gong an die Eltern", async ({ page }) => {
  const errors = collectErrors(page);
  const id = await eventWithJana(page, "Sprechtag E2E-Hintereinander", 24);
  // zweite Lehrkraft der 7b: bietet 16:00 und 16:10 nicht an
  await login(page, "tobias.kleine");
  await page.goto(`/sprechtag/${id}`);
  const zeiten = page.getByRole("form", { name: "Meine Zeiten" });
  await zeiten.getByLabel("16:00").uncheck();
  await zeiten.getByLabel("16:10").uncheck();
  await zeiten.getByRole("button", { name: "Zeiten freigeben" }).click();
  await expect(zeiten.getByRole("status")).toContainText("Gespeichert");
  await logoutForSwitch(page);

  await login(page, "daniela.schaefer");
  await page.goto(`/sprechtag/buchen?e=${id}`);
  const wunsch = page.getByRole("form", { name: "Vorschlag berechnen" });
  await wunsch.getByLabel("Jana Brandt (Lea)", { exact: true }).check();
  await wunsch.getByLabel("Tobias Kleine (Lea)", { exact: true }).check();
  await wunsch.getByRole("button", { name: "Vorschlag berechnen" }).click();
  const vorschlag = page.getByRole("region", { name: "Vorschlag" });
  await expect(vorschlag).toContainText("16:10–16:20 Jana Brandt");
  await expect(vorschlag).toContainText("16:20–16:30 Tobias Kleine");
  await vorschlag.getByRole("button", { name: "Alle 2 Termine buchen" }).click();
  await expect(page.getByRole("status")).toContainText("Gebucht");
  const meine = page.locator("section", { has: page.getByRole("heading", { name: "Meine Termine" }) });
  await expect(meine.getByRole("listitem")).toHaveCount(2);
  await page.screenshot({ path: ".data/shots/e2e/sprechtag-buchen.png", fullPage: true });
  await logoutForSwitch(page);

  await login(page, "jana.brandt");
  await page.goto(`/sprechtag/${id}`);
  const row = page.getByRole("row", { name: /16:10–16:20 Lea Schäfer 7b Daniela Schäfer/ });
  await expect(row).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/sprechtag-lehrkraft.png", fullPage: true });
  page.once("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: "Absagen: Lea Schäfer 16:10" }).click();
  await expect(page.getByRole("row", { name: /16:10–16:20 frei/ })).toBeVisible();
  await logoutForSwitch(page);

  await login(page, "daniela.schaefer");
  await page.getByRole("button", { name: /Gong/ }).click();
  await expect(page.getByText(/Termin abgesagt: Jana Brandt, .*16:10 Uhr/).first()).toBeVisible();
  await page.goto(`/sprechtag/buchen?e=${id}`);
  await expect(page.locator("section", { has: page.getByRole("heading", { name: "Meine Termine" }) }).getByRole("listitem")).toHaveCount(1);
  expect(errors).toEqual([]);
});
