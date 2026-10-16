import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

test("P3-06: Schülerin startet ein Thema im Klassenforum, Lehrkraft antwortet, Schülerin bekommt den Gong", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "lea.schaefer");
  await page.goto("/foren");
  await expect(page.getByRole("link", { name: /Kollegium/ })).toHaveCount(0);
  await page.getByRole("link", { name: /^Klasse 7b/ }).click();
  await expect(page.getByRole("heading", { name: "Klasse 7b", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /Fragen zur Lektüre/ })).toBeVisible();

  await page.getByLabel("Titel").fill("Treffpunkt Wandertag");
  await page.getByLabel("Beitrag").fill("Wo treffen wir uns **morgen**?");
  await page.getByRole("button", { name: "Thema starten" }).click();
  await expect(page.getByRole("heading", { name: "Treffpunkt Wandertag", level: 1 })).toBeVisible();
  await expect(page.getByRole("list", { name: "Beiträge" }).locator("strong")).toHaveText("morgen");
  await expect(page.getByRole("button", { name: "Abo beenden" })).toBeVisible();
  const url = page.url();
  expect(errors).toEqual([]);

  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  await page.goto(url);
  await page.getByLabel("Deine Antwort").fill("Am Haupteingang um 8 Uhr.");
  await page.getByRole("button", { name: "Antwort senden" }).click();
  const posts = page.getByRole("list", { name: "Beiträge" }).getByRole("listitem");
  await expect(posts).toHaveCount(2);
  await expect(posts.last()).toContainText("Am Haupteingang um 8 Uhr.");
  await expect(page.getByLabel("Deine Antwort")).toHaveValue("");
  await page.screenshot({ path: ".data/shots/e2e/forum.png", fullPage: true });

  await logoutForSwitch(page);
  await login(page, "lea.schaefer");
  await page.getByRole("button", { name: /^Gong/ }).click();
  await expect(page.getByText("Neue Antwort: Treffpunkt Wandertag")).toBeVisible();
});

test("P3-06: Kollegiumsforum für Lehrkräfte, Forum im Kursraum und in der Suche", async ({ page }) => {
  await login(page, "jana.brandt");
  await page.goto("/foren/kollegium");
  await expect(page.getByRole("link", { name: /Wandertag im Frühjahr/ })).toBeVisible();

  await page.goto("/kurse/g-7b");
  await expect(page.getByRole("heading", { name: "Forum", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Fragen zur Lektüre/ })).toBeVisible();

  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Wohin möchtest du/).fill("Kletterwald");
  await page.getByRole("option", { name: /Wandertag im Frühjahr/ }).click();
  await expect(page).toHaveURL(/\/foren\/thema\/topic-kollegium-wandertag$/);

  await logoutForSwitch(page);
  await login(page, "lea.schaefer");
  const res = await page.goto("/foren/kollegium");
  expect(res?.status()).toBe(404);
});

test("P3-07: Schülerin meldet einen Beitrag, Klassenleitung blendet ihn mit Grund aus und sperrt das Thema", async ({ page }) => {
  await login(page, "lea.schaefer");
  await page.goto("/foren/thema/topic-7b-lektuere");
  const teacherPost = page.getByRole("list", { name: "Beiträge" }).getByRole("listitem").filter({ hasText: "Lesetagebuch" });
  await teacherPost.getByRole("button", { name: "Melden" }).click();
  await teacherPost.getByLabel("Warum meldest du den Beitrag?").fill("Testmeldung");
  await teacherPost.getByRole("button", { name: "Melden" }).click();
  await expect(teacherPost.getByRole("status")).toContainText("die Moderation sieht sich den Beitrag an");
  await expect(page.getByRole("button", { name: "Ausblenden" })).toHaveCount(0);

  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  await page.goto("/foren");
  await page.getByRole("link", { name: /Gemeldete Beiträge \(1\)/ }).click();
  const report = page.getByRole("list", { name: "Offene Meldungen" }).getByRole("listitem");
  await expect(report).toContainText("Grund: Testmeldung");
  await report.getByRole("button", { name: "Ausblenden" }).click();
  await report.getByLabel("Grund (sehen alle)").fill("Veraltet");
  await report.getByRole("button", { name: "Ausblenden" }).click();
  await page.reload();
  await expect(page.getByText("Keine offenen Meldungen")).toBeVisible();

  await page.goto("/foren/thema/topic-7b-lektuere");
  await page.getByRole("button", { name: "Sperren" }).click();
  await expect(page.getByText("Dieses Thema ist gesperrt")).toBeVisible();

  await logoutForSwitch(page);
  await login(page, "lea.schaefer");
  await page.goto("/foren/thema/topic-7b-lektuere");
  await expect(page.getByText("Von der Moderation ausgeblendet: Veraltet")).toBeVisible();
  await expect(page.getByText("Lesetagebuch")).toHaveCount(0);
  await expect(page.getByLabel("Deine Antwort")).toHaveCount(0);
});
