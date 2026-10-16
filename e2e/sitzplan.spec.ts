import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// P5-04: Sitzplan – Klassenleitung legt an, setzt per Tastatur und verteilt, druckt ohne Fotos, erfasst im Klassenbuch
// eine Fehlzeit per Klick am Platz; Schüler:in, Eltern, Verwaltung, Admin und fremde Lehrkraft sehen nichts (404).

test.describe.configure({ mode: "serial" });

let planPath = "";

async function openSevenBLesson(page: Page) {
  await page.goto("/klassenbuch");
  // zwei Schultage zurück, damit sich die Stunde nicht mit klassenbuch.spec überschneidet; dann bis zu einer Stunde der 7b
  const lesson = page.getByRole("link", { name: /7b.*(Offen|Eingetragen)$/ }).first();
  for (let i = 0; i < 8; i++) {
    await page.getByRole("link", { name: "Vorheriger Schultag" }).click();
    await expect(page.getByRole("heading", { name: "Meine Stunden" })).toBeVisible();
    if (i >= 1 && (await lesson.count()) > 0) break;
  }
  await lesson.click();
  await expect(page.getByLabel("Thema der Stunde")).toBeVisible();
}

test("P5-02/P5-03: Klassenleitung legt einen Sitzplan an, setzt per Tastatur, druckt ohne Fotos, Fehlzeit per Klick im Klassenbuch", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await page.goto("/sitzplan");
  const form = page.getByRole("form", { name: "Neuer Sitzplan" });
  await form.getByLabel("Lerngruppe").selectOption({ label: "Klasse 7b" });
  await form.getByLabel("Titel").fill("7b Sitzplan E2E");
  await form.getByLabel("Fach").selectOption("");
  await form.getByLabel("Raum").selectOption("");
  await form.getByLabel("Tischanordnung").selectOption("reihen");
  await form.getByLabel("Reihen", { exact: true }).fill("5");
  await form.getByLabel("Plätze je Reihe").fill("8");
  await form.getByRole("button", { name: "Sitzplan anlegen" }).click();
  await expect(page.getByRole("heading", { name: "7b Sitzplan E2E" })).toBeVisible();
  planPath = new URL(page.url()).pathname;

  // alphabetisch verteilen (noch niemand sitzt → ohne Rückfrage), dann speichern
  await page.getByRole("button", { name: "Alphabetisch verteilen" }).click();
  await expect(page.getByRole("button", { name: /^Reihe 1, Platz 1: (?!frei)/ })).toBeVisible();
  const first = await page.getByRole("button", { name: /^Reihe 1, Platz 1: / }).getAttribute("aria-label");
  const name = first!.replace("Reihe 1, Platz 1: ", "");

  // Tastaturweg: Person auf Reihe 1/Platz 1 wählen (Enter), zum freien Platz hinten rechts, Enter
  await page.getByRole("button", { name: `Reihe 1, Platz 1: ${name}` }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sitzplan-hinweis")).toContainText(`${name} ausgewählt`);
  await page.getByRole("button", { name: "Reihe 5, Platz 8: frei" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: `Reihe 5, Platz 8: ${name}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reihe 1, Platz 1: frei" })).toBeVisible();
  // Pfeiltasten bewegen den Fokus im Raster
  await page.getByRole("button", { name: "Reihe 1, Platz 1: frei" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: /^Reihe 1, Platz 2: / })).toBeFocused();
  // G4D-C10: Platz 3 ist ein Gang (kein Tisch) – der Fokus springt darüber hinweg und zurück
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: /^Reihe 1, Platz 4: / })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("button", { name: /^Reihe 1, Platz 2: / })).toBeFocused();

  // Tische: ein Feld wird zum Tisch
  await page.getByRole("radiogroup", { name: "Bearbeiten" }).getByText("Tische", { exact: true }).click();
  await page.getByRole("button", { name: "Reihe 1, Platz 3: kein Tisch" }).click();
  await expect(page.getByRole("button", { name: "Reihe 1, Platz 3: Tisch" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("radiogroup", { name: "Bearbeiten" }).getByText("Plätze", { exact: true }).click();

  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sitzplan gespeichert." })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: `Reihe 5, Platz 8: ${name}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reihe 1, Platz 3: frei" })).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/sitzplan-editor.png", fullPage: true });

  // Druck: Namen, nie Fotos
  await page.goto(planPath.replace("/sitzplan/", "/druck/sitzplan/"));
  await expect(page.getByRole("table", { name: "Sitzplan" })).toContainText(name.split(" ")[0]!);
  await expect(page.locator('img[src*="/api/profilbild"]')).toHaveCount(0);

  // Klassenbuch: Sitzplan zur Stunde, Klick auf den Platz → „Fehlt“
  await openSevenBLesson(page);
  const seats = page.getByRole("group", { name: /^Sitzplan/ });
  await expect(seats).toBeVisible();
  await seats.getByRole("button", { name: `${name}: anwesend` }).click();
  await expect(seats.getByRole("button", { name: `${name}: fehlt` })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name }).getByRole("radio", { name: "Fehlt" })).toBeChecked();
  await page.getByLabel("Thema der Stunde").fill("Sitzplan-Test");
  await page.getByRole("button", { name: "Eintrag speichern" }).click();
  await expect(page.getByRole("heading", { name: "Meine Stunden" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("P5-04: Schüler:in, Eltern, Verwaltung, Admin und eine fremde Lehrkraft sehen keine Sitzpläne (404)", async ({ page }) => {
  expect(planPath).toMatch(/^\/sitzplan\//);
  for (const user of ["lea.schaefer", "daniela.schaefer", "sabine.kowalski"]) {
    await login(page, user);
    expect((await page.goto("/sitzplan"))?.status(), user).toBe(404);
    expect((await page.goto(planPath))?.status(), user).toBe(404);
    expect((await page.goto(planPath.replace("/sitzplan/", "/druck/sitzplan/")))?.status(), user).toBe(404);
    await logoutForSwitch(page);
  }
  for (const user of ["admin", "markus.hoffmann"]) {
    await login(page, user);
    expect((await page.goto(planPath))?.status(), user).toBe(404);
    expect((await page.goto(planPath.replace("/sitzplan/", "/druck/sitzplan/")))?.status(), user).toBe(404);
    await logoutForSwitch(page);
  }
});
