import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createOpenVerfahren, fillAnmeldung } from "./anmeldung-helpers";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// P4-42: Auskunft (Art. 15) zu einem Antrag ohne Konto – Sekretariat findet ihn per E-Mail-Adresse und lädt ihn als JSON
test("P4-42: Auskunft zur Schulanmeldung – Suche per E-Mail, JSON-Download, nur Sekretariat/Datenschutz", async ({ page }) => {
  const id = await createOpenVerfahren(page, "E2E Auskunft Klasse 5", "2030-03-11");
  await fillAnmeldung(page, id, { first: "Ruth", last: "Auskunft", email: "ruth.e2e@example.org", time: "14:00–14:30" }, { ip: "198.51.100.42" });

  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/anmeldung");
  await page.getByRole("link", { name: "Auskunft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Auskunft (Art. 15 DSGVO)" })).toBeVisible();
  const form = page.getByRole("form", { name: "Auskunft suchen" });

  // nur genaue Angaben – keine Teilsuche über alle Familien
  await form.getByLabel("Vorgangsnummer oder E-Mail-Adresse").fill("ruth");
  await form.getByRole("button", { name: "Suchen" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Vorgangsnummer");

  await form.getByLabel("Vorgangsnummer oder E-Mail-Adresse").fill("RUTH.e2e@example.org");
  await form.getByRole("button", { name: "Suchen" }).click();
  const table = page.getByRole("region", { name: "Treffer" });
  await expect(table).toContainText("Ruth Auskunft");
  await expect(table).toContainText("E-Mail nicht bestätigt");
  const [dl] = await Promise.all([page.waitForEvent("download"), table.getByRole("button", { name: /^Auskunft A-\d{4}-\d{4} als JSON$/ }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^auskunft-A-\d{4}-\d{4}\.json$/);
  const json = JSON.parse(await readFile((await dl.path())!, "utf8"));
  expect(json.antrag.kind.vorname).toBe("Ruth");
  expect(json.antrag.eltern.email).toBe("ruth.e2e@example.org");
  expect(json.verfahren.name).toBe("E2E Auskunft Klasse 5");
  expect(JSON.stringify(json)).not.toMatch(/hash|token/i);
  // nur per Knopf (POST)
  expect((await page.request.get("/api/verwaltung/anmeldung-auskunft/x")).status()).toBe(405);
  expect(errors).toEqual([]);

  // Lehrkräfte: weder Seite noch Route
  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  expect((await page.goto("/verwaltung/anmeldung/auskunft"))?.status()).toBe(404);
  expect((await page.request.post("/api/verwaltung/anmeldung-auskunft/x")).status()).toBe(404);
});
