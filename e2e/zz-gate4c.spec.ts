import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createOpenVerfahren, fillAnmeldung, linkFromDevMail } from "./anmeldung-helpers";
import { collectErrors, login, loginWithStartPassword, logoutForSwitch } from "./helpers";

// P4-43: E2E Gate 4c. Der Durchlauf endet im Schuljahreswechsel (Versetzung, Archivieren, Abschluss) und verändert damit die
// gemeinsame E2E-DB für immer: 2027/28 wird das aktuelle Schuljahr. Darum steht die Datei absichtlich ganz hinten (Playwright
// sortiert nach Dateiname; „zz-“) und die Tests laufen der Reihe nach. Die E2E-DB bleibt ohne Demo-Verfahren (SEED_ANMELDUNG=0):
// stammdaten/schuljahreswechsel.spec erwarten kein Schuljahr 2027/28, und das Demo-Verfahren mit 30 Anträgen würde die
// Neuaufnahmen-Liste mit Fremddaten füllen – der Test legt Schuljahr und Verfahren selbst an.
test.describe.configure({ mode: "serial" });

const SVG_HINT = '<svg onload="window.__xss=1"><script>window.__xss=1</script></svg><img src=x onerror="window.__xss=1">kommt mit dem Bus';

test("P4-43: 11. Einreichung von einer IP in einer Stunde bekommt den Hinweis „zu viele Anfragen“", async ({ page }) => {
  test.setTimeout(120_000);
  const id = await createOpenVerfahren(page, "E2E Rate-Limit Klasse 5", "2030-04-02", 3);
  const errors = collectErrors(page);
  const ip = "198.51.100.200";
  // 10 Einreichungen (bewusst zu früh: der Server antwortet wie bei Erfolg, zählt sie aber gegen die IP)
  for (let i = 1; i <= 10; i++)
    await fillAnmeldung(page, id, { first: "Rate", last: `Limit${String.fromCharCode(64 + i)}`, email: `rate${i}.p443@example.org`, time: "14:00–14:30" }, { ip, early: true });
  // die 11. – ordentlich ausgefüllt – wird abgewiesen
  await fillAnmeldung(page, id, { first: "Rate", last: "Limitk", email: "rate11.p443@example.org", time: "14:00–14:30" }, { ip, error: /Zu viele Anfragen/ });
  // eine andere Adresse hat ihr eigenes Kontingent
  await fillAnmeldung(page, id, { first: "Rate", last: "Andere", email: "rate-andere.p443@example.org", time: "14:00–14:30" }, { ip: "198.51.100.201" });
  expect(errors.filter((e) => !/status of 4\d\d|Failed to load resource/.test(e))).toEqual([]);
});

