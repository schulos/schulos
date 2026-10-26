import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// Gate 4d (P4-65): WP-I-Wahl im 7. Jahrgang → Zuteilung → Gruppen entstehen → der Kursraum zeigt sie.
// „zy-“: läuft nach unterricht.spec (der angelegte Lehrauftrag änderte dort die Diagnose) und vor zz-gate4c (Schuljahreswechsel).
const ymd = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

test("Gate 4d: WP-I-Wahl 7b → Zuteilung → Gruppen → Kursraum", async ({ page }) => {
  const errors = collectErrors(page);
  // 1. Sekretariat legt die Wahl mit zwei Angeboten an (Französisch mit Lehrkraft und Stunden)
  await login(page, "sabine.kowalski");
  await page.goto("/kurswahl");
  const neu = page.getByRole("form", { name: "Wahlverfahren anlegen" });
  await neu.getByLabel("Titel").fill("WP I Gate 4d");
  await neu.getByLabel("Jahrgang der Wählenden").selectOption({ label: "Jahrgang 7" });
  await neu.getByLabel("Jahrgang der Kurse").selectOption({ label: "Jahrgang 7" });
  await neu.getByLabel("Wünsche je Kurs").selectOption("2");
  await neu.getByRole("button", { name: "Wahlverfahren anlegen" }).click();
  await expect(page).toHaveURL(/\/kurswahl\/[\w-]+$/);
  const url = page.url();
  const add = page.getByRole("form", { name: "Angebot hinzufügen" });
  await expect(add.getByLabel("Titel")).toHaveValue("");
  await add.getByLabel("Titel").fill("Französisch G4d");
  await add.getByLabel("Fach").selectOption({ label: "Französisch" });
  // SP2-12b: fachfremd (Frau Brandt unterrichtet kein Französisch) → „alle anzeigen“ und „Trotzdem zuweisen“
  await add.getByLabel("alle anzeigen").check();
  await add.getByLabel("Lehrkraft").selectOption("u-jana.brandt");
  await add.getByLabel("Trotzdem zuweisen").check();
  await add.getByLabel("Wochenstunden").fill("4");
  await add.getByRole("button", { name: "Angebot hinzufügen" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Französisch G4d" })).toBeVisible();
  await expect(add.getByLabel("Titel")).toHaveValue("");
  await add.getByLabel("Titel").fill("Informatik G4d");
  await add.getByLabel("Fach").selectOption({ label: "Informatik" });
  await add.getByRole("button", { name: "Angebot hinzufügen" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Informatik G4d" })).toBeVisible();
  await logoutForSwitch(page);

  // 2. Leas Mutter wählt
  await login(page, "daniela.schaefer");
  await page.goto("/kurswahl");
  const form = page.getByRole("form", { name: "Wahl WP I Gate 4d – Lea Schäfer" });
  await form.getByLabel("1. Wunsch").selectOption({ label: "Französisch G4d" });
  await form.getByLabel("2. Wunsch").selectOption({ label: "Informatik G4d" });
  await form.getByRole("button", { name: "Wahl abgeben" }).click();
  await expect(form.getByRole("status")).toContainText("abgegeben");
  await logoutForSwitch(page);

  // 3. Sekretariat schließt die Wahl, teilt zu und übernimmt in Gruppen
  await login(page, "sabine.kowalski");
  await page.goto(url);
  const settings = page.getByRole("form", { name: "Wahlverfahren speichern" });
  await settings.getByLabel("Wahl ab").fill(ymd(-3));
  await settings.getByLabel("Wahl bis (einschließlich)").fill(ymd(-1));
  await settings.getByRole("button", { name: "Wahlverfahren speichern" }).click();
  await expect(settings.getByRole("status")).toContainText("Gespeichert");
  await page.getByRole("form", { name: "Zuteilung" }).getByRole("button", { name: "Zuteilung berechnen" }).click();
  await expect(page.getByRole("form", { name: "Zuteilung" }).getByRole("status")).toContainText("Zuteilung berechnet");
  await expect(page.getByRole("row", { name: /Schäfer, Lea 7b .*Französisch G4d .*1\. Wunsch erfüllt/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Französisch G4d 1 0/ })).toBeVisible();
  const uebernahme = page.getByRole("form", { name: "Übernahme" });
  await uebernahme.getByRole("button", { name: "In Gruppen übernehmen" }).click();
  await expect(uebernahme.getByRole("alert")).toContainText("Hinweise");
  await uebernahme.getByLabel("Hinweise gesehen – trotzdem übernehmen").check();
  await uebernahme.getByRole("button", { name: "In Gruppen übernehmen" }).click();
  await expect(page.getByText("Übernommen – die Familien sehen jetzt ihren Kurs.")).toBeVisible();
  await expect(page.getByRole("row", { name: /7 Französisch G4d Jana Brandt 4 vorgeschlagen/ })).toBeVisible();
  // SP-03: Lehraufträge legt die Stundenplanung an – das Sekretariat sieht nur den Hinweis. SP-05: die Gruppe Stundenplanung liest
  // die Kurswahl (`kurswahl.view`) und legt die Lehraufträge selbst an, ohne die Wahlen verwalten zu dürfen.
  await expect(page.getByText("Die vorgeschlagenen Lehraufträge legt die Stundenplanung an.")).toBeVisible();
  await logoutForSwitch(page);
  await login(page, "frank.schulte");
  await page.goto(url);
  // nur lesen: keine Wahlen einzelner Schüler:innen, kein Löschen, keine Einstellungen
  await expect(page.getByRole("button", { name: "Wahlverfahren löschen" })).toHaveCount(0);
  await expect(page.getByRole("form", { name: "Wahlverfahren speichern" })).toHaveCount(0);
  await expect(page.getByText("Schäfer, Lea")).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Französisch G4d 1 .* 1/ })).toBeVisible();
  await page.getByRole("button", { name: "Vorgeschlagene Lehraufträge anlegen" }).click();
  await expect(page.getByRole("row", { name: /7 Französisch G4d Jana Brandt 4 angelegt/ })).toBeVisible();
  await logoutForSwitch(page);

  // 4. Lea sieht ihren Kurs in der Kurswahl und im Kursraum
  await login(page, "lea.schaefer");
  await page.goto("/kurswahl");
  await expect(page.getByRole("article", { name: "WP I Gate 4d" }).getByRole("status")).toContainText("Zugeteilt: Französisch G4d (1. Wunsch)");
  await page.goto("/kurse");
  await page.getByRole("link", { name: /7 Französisch G4d/ }).click();
  await expect(page.getByRole("heading", { name: "7 Französisch G4d" })).toBeVisible();
  await logoutForSwitch(page);

  // 5. Jana Brandt leitet die neue Gruppe
  await login(page, "jana.brandt");
  await page.goto("/kurse");
  await expect(page.getByRole("link", { name: /7 Französisch G4d/ })).toBeVisible();
  expect(errors).toEqual([]);
});
