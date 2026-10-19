import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

/** Wahlverfahren für Jahrgang 7 anlegen (Sekretariat) – gibt die URL zurück. */
async function createVerfahren(page: Page, title: string, offers: { title: string; subject: string; max?: string }[]): Promise<string> {
  await page.goto("/kurswahl");
  const form = page.getByRole("form", { name: "Wahlverfahren anlegen" });
  await form.getByLabel("Titel").fill(title);
  await form.getByLabel("Jahrgang der Wählenden").selectOption({ label: "Jahrgang 7" });
  await form.getByLabel("Jahrgang der Kurse").selectOption({ label: "Jahrgang 7" });
  await form.getByRole("button", { name: "Wahlverfahren anlegen" }).click();
  await expect(page).toHaveURL(/\/kurswahl\/[\w-]+$/);
  const url = page.url();
  for (const o of offers) {
    const add = page.getByRole("form", { name: "Angebot hinzufügen" });
    // React setzt das Formular nach dem Speichern zurück – erst dann ausfüllen
    await expect(add.getByLabel("Titel")).toHaveValue("");
    await add.getByLabel("Titel").fill(o.title);
    await add.getByLabel("Fach").selectOption({ label: o.subject });
    if (o.max) await add.getByLabel("Höchstzahl").fill(o.max);
    await add.getByRole("button", { name: "Angebot hinzufügen" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: o.title }).first()).toBeVisible();
  }
  return url;
}

test("P4-61: Sekretariat legt ein Wahlverfahren mit Angeboten an und sieht Zielgruppe und Vorschau", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await createVerfahren(page, "WP I E2E-Anlage", [
    { title: "Französisch", subject: "Französisch", max: "28" },
    { title: "Informatik", subject: "Informatik" },
  ]);
  await expect(page.getByRole("heading", { name: "WP I E2E-Anlage" })).toBeVisible();
  await expect(page.getByText(/50 Schüler:innen \(7a: 25, 7b: 25\)/)).toBeVisible();
  const vorschau = page.locator("section", { has: page.getByRole("heading", { name: "Vorschau für die Familien" }) });
  await expect(vorschau.getByLabel("1. Wunsch")).toBeDisabled();
  await expect(vorschau.getByLabel("2. Wunsch")).toBeVisible();
  await expect(vorschau.getByLabel("3. Wunsch")).toHaveCount(0);
  // Zielgruppe auf eine Klasse einschränken
  const settings = page.getByRole("form", { name: "Wahlverfahren speichern" });
  await settings.getByLabel("Klasse 7b").check();
  await settings.getByRole("button", { name: "Wahlverfahren speichern" }).click();
  await expect(settings.getByRole("status")).toContainText("Gespeichert");
  await expect(page.getByText(/25 Schüler:innen \(7b: 25\)/)).toBeVisible();
  await page.goto("/kurswahl");
  await expect(page.getByRole("listitem").filter({ hasText: "WP I E2E-Anlage" })).toContainText("0 von 25 gewählt");
  expect(errors).toEqual([]);
});

