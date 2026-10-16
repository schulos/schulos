import { expect, type Page } from "@playwright/test";
import { login, logoutForSwitch } from "./helpers";

/**
 * Sekretariat legt ein veröffentlichtes Verfahren für das Schuljahr 2026/27 an (Zeitraum läuft bis 2030), mit Terminen am
 * angegebenen Tag (14:00–15:00, 30 min, `parallel` Plätze). Gibt die ID zurück und meldet ab.
 */
export async function createOpenVerfahren(page: Page, name: string, day: string, parallel = 2, year = "2026/27"): Promise<string> {
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/anmeldung/neu");
  const form = page.getByRole("form", { name: "Verfahren" });
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Schuljahr", { exact: true }).selectOption({ label: year });
  await form.getByLabel("Anmeldung ab", { exact: true }).fill("2026-01-01T08:00");
  await form.getByLabel("Anmeldung bis", { exact: true }).fill("2030-12-31T18:00");
  await form.getByRole("button", { name: "Anlegen und Termine planen" }).click();
  await expect(page).toHaveURL(/\/verwaltung\/anmeldung\/[^/]+\/termine$/);
  const id = page.url().split("/").at(-2)!;
  const gen = page.getByRole("form", { name: "Termine erzeugen" });
  await gen.getByLabel("Tage", { exact: true }).fill(day);
  await gen.getByLabel("Zeitfenster", { exact: true }).fill("14:00-15:00");
  await gen.getByLabel("Dauer je Gespräch (Minuten)").fill("30");
  await gen.getByLabel("Parallele Gespräche").fill(String(parallel));
  await gen.getByRole("button", { name: "Termine erzeugen" }).click();
  await expect(gen.getByRole("status")).toContainText("2 Termine angelegt");
  await page.goto(`/verwaltung/anmeldung/${id}`);
  await page.getByRole("button", { name: "Veröffentlichen" }).click();
  await expect(page.getByText("Veröffentlicht", { exact: true })).toBeVisible();
  await logoutForSwitch(page);
  return id;
}

/** Link aus der neuesten Mail an `to` (/dev/mail, als admin), danach abgemeldet. */
export async function linkFromDevMail(page: Page, to: string, pathPrefix: string): Promise<string> {
  await logoutForSwitch(page);
  await login(page, "admin");
  await page.goto("/dev/mail");
  const mail = page.getByRole("listitem").filter({ has: page.getByTestId("mail-to").getByText(to, { exact: true }) }).filter({ hasText: pathPrefix }).first();
  const text = await mail.getByTestId("mail-text").innerText();
  const url = text.split(/\s+/).find((w) => w.includes(pathPrefix));
  expect(url, `Link ${pathPrefix} in der Mail`).toBeTruthy();
  await logoutForSwitch(page);
  return new URL(url!).pathname;
}

export interface Familie {
  first: string;
  last: string;
  email: string;
  time: string;
}

/**
 * Öffentliches Formular ohne Anmeldung ausfüllen und absenden (alle Schritte). Wartet die Mindestdauer des Formulars ab.
 * `ip` simuliert die Client-Adresse (X-Forwarded-For wie von Caddy) – jeder Test hat so sein eigenes Kontingent.
 */
export async function fillAnmeldung(page: Page, verfahrenId: string, f: Familie, opts: { ip: string; hints?: string; early?: boolean; error?: RegExp; parent2?: { name: string; email: string } } = { ip: "198.51.100.1" }) {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": opts.ip });
  const loaded = Date.now();
  await page.goto(`/anmeldung/${verfahrenId}`);
  const form = page.getByRole("form", { name: "Anmeldung" });
  await form.getByLabel("Vorname", { exact: true }).fill(f.first);
  await form.getByLabel("Nachname", { exact: true }).fill(f.last);
  await form.getByLabel("Geburtsdatum", { exact: true }).fill("2015-03-14");
  await form.getByLabel("Grundschule", { exact: true }).fill("GS Am Park");
  await form.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByRole("heading", { name: "Angaben zu den Eltern" })).toBeVisible();
  await form.getByLabel("Name (Elternteil)").fill("Andrea Beispiel");
  await form.getByLabel("E-Mail-Adresse", { exact: true }).fill(f.email);
  await form.getByLabel("Straße und Hausnummer").fill("Lindenweg 3");
  await form.getByLabel("Postleitzahl").fill("12345");
  await form.getByLabel("Ort", { exact: true }).fill("Musterstadt");
  if (opts.hints) await form.getByLabel("Hinweise für das Gespräch (optional)").fill(opts.hints);
  if (opts.parent2) {
    // Q5-23: zweiter Elternteil mit E-Mail – nur mit Bestätigung, dass er Bescheid weiß
    await form.getByLabel("Zweiter Elternteil (optional)").fill(opts.parent2.name);
    await form.getByLabel("E-Mail-Adresse (zweiter Elternteil, optional)").fill(opts.parent2.email);
    await form.getByLabel(/Der zweite Elternteil weiß von dieser Angabe/).check();
  }
  await form.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByRole("heading", { name: "Termin für das Anmeldegespräch" })).toBeVisible();
  await form.getByRole("radio", { name: new RegExp(f.time) }).first().check();
  await form.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByRole("heading", { name: "Angaben prüfen" })).toBeVisible();
  await expect(form.getByRole("definition").filter({ hasText: f.email })).toBeVisible();
  await expect(form.getByRole("region", { name: "Datenschutzhinweis" })).toContainText("Rechtsgrundlage");
  await form.getByLabel("Ich habe die Datenschutzhinweise gelesen.").check();
  // Mindestdauer (signierter Zeitstempel, 5 s) – sonst behandelt der Server das Absenden wie einen Bot
  // `early`: bewusst zu früh abschicken – der Server tut so als ob, zählt es aber gegen die IP (Rate-Limit-Test)
  const wait = 5_500 - (Date.now() - loaded);
  if (wait > 0 && !opts.early) await page.waitForTimeout(wait);
  await form.getByRole("button", { name: "Anmeldung absenden" }).click();
  if (opts.error) await expect(page.getByRole("alert").filter({ hasText: opts.error })).toBeVisible();
  else await expect(page.getByRole("status")).toContainText("bitte E-Mail bestätigen");
}
