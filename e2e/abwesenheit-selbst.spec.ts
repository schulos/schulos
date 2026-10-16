import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// P4-74 + Q5-12: Lehrkraft meldet sich krank (wirkt sofort) und beantragt eine Fortbildung (Schulleitung genehmigt), hinterlegt
// Material je Stunde; die Planung sieht „selbst gemeldet“. Am Ende zieht die Lehrkraft beides zurück (andere Specs bleiben unberührt).

/** nächster Montag (in mindestens 3 Tagen) als YYYY-MM-DD, plus `extra` Tage */
function nextMonday(extra = 0): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  let add = (8 - d.getUTCDay()) % 7 || 7;
  if (add < 3) add += 7;
  d.setUTCDate(d.getUTCDate() + add + extra);
  return d.toISOString().slice(0, 10);
}

test("P4-74/Q5-12: Lehrkraft meldet Abwesenheit, hinterlegt Material, Schulleitung genehmigt die Fortbildung", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const mo = nextMonday();
  const fr = nextMonday(4);
  const nextMo = nextMonday(7);

  await login(page, "jana.brandt");
  await page.getByRole("link", { name: "Abwesenheit melden" }).first().click();
  await expect(page).toHaveURL("/stundenplan/abwesenheit");
  const form = page.getByRole("form", { name: "Abwesenheit melden" });
  await form.getByLabel("Grund").selectOption({ label: "krank" });
  await form.getByLabel("von Tag").fill(mo);
  await form.getByLabel("bis Tag").fill(fr);
  await form.getByLabel("Ergänzung").fill("Grippe");
  await form.getByRole("button", { name: "Abwesenheit melden" }).click();
  await expect(form.getByRole("alert")).toContainText("keine Angaben zur Gesundheit");
  await form.getByLabel("Ergänzung").fill("");
  await form.getByRole("button", { name: "Abwesenheit melden" }).click();
  await expect(form.getByRole("status")).toContainText("Vertretungsplanung ist informiert");

  const lessons = page.getByRole("list", { name: "Betroffene Stunden" }).first();
  await expect(lessons.getByRole("listitem").first()).toBeVisible();
  const first = lessons.getByRole("listitem").first();
  if (!(await first.getByRole("form").isVisible())) await first.getByText("Material hinterlegen").click();
  const material = first.getByRole("form");
  await material.getByLabel("Arbeitsauftrag").fill("Buch S. 34, Nr. 1–4");
  await material.getByLabel("Schüler:innen dürfen es sehen").check();
  await material.getByRole("button", { name: "Material speichern" }).click();
  await expect(material.getByRole("status")).toContainText("Material gespeichert");
  await first.getByRole("link", { name: "Material ansehen" }).click();
  await expect(page.getByRole("article", { name: "Material" })).toContainText("Buch S. 34, Nr. 1–4");
  await page.goBack();

  // Fortbildung = Antrag
  await form.getByLabel("Grund").selectOption({ label: "Fortbildung" });
  await form.getByLabel("von Tag").fill(nextMo);
  await form.getByLabel("bis Tag").fill("");
  await form.getByLabel("Ergänzung").fill("Fortbildung Digitalisierung");
  await form.getByRole("button", { name: "Abwesenheit melden" }).click();
  await expect(form.getByRole("status")).toContainText("Antrag gestellt");
  await expect(page.getByText("beantragt", { exact: true })).toBeVisible();
  await logoutForSwitch(page);

  // Planung sieht die Selbstmeldung (ohne dass der Grund im Gong steht)
  await login(page, "sabine.kowalski");
  await page.goto(`/verwaltung/vertretungen?datum=${mo}`);
  await expect(page.getByRole("list", { name: "Abwesenheiten" })).toContainText("selbst gemeldet");
  await logoutForSwitch(page);

  // Schulleitung genehmigt
  await login(page, "petra.lindner");
  await page.goto("/stundenplan/abwesenheit");
  const antraege = page.getByRole("list", { name: "Offene Anträge" });
  await expect(antraege).toContainText("Jana Brandt");
  await antraege.getByRole("button", { name: /Genehmigen: Jana Brandt/ }).click();
  await expect(page.getByText("Keine offenen Anträge.")).toBeVisible();
  await logoutForSwitch(page);

  // aufräumen: beide Meldungen zurückziehen (beginnen erst in der Zukunft)
  await login(page, "jana.brandt");
  await page.goto("/stundenplan/abwesenheit");
  for (let i = 0; i < 2; i++) {
    page.once("dialog", (d) => void d.accept());
    await page
      .getByRole("button", { name: /^Zurückziehen:/ })
      .first()
      .click();
    await expect(page.getByRole("button", { name: /^Zurückziehen:/ })).toHaveCount(1 - i);
  }
  await expect(page.getByText("Keine Abwesenheit eingetragen")).toBeVisible();
  expect(errors).toEqual([]);
});