test("P4-62: Mutter wählt für Lea, Lea sieht die Wahl, Sekretariat erinnert die übrigen und druckt den Wahlbogen", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  const url = await createVerfahren(page, "WP I E2E-Wahl", [
    { title: "Französisch", subject: "Französisch" },
    { title: "Informatik", subject: "Informatik" },
    { title: "Darstellen und Gestalten", subject: "Kunst" },
  ]);
  await logoutForSwitch(page);

  await login(page, "daniela.schaefer");
  await page.getByRole("link", { name: "Kurswahl" }).first().click();
  await expect(page).toHaveURL(/\/kurswahl$/);
  const card = page.getByRole("article", { name: "WP I E2E-Wahl – Lea Schäfer" });
  const form = card.getByRole("form", { name: "Wahl WP I E2E-Wahl – Lea Schäfer" });
  await form.getByLabel("1. Wunsch").selectOption({ label: "Informatik" });
  await form.getByLabel("2. Wunsch").selectOption({ label: "Informatik" });
  await form.getByLabel("3. Wunsch").selectOption({ label: "Französisch" });
  await form.getByRole("button", { name: "Wahl abgeben" }).click();
  await expect(form.getByRole("alert")).toContainText("Jedes Angebot nur einmal");
  await form.getByLabel("2. Wunsch").selectOption({ label: "Darstellen und Gestalten" });
  await form.getByRole("button", { name: "Wahl abgeben" }).click();
  await expect(card.getByRole("status")).toContainText("abgegeben");
  await expect(card).toContainText(/Abgegeben am .* von Daniela Schäfer/);
  await logoutForSwitch(page);

  await login(page, "lea.schaefer");
  await page.goto("/kurswahl");
  const lea = page.getByRole("article", { name: "WP I E2E-Wahl" });
  await expect(lea.getByRole("listitem")).toHaveText(["Informatik", "Darstellen und Gestalten", "Französisch"]);
  await expect(lea.getByRole("form")).toHaveCount(0);
  await logoutForSwitch(page);

  await login(page, "sabine.kowalski");
  await page.goto(url);
  await expect(page.getByText(/49 noch ohne Wahl/)).toBeVisible();
  await page.getByRole("button", { name: "Erinnerung an Nichtwähler senden" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Erinnerungen verschickt" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Schäfer, Lea 7b Informatik Darstellen und Gestalten Französisch gewählt/ })).toBeVisible();
  await page.goto(`${url.replace("/kurswahl/", "/druck/kurswahl/")}?schueler=u-lea.schaefer`);
  const bogen = page.getByRole("region", { name: "Wahlbogen Lea Schäfer" });
  await expect(bogen.getByRole("row", { name: "1. Wunsch Informatik" })).toBeVisible();
  await expect(bogen).toContainText("Unterschrift der Erziehungsberechtigten");
  expect(errors).toEqual([]);
});

test("P4-63: Sekretariat trägt Papier-Wahlbögen ein, teilt zu (Los bei Überbuchung) und korrigiert von Hand", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await createVerfahren(page, "WP I E2E-Zuteilung", [
    { title: "Französisch", subject: "Französisch", max: "1" },
    { title: "Informatik", subject: "Informatik" },
  ]);
  const papier = page.getByRole("form", { name: "Wahl eintragen" });
  await page.getByText("Wahl vom Papier-Wahlbogen eintragen").click();
  for (const who of [{ label: "Schäfer, Lea (7b)" }, { index: 1 }]) {
    await papier.getByLabel("Schüler:in").selectOption(who);
    await papier.getByLabel("1. Wunsch").selectOption({ label: "Französisch" });
    await papier.getByLabel("2. Wunsch").selectOption({ label: "Informatik" });
    await papier.getByRole("button", { name: "Wahl eintragen" }).click();
    await expect(papier.getByRole("status")).toContainText("abgegeben");
    await expect(papier.getByLabel("Schüler:in")).toHaveValue("");
  }
  const zuteilung = page.getByRole("form", { name: "Zuteilung" });
  await zuteilung.getByRole("button", { name: "Zuteilung berechnen" }).click();
  await expect(zuteilung.getByRole("status")).toContainText("Zuteilung berechnet");
  await expect(page.getByRole("row", { name: "Französisch 2 0 1 1" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Protokoll der Zuteilung" })).toContainText("Französisch, 1. Wunsch: 2 Bewerbungen auf 1 Plätze – Los");
  await expect(page.getByRole("row", { name: /2\. Wunsch erfüllt – 1\. Wunsch „Französisch“ voll \(Los\)/ })).toBeVisible();
  const lea = page.getByRole("form", { name: "Korrektur Lea Schäfer" });
  await lea.getByLabel("Kurs für Lea Schäfer").selectOption({ label: "Informatik" });
  await lea.getByRole("button", { name: "Zuteilen: Lea Schäfer" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Schäfer, Lea" }).filter({ hasText: "von Hand zugeteilt (2. Wunsch)" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("P4-64: nach dem Wahlende übernimmt das Sekretariat in Gruppen (mit Hinweisen), Lehrauftrag als Vorschlag", async ({ page }) => {
  const errors = collectErrors(page);
  const ymd = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  await login(page, "sabine.kowalski");
  const url = await createVerfahren(page, "WP I E2E-Übernahme", [
    { title: "Spanisch", subject: "Französisch" },
    { title: "Robotik", subject: "Informatik" },
  ]);
  const add = page.getByRole("listitem").filter({ hasText: "Spanisch" });
  await add.getByText("Ändern").click();
  const edit = page.getByRole("form", { name: "Spanisch speichern" });
  await edit.getByLabel("Lehrkraft").selectOption({ label: "Jana Brandt (BRA)" });
  await edit.getByLabel("Wochenstunden").fill("3");
  await edit.getByRole("button", { name: "Spanisch speichern" }).click();
  await expect(edit.getByRole("status")).toContainText("Gespeichert");
  await page.getByText("Wahl vom Papier-Wahlbogen eintragen").click();
  const papier = page.getByRole("form", { name: "Wahl eintragen" });
  await papier.getByLabel("Schüler:in").selectOption({ label: "Schäfer, Lea (7b)" });
  await papier.getByLabel("1. Wunsch").selectOption({ label: "Spanisch" });
  await papier.getByLabel("2. Wunsch").selectOption({ label: "Robotik" });
  await papier.getByRole("button", { name: "Wahl eintragen" }).click();
  await expect(papier.getByRole("status")).toContainText("abgegeben");
  await page.getByRole("form", { name: "Zuteilung" }).getByRole("button", { name: "Zuteilung berechnen" }).click();
  await expect(page.getByRole("form", { name: "Zuteilung" }).getByRole("status")).toContainText("berechnet");
  await expect(page.getByText("Übernehmen geht erst nach dem Wahlende.")).toBeVisible();
  // Wahl schließen
  const settings = page.getByRole("form", { name: "Wahlverfahren speichern" });
  await settings.getByLabel("Wahl ab").fill(ymd(-3));
  await settings.getByLabel("Wahl bis (einschließlich)").fill(ymd(-1));
  await settings.getByRole("button", { name: "Wahlverfahren speichern" }).click();
  await expect(settings.getByRole("status")).toContainText("Gespeichert");
  await page.goto(url);
  await expect(page.getByRole("list", { name: "Hinweise zur Übernahme" })).toContainText("49 ohne Kurs");
  const form = page.getByRole("form", { name: "Übernahme" });
  await form.getByRole("button", { name: "In Gruppen übernehmen" }).click();
  await expect(form.getByRole("alert")).toContainText("bitte ansehen und bestätigen");
  await form.getByLabel("Hinweise gesehen – trotzdem übernehmen").check();
  await form.getByRole("button", { name: "In Gruppen übernehmen" }).click();
  await expect(page.getByText("Übernommen – die Familien sehen jetzt ihren Kurs.")).toBeVisible();
  await expect(page.getByRole("row", { name: /7 Spanisch Jana Brandt 3 vorgeschlagen/ })).toBeVisible();
  // Anlegen der Lehraufträge prüft das Gate (zy-gate4d.spec.ts) – hier nicht, sonst ändert es die Diagnose in unterricht.spec
  // SP-03: das Sekretariat plant nicht – Lehraufträge legt die Stundenplanung an
  await expect(page.getByRole("button", { name: "Vorgeschlagene Lehraufträge anlegen" })).toHaveCount(0);
  await expect(page.getByText("Die vorgeschlagenen Lehraufträge legt die Stundenplanung an.")).toBeVisible();
  // die Gruppe steht in der Gruppenverwaltung, Leitung Jana Brandt
  await page.getByRole("link", { name: "7 Spanisch" }).click();
  await expect(page.getByRole("heading", { name: "7 Spanisch" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("P4-67: Mehrfachwahl – zwei AGs je Person, je Kurs eigene Wünsche, Übernahme in zwei Gruppen", async ({ page }) => {
  const errors = collectErrors(page);
  const ymd = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  await login(page, "sabine.kowalski");
  const url = await createVerfahren(page, "AG E2E-Mehrfach", [
    { title: "AG Schach", subject: "Informatik" },
    { title: "AG Chor", subject: "Kunst" },
    { title: "AG Robotik", subject: "Informatik" },
  ]);
  const settings = page.getByRole("form", { name: "Wahlverfahren speichern" });
  await settings.getByLabel("Wünsche je Kurs").selectOption("1");
  await settings.getByLabel("Kurse je Person: höchstens").selectOption("2");
  await settings.getByRole("button", { name: "Wahlverfahren speichern" }).click();
  await expect(settings.getByRole("status")).toContainText("Gespeichert");

  await page.getByText("Wahl vom Papier-Wahlbogen eintragen").click();
  const papier = page.getByRole("form", { name: "Wahl eintragen" });
  await papier.getByLabel("Schüler:in").selectOption({ label: "Schäfer, Lea (7b)" });
  await papier.getByRole("group", { name: "Kurs 1" }).getByLabel("1. Wunsch").selectOption({ label: "AG Schach" });
  await papier.getByRole("group", { name: "Kurs 2" }).getByLabel("1. Wunsch").selectOption({ label: "AG Schach" });
  await papier.getByRole("button", { name: "Wahl eintragen" }).click();
  await expect(papier.getByRole("alert")).toContainText("Jeden Kurs nur einmal als 1. Wunsch");
  await papier.getByRole("group", { name: "Kurs 2" }).getByLabel("1. Wunsch").selectOption({ label: "AG Chor" });
  await papier.getByRole("button", { name: "Wahl eintragen" }).click();
  await expect(papier.getByRole("status")).toContainText("abgegeben");
  await expect(page.getByRole("row", { name: /Schäfer, Lea 7b Kurs 1: AG Schach · Kurs 2: AG Chor gewählt/ })).toBeVisible();

  await page.getByRole("form", { name: "Zuteilung" }).getByRole("button", { name: "Zuteilung berechnen" }).click();
  await expect(page.getByRole("form", { name: "Zuteilung" }).getByRole("status")).toContainText("berechnet");
  await expect(page.getByRole("row").filter({ hasText: "Schäfer, Lea · Kurs 1" })).toContainText("AG Schach");
  await expect(page.getByRole("row").filter({ hasText: "Schäfer, Lea · Kurs 2" })).toContainText("AG Chor");

  await settings.getByLabel("Wahl ab").fill(ymd(-3));
  await settings.getByLabel("Wahl bis (einschließlich)").fill(ymd(-1));
  await settings.getByRole("button", { name: "Wahlverfahren speichern" }).click();
  await expect(settings.getByRole("status")).toContainText("Gespeichert");
  await page.goto(url);
  const form = page.getByRole("form", { name: "Übernahme" });
  await form.getByLabel("Hinweise gesehen – trotzdem übernehmen").check();
  await form.getByRole("button", { name: "In Gruppen übernehmen" }).click();
  await expect(page.getByText("Übernommen – die Familien sehen jetzt ihren Kurs.")).toBeVisible();
  await logoutForSwitch(page);

  await login(page, "daniela.schaefer");
  await page.goto("/kurswahl");
  const card = page.getByRole("article", { name: "AG E2E-Mehrfach – Lea Schäfer" });
  await expect(card.getByRole("status")).toContainText("AG Schach");
  await expect(card.getByRole("status")).toContainText("AG Chor");
  expect(errors).toEqual([]);
});
