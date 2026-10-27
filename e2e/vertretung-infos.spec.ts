import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// VT-01: Vertretungsformular mit Grund-Kategorie (öffentlich), interner Notiz (nur Planung) und Tagesmitteilung. Der Monitor zeigt
// den Hinweis für Schüler:innen, nie die interne Notiz. Räumt am Ende auf (Klasse 10a, nächster Schultag), damit spätere Specs
// denselben Tag unverändert vorfinden.
test("Vertretung mit Grund und interner Notiz, Tagesmitteilung; Monitor ohne interne Notiz", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const NOTE = "VT01-E2E Hinweis";
  const SECRET = "VT01-E2E intern";
  const DAY_NOTE = "VT01-E2E Tagesmitteilung";
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/vertretungen?gruppe=g-10a");
  const form = page.getByRole("form", { name: /^\d+\. Std · .+ · Klasse 10a$/ }).first();
  await expect(form).toBeVisible();
  const label = (await form.getAttribute("aria-label"))!;
  await form.getByLabel("Art").selectOption("cancel");
  await form.getByLabel("Grund (öffentlich)").selectOption({ label: "Veranstaltung" });
  await form.getByLabel("Hinweis für Schüler:innen").fill(NOTE);
  await form.getByLabel("Interne Notiz (nur Planung und Vertretung)").fill(SECRET);
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Gespeichert");

  await page.reload();
  const again = page.getByRole("form", { name: label });
  await expect(again.getByLabel("Grund (öffentlich)")).toHaveValue("veranstaltung");
  await expect(again.getByLabel("Interne Notiz (nur Planung und Vertretung)")).toHaveValue(SECRET);
  const day = page.getByRole("region", { name: /^Alle Änderungen am/ });
  const row = day.getByRole("row").filter({ hasText: NOTE });
  await expect(row).toContainText("Veranstaltung");
  await expect(row).toContainText(`intern: ${SECRET}`);

  // Tagesmitteilung
  const notes = page.getByRole("region", { name: /^Tagesmitteilungen am/ });
  await notes.getByRole("textbox", { name: "Mitteilung" }).fill(DAY_NOTE);
  await notes.getByRole("button", { name: "Hinzufügen" }).click();
  await expect(notes.getByText(DAY_NOTE)).toBeVisible();

  // Entwurf veröffentlichen (Demo-Schule: Freigabe), dann Monitor: Hinweis ja, interne Notiz nie
  const publish = page.getByRole("button", { name: "Tag veröffentlichen" });
  if (await publish.count()) {
    await publish.click();
    await expect(page.getByRole("status").filter({ hasText: "Veröffentlicht" })).toBeVisible();
  }
  const mctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const monitor = await mctx.newPage();
  await monitor.goto("/monitor/demo-foyer-lindenhof-2026");
  await expect(monitor.getByText(NOTE).first()).toBeVisible();
  await expect(monitor.getByText(SECRET)).toHaveCount(0);
  await mctx.close();

  // aufräumen
  await notes.getByRole("button", { name: `Tagesmitteilung löschen: ${DAY_NOTE}` }).click();
  await expect(notes.getByText(DAY_NOTE)).toHaveCount(0);
  await day.getByRole("row").filter({ hasText: NOTE }).getByRole("button", { name: /^Aufheben:/ }).click();
  await expect(day.getByText(NOTE)).toHaveCount(0);
  expect(errors).toEqual([]);
});
