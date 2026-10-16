import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createOpenVerfahren, fillAnmeldung, linkFromDevMail } from "./anmeldung-helpers";
import { collectErrors, login, logoutForSwitch } from "./helpers";

async function anmelden(page: Page, id: string, first: string, last: string, ip: string) {
  const email = `${first.toLowerCase()}.p437@example.org`;
  await fillAnmeldung(page, id, { first, last, email, time: "14:00–14:30" }, { ip });
  const confirmPath = await linkFromDevMail(page, email, "/anmeldung/bestaetigen/");
  await page.goto(confirmPath);
  await page.getByRole("button", { name: "Anmeldung bestätigen" }).click();
  await expect(page).toHaveURL(/\/anmeldung\/vorgang\//);
  await logoutForSwitch(page);
}

async function download(page: Page, click: () => Promise<void>) {
  const [dl] = await Promise.all([page.waitForEvent("download"), click()]);
  return { name: dl.suggestedFilename(), bytes: await readFile((await dl.path())!) };
}

test("P4-37: Schulleitung entscheidet (Liste und einzeln), Sekretariat exportiert, Verfahren abschließen", async ({ page }) => {
  const id = await createOpenVerfahren(page, "E2E Entscheidung Klasse 5", "2030-03-08");
  await anmelden(page, id, "Jona", "Ärztin", "198.51.100.37");
  await anmelden(page, id, "Kim", "Brauer", "198.51.100.38");

  const errors = collectErrors(page);
  // Sekretariat sieht die Liste, entscheidet aber nicht
  await login(page, "sabine.kowalski");
  await page.goto(`/verwaltung/anmeldung/${id}/entscheidung`);
  await expect(page.getByRole("link", { name: "Ärztin, Jona" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Aufnehmen" })).toHaveCount(0);
  await logoutForSwitch(page);

  await login(page, "petra.lindner");
  await page.goto(`/verwaltung/anmeldung/${id}`);
  await page.getByRole("navigation", { name: "Verfahren" }).getByRole("link", { name: "Entscheidung" }).click();
  const list = page.getByRole("form", { name: "Entscheidung" });
  await expect(list.getByRole("button", { name: "Aufnehmen" })).toBeDisabled();
  await list.getByRole("checkbox", { name: "Alle auswählen" }).check();
  await expect(page.getByTestId("auswahl")).toContainText("2 Anträge ausgewählt");
  await list.getByRole("button", { name: "Aufnehmen" }).click();
  await expect(list.getByRole("status")).toContainText("2 Anträge entschieden – 2 Mails");
  await expect(list.getByRole("row", { name: /Brauer, Kim/ })).toContainText("Aufgenommen");

  // einzeln korrigieren: Kim auf die Warteliste (keine zweite Mail)
  await list.getByRole("link", { name: "Brauer, Kim" }).click();
  const one = page.getByRole("form", { name: "Entscheidung" });
  await one.getByLabel("Notiz zur Entscheidung (intern, optional)").fill("Nachrücken möglich");
  await one.getByRole("button", { name: "Warteliste" }).click();
  await expect(one.getByRole("status")).toHaveText("1 Antrag entschieden.");
  await expect(page.getByRole("article", { name: "Angaben" })).toContainText("Warteliste");
  await logoutForSwitch(page);

  // Export durch das Sekretariat
  await login(page, "sabine.kowalski");
  await page.goto(`/verwaltung/anmeldung/${id}/export`);
  const svs = page.getByRole("article", { name: "Export Schulverwaltungssoftware" });
  await svs.getByLabel("Kodierung").selectOption("cp1252");
  const csv = await download(page, () => svs.getByRole("button", { name: "CSV herunterladen" }).click());
  expect(csv.name).toMatch(/^anmeldung-e2e-entscheidung-klasse-5-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = new TextDecoder("windows-1252").decode(csv.bytes);
  expect(text.split("\r\n")[0]).toBe("Vorgangsnummer;Nachname;Vorname;Geburtsdatum;Grundschule;Elternteil 1;Elternteil 2;Straße;PLZ;Ort;Telefon;E-Mail");
  expect(text).toContain(";Ärztin;Jona;14.03.2015;");
  expect(text).not.toContain("Brauer");
  const letters = await download(page, () => page.getByRole("article", { name: "Serienbrief" }).getByRole("button", { name: "Serienbrief-CSV herunterladen" }).click());
  const lt = new TextDecoder().decode(letters.bytes);
  expect(lt).toContain("Aufgenommen;Andrea Beispiel");
  expect(lt).toContain("Warteliste;Andrea Beispiel");
  // GET löst keinen Export aus (SEC-05)
  expect((await page.request.get(`/api/verwaltung/anmeldung-export/${id}/svs`)).status()).toBe(405);

  // Anmeldung schließen (Sekretariat) → abschließen (Schulleitung)
  await page.goto(`/verwaltung/anmeldung/${id}`);
  await page.getByRole("button", { name: "Anmeldung schließen" }).click();
  await expect(page.getByText("Geschlossen", { exact: true })).toBeVisible();
  await logoutForSwitch(page);
  await login(page, "petra.lindner");
  await page.goto(`/verwaltung/anmeldung/${id}/entscheidung`);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("article", { name: "Abschluss" }).getByRole("button", { name: "Verfahren abschließen" }).click();
  await expect(page.getByText("Abgeschlossen", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Aufnehmen" })).toHaveCount(0);
  await page.goto("/verwaltung/protokoll");
  await expect(page.getByText("Schulanmeldung: Export für die Schulverwaltungssoftware").first()).toBeVisible();
  await page.goto("/verwaltung/protokoll");
  await expect(page.getByText("Schulanmeldung: Export für die Schulverwaltungssoftware").first()).toBeVisible();
  expect(errors).toEqual([]);

  // Lehrkräfte: weder Seite noch Export
  await logoutForSwitch(page);
  await login(page, "jana.brandt");
  expect((await page.goto(`/verwaltung/anmeldung/${id}/entscheidung`))?.status()).toBe(404);
  expect((await page.request.post(`/api/verwaltung/anmeldung-export/${id}/serienbrief`, { form: { encoding: "utf8" } })).status()).toBe(404);
});
