import { expect, test } from "@playwright/test";
import { collectErrors, login, sendPlannedNow } from "./helpers";

// Q5-11 (I-25, F-06): Die Demo-Schule veröffentlicht den Vertretungsplan erst nach Freigabe. Ein Tag des Vertretungsplans
// ohne Änderungen wird mit der ersten Änderung zum Entwurf: Monitor und Schülerin sehen ihn nicht, nach „Tag veröffentlichen“
// schon. (Datei läuft vor gate2/gate2b – dort kommen Änderungen auf diese Tage.) Gongs je Person prüft freigabe.test.ts.
test("Vertretungsplan mit Freigabe: Monitor und Schülerin sehen keinen Entwurf, nach dem Veröffentlichen schon", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const NOTE = "Freigabe-Test E2E";
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/vertretungen");
  const days = page.getByRole("navigation", { name: "Tage im Vertretungsplan" });
  await days.getByRole("link").filter({ hasText: "keine Änderungen" }).first().click();
  await expect(page).toHaveURL(/datum=\d{4}-\d{2}-\d{2}/);
  await expect(page.getByLabel("Freigabe")).toContainText("legt einen Entwurf an");
  await page.getByLabel("oder Klasse/Kurs").selectOption({ label: "Klasse 7b" });
  await page.getByRole("button", { name: "Anzeigen" }).click();
  const form = page.getByRole("form", { name: /^\d+\. Std · / }).first();
  await form.getByRole("radio", { name: "Entfall" }).check();
  await form.getByLabel("Hinweis").fill(NOTE);
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Gespeichert");
  await page.reload();
  const draft = page.getByRole("article", { name: "Entwurf" });
  await expect(draft).toContainText("noch nicht veröffentlicht");
  await expect(days.getByText("Entwurf")).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/vertretungsplan-entwurf.png", fullPage: true });

  // Monitor (ohne Anmeldung) und Schülerin: kein Entwurf
  const mctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const monitor = await mctx.newPage();
  await monitor.goto("/monitor/demo-foyer-lindenhof-2026");
  await expect(monitor.getByRole("heading", { name: "Vertretungsplan" })).toBeVisible();
  await expect(monitor.getByText(NOTE)).toHaveCount(0);
  const lctx = await browser.newContext();
  const lea = await lctx.newPage();
  const leaErrors = collectErrors(lea);
  await login(lea, "lea.schaefer");
  await lea.goto("/stundenplan/vertretungen");
  await expect(lea.getByRole("heading", { name: "Vertretungsplan", level: 1 })).toBeVisible();
  await expect(lea.getByText(NOTE)).toHaveCount(0);

  // Veröffentlichen → alle sehen die Änderung, die Schülerin bekommt den Gong
  await draft.getByRole("button", { name: "Tag veröffentlichen" }).click();
  // VT-04: die Nachricht ist eingeplant (Vortag 18:00 bzw. heute sofort) – für den Test jetzt senden
  await expect(page.getByRole("status").filter({ hasText: "Veröffentlicht" })).toContainText("eingeplant");
  await sendPlannedNow(page);
  await expect(page.getByRole("article", { name: "Entwurf" })).toHaveCount(0);
  await monitor.reload();
  await expect(monitor.getByText(NOTE).first()).toBeVisible();
  await lea.reload();
  await expect(lea.getByText(NOTE).first()).toBeVisible();
  await lea.getByRole("button", { name: /Gong/ }).click();
  await expect(lea.getByText(/Entfall/).first()).toBeVisible();
  expect([...errors, ...leaErrors]).toEqual([]);
  await mctx.close();
  await lctx.close();
});
