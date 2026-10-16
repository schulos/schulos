import { expect, test } from "@playwright/test";
import { createOpenVerfahren, fillAnmeldung, linkFromDevMail } from "./anmeldung-helpers";
import { collectErrors, login, logoutForSwitch } from "./helpers";

test("P4-36: Sekretariat bearbeitet einen Antrag – Liste, Unterlagen, Notiz, Termin, Druck", async ({ page }) => {
  const id = await createOpenVerfahren(page, "E2E Sekretariat Klasse 5", "2030-03-07");
  await fillAnmeldung(page, id, { first: "Greta", last: "Ölmann", email: "greta.e2e@example.org", time: "14:00–14:30" }, { ip: "198.51.100.30" });
  const confirmPath = await linkFromDevMail(page, "greta.e2e@example.org", "/anmeldung/bestaetigen/");
  await page.goto(confirmPath);
  await page.getByRole("button", { name: "Anmeldung bestätigen" }).click();
  await expect(page).toHaveURL(/\/anmeldung\/vorgang\//);
  await logoutForSwitch(page);

  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  // Widget auf Heute
  const widget = page.getByRole("article", { name: "Neue Anmeldungen" });
  await expect(widget).toContainText("E2E Sekretariat Klasse 5");
  await widget.getByRole("link", { name: /E2E Sekretariat Klasse 5/ }).click();
  await expect(page).toHaveURL(`/verwaltung/anmeldung/${id}/antraege`);

  // Suche und Filter
  const filter = page.getByRole("form", { name: "Filter" });
  await filter.getByLabel("Suche").fill("ölmann");
  await filter.getByRole("button", { name: "Anzeigen" }).click();
  await expect(page.getByTestId("antraege-summe")).toHaveText("1 Antrag");
  await page.getByRole("link", { name: "Ölmann, Greta" }).click();
  await expect(page.getByRole("heading", { name: "Ölmann, Greta" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Angaben" })).toContainText("greta.e2e@example.org");

  // Unterlagen vorgelegt → vollständig
  const docs = page.getByRole("form", { name: "Unterlagen" });
  for (const box of await docs.getByRole("checkbox").all()) await box.check();
  await docs.getByRole("button", { name: "Unterlagen speichern" }).click();
  await expect(docs.getByRole("status")).toHaveText("Gespeichert.");
  await expect(page.getByRole("article", { name: "Angaben" })).toContainText("Unterlagen vollständig");

  // Notiz
  const note = page.getByRole("form", { name: "Notiz" });
  await note.getByLabel("Notiz (intern)").fill("Zeugnis im Original gesehen.");
  await note.getByRole("button", { name: "Notiz speichern" }).click();
  await expect(page.getByRole("article", { name: "Verlauf" })).toContainText("Zeugnis im Original gesehen.");

  // Termin verschieben → Mail an die Eltern
  const move = page.getByRole("form", { name: "Termin verschieben" });
  await move.getByLabel("Gesprächstermin").selectOption({ index: 2 });
  await move.getByRole("button", { name: "Termin speichern" }).click();
  await expect(move.getByRole("status")).toHaveText("Termin gespeichert.");
  await expect(page.getByRole("article", { name: "Angaben" })).toContainText("14:30–15:00");

  // Druck: Anmeldebogen und Tagesliste
  await page.getByRole("link", { name: "Anmeldebogen drucken" }).click();
  await expect(page.getByRole("heading", { name: "Anmeldebogen" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Greta Ölmann");
  await page.goto(`/druck/anmeldung-tag/${id}/2030-03-07`);
  await expect(page.getByRole("main")).toContainText("Ölmann, Greta");
  expect(errors).toEqual([]);

  // Lehrkräfte sehen nichts
  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  expect((await page.goto(`/verwaltung/anmeldung/${id}/antraege`))?.status()).toBe(404);
});