test("P4-43: Antrag → Bestätigung → Unterlagen → Aufnahme → Schuljahreswechsel „Neuaufnahmen“ → neue Schülerin meldet sich an", async ({ page }) => {
  test.setTimeout(240_000);
  // Schuljahr 2027/28 anlegen (der Schuljahreswechsel bietet „Folgejahr anlegen“) – das Verfahren zielt darauf
  await login(page, "petra.lindner");
  await page.goto("/verwaltung/schuljahreswechsel");
  await page.getByRole("button", { name: "Folgejahr anlegen" }).click();
  await expect(page.getByRole("button", { name: "Schuljahreswechsel starten" })).toBeVisible();
  await logoutForSwitch(page);

  // 1) Sekretariat legt das Verfahren an (Zieljahr 2027/28), 2) Eltern melden ohne Login an – Freitext mit SVG/HTML
  const id = await createOpenVerfahren(page, "E2E Gate 4c Klasse 5", "2030-04-03", 4, "2027/28");
  await fillAnmeldung(page, id, { first: "Mila", last: "Neuaufnahme", email: "mila.gate4c@example.org", time: "14:00–14:30" }, {
    ip: "198.51.100.210",
    hints: SVG_HINT,
    parent2: { name: "Bodo Neuaufnahme", email: "bodo.gate4c@example.org" },
  });
  await fillAnmeldung(page, id, { first: "Ole", last: "Absage", email: "ole.gate4c@example.org", time: "14:30–15:00" }, { ip: "198.51.100.211" });

  // 3) Link aus /dev/mail → bestätigt, Termin steht
  const confirmPath = await linkFromDevMail(page, "mila.gate4c@example.org", "/anmeldung/bestaetigen/");
  await page.goto(confirmPath);
  await page.getByRole("button", { name: "Anmeldung bestätigen" }).click();
  await expect(page.getByRole("status")).toContainText("Ihre Anmeldung ist bestätigt");
  await expect(page.getByTestId("termin")).toContainText("14:00–14:30");
  await logoutForSwitch(page);
  const confirmOle = await linkFromDevMail(page, "ole.gate4c@example.org", "/anmeldung/bestaetigen/");
  await page.goto(confirmOle);
  await page.getByRole("button", { name: "Anmeldung bestätigen" }).click();
  await expect(page.getByRole("status")).toContainText("Ihre Anmeldung ist bestätigt");
  await logoutForSwitch(page);

  // 4) Sekretariat hakt die Unterlagen ab; SVG/HTML aus dem Freitext bleibt Text
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto(`/verwaltung/anmeldung/${id}/antraege`);
  await page.getByRole("link", { name: "Neuaufnahme, Mila" }).click();
  const angaben = page.getByRole("article", { name: "Angaben" });
  await expect(angaben).toContainText('<svg onload="window.__xss=1">');
  await expect(angaben).toContainText("<img src=x onerror=");
  await expect(angaben).toContainText("bodo.gate4c@example.org"); // Q5-23
  await expect(page.locator('main img[src="x"], main script, main svg[onload]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  const docs = page.getByRole("form", { name: "Unterlagen" });
  for (const box of await docs.getByRole("checkbox").all()) await box.check();
  await docs.getByRole("button", { name: "Unterlagen speichern" }).click();
  await expect(docs.getByRole("status")).toHaveText("Gespeichert.");
  await expect(angaben).toContainText("Unterlagen vollständig");
  // auch der Anmeldebogen (Druck) zeigt es als Text
  await page.getByRole("link", { name: "Anmeldebogen drucken" }).click();
  await expect(page.getByRole("main")).toContainText("<img src=x onerror=");
  await expect(page.locator('main img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await page.goto(`/verwaltung/anmeldung/${id}`);
  await page.getByRole("button", { name: "Anmeldung schließen" }).click();
  await expect(page.getByText("Geschlossen", { exact: true })).toBeVisible();
  await logoutForSwitch(page);

  // 5) Schulleitung nimmt Mila auf, lehnt Ole ab und schließt das Verfahren ab
  await login(page, "petra.lindner");
  await page.goto(`/verwaltung/anmeldung/${id}/entscheidung`);
  await page.getByRole("link", { name: "Neuaufnahme, Mila" }).click();
  const one = page.getByRole("form", { name: "Entscheidung" });
  await one.getByRole("button", { name: "Aufnehmen" }).click();
  await expect(one.getByRole("status")).toContainText("1 Antrag entschieden");
  await page.goto(`/verwaltung/anmeldung/${id}/entscheidung`);
  await page.getByRole("link", { name: "Absage, Ole" }).click();
  const two = page.getByRole("form", { name: "Entscheidung" });
  await two.getByRole("button", { name: "Ablehnen" }).click();
  await expect(two.getByRole("status")).toContainText("1 Antrag entschieden");
  await page.goto(`/verwaltung/anmeldung/${id}/entscheidung`);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("article", { name: "Abschluss" }).getByRole("button", { name: "Verfahren abschließen" }).click();
  await expect(page.getByText("Abgeschlossen", { exact: true })).toBeVisible();
  await logoutForSwitch(page);

  // 6) Der abgelehnte Antrag hat jetzt einen Löschtermin (Verfahrensabschluss + Frist): Auskunft nennt das Datum,
  //    der Löschlauf führt ihn nicht als heute fällig (die Frist beginnt erst jetzt)
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/anmeldung/auskunft");
  const search = page.getByRole("form", { name: "Auskunft suchen" });
  await search.getByLabel("Vorgangsnummer oder E-Mail-Adresse").fill("ole.gate4c@example.org");
  await search.getByRole("button", { name: "Suchen" }).click();
  const hit = page.getByRole("region", { name: "Treffer" });
  await expect(hit).toContainText("Ole Absage");
  const [dl] = await Promise.all([page.waitForEvent("download"), hit.getByRole("button", { name: /^Auskunft A-\d{4}-\d{4} als JSON$/ }).click()]);
  const json = JSON.parse(await readFile((await dl.path())!, "utf8"));
  expect(json.antrag.stand).toBe("Abgelehnt");
  expect(json.antrag.loeschung).toMatch(/^Wird am \d{4}-\d{2}-\d{2} gelöscht/);
  const due = new Date(/\d{4}-\d{2}-\d{2}/.exec(json.antrag.loeschung)![0]).getTime();
  expect(due).toBeGreaterThan(Date.now()); // Frist (Vorgabe 60 Tage) läuft erst ab dem Abschluss
  await logoutForSwitch(page);
  await login(page, "petra.lindner");
  await page.goto("/verwaltung/datenschutz/loeschlauf");
  await expect(page.getByRole("heading", { name: /Vorschau für heute/ })).toBeVisible();
  await expect(page.getByText("anmeldung_antraege")).toHaveCount(0);

  // 7) Schuljahreswechsel: Wechsel starten, Versetzung, Neuaufnahmen
  await page.goto("/verwaltung/schuljahreswechsel");
  await page.getByRole("button", { name: "Schuljahreswechsel starten" }).click();
  await page.getByRole("button", { name: "Versetzung durchführen" }).click();
  await expect(page.getByRole("form", { name: "Neuaufnahmen" })).toBeVisible();
  const steps = page.getByRole("list", { name: "Schritte" });
  await expect(steps.getByRole("listitem").filter({ hasText: "Neuaufnahmen" })).toHaveAttribute("aria-current", "step");
  const table = page.getByRole("form", { name: "Neuaufnahmen" }).getByRole("table");
  await expect(table).toContainText("Neuaufnahme, Mila");
  await expect(table).not.toContainText("Absage, Ole"); // abgelehnt → nicht in der Liste
  await expect(page.getByLabel("Klasse für Neuaufnahme, Mila")).not.toHaveValue("");
  await expect(table.getByTestId("elternteil2")).toContainText("neu: Bodo Neuaufnahme"); // Q5-23
  await page.getByRole("button", { name: "Neuaufnahmen übernehmen" }).click();
  await expect(page.getByRole("status")).toContainText("1 Kinder in 1 Klassen übernommen");
  const creds = page.getByRole("main").getByRole("table");
  const kind = creds.getByRole("row").filter({ hasText: "Mila Neuaufnahme" }).filter({ hasText: "Schüler" }).first();
  const username = (await kind.locator("td").nth(3).innerText()).trim();
  const startPassword = (await kind.locator("td").nth(4).innerText()).trim();
  expect(username).toMatch(/\w/);
  expect(startPassword.length).toBeGreaterThanOrEqual(8);
  // Q5-23: Konto auch für den zweiten Elternteil
  await expect(creds.getByRole("row").filter({ hasText: "Bodo Neuaufnahme" }).filter({ hasText: "Elternteil" })).toHaveCount(1);
  await page.getByRole("link", { name: "Weiter zum nächsten Schritt" }).click();

  // Q5-21: Liste verloren → Startpasswörter neu erzeugen (Bestätigung nötig), das neue gilt
  const regen = page.getByRole("article", { name: "Neuaufnahmen: Startpasswörter" });
  await regen.getByRole("button", { name: "Startpasswörter neu erzeugen" }).click();
  await expect(regen.getByRole("alert")).toContainText("bitte bestätigen", { ignoreCase: true });
  await regen.getByLabel("Die bisher ausgegebenen Startpasswörter dieser Konten werden ungültig.").check();
  await regen.getByRole("button", { name: "Startpasswörter neu erzeugen" }).click();
  await expect(regen.getByRole("status")).toContainText("Startpasswörter neu erzeugt");
  const regenRow = regen.getByRole("table").getByRole("row").filter({ hasText: "Mila Neuaufnahme" }).filter({ hasText: "Schüler" }).first();
  expect((await regenRow.locator("td").nth(3).innerText()).trim()).toBe(username);
  const newPassword = (await regenRow.locator("td").nth(4).innerText()).trim();
  expect(newPassword).not.toBe(startPassword);
  await regen.getByRole("link", { name: "Weiter zum nächsten Schritt" }).click();

  // Klassenbücher exportieren → archivieren → prüfen → abschließen
  await expect(page.getByRole("button", { name: "Archivexport herunterladen" }).first()).toBeVisible();
  for (let guard = 0; guard < 40; guard++) {
    const next = page.getByRole("button", { name: "Archivexport herunterladen" }).first();
    if (!(await next.isVisible())) break;
    const [d] = await Promise.all([page.waitForEvent("download"), next.click()]);
    await d.path();
    await page.goto("/verwaltung/schuljahreswechsel");
  }
  await page.getByRole("button", { name: /^Gruppen von .* archivieren$/ }).click();
  await page.getByLabel("Löschprotokoll, Löschsperren und nicht übergebene Archivexporte sind geprüft.").check();
  await page.getByRole("button", { name: "Geprüft" }).click();
  await page.getByRole("button", { name: "Schuljahreswechsel abschließen" }).click();
  await expect(page.getByText("Neues Schuljahr nach 2027/28")).toBeVisible(); // 2027/28 ist jetzt das aktuelle Schuljahr
  await page.screenshot({ path: ".data/shots/e2e/gate4c-neuaufnahmen.png", fullPage: true });
  expect(errors).toEqual([]);
  await logoutForSwitch(page);

  // 8) Die neue Schülerin meldet sich mit dem Startpasswort an und sieht ihre Klasse
  await loginWithStartPassword(page, username, newPassword);
  await expect(page.getByRole("main")).toContainText("Klasse 5");
  await logoutForSwitch(page);
});
