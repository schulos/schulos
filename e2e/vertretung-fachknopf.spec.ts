import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// SP-12/SP-15: Vorschlag „→ <eigenes Fach>“ übernimmt Lehrkraft und Fach – auch das Formular der Stunde zeigt danach das
// neue Fach (vorher blieb dort das reguläre stehen, und „Speichern“ hätte den Fachtausch aufgehoben)
test("Vorschlag mit eigenem Fach: Lehrkraft und Fach übernommen, Formular zeigt das neue Fach", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  // der Demo-Plan kommt aus dem Solver – welche Stunde einen solchen Vorschlag hat, steht nicht fest
  const groups = ["g-5a", "g-5b", "g-6a", "g-6b", "g-7a", "g-7b", "g-8a", "g-8b", "g-9a", "g-9b", "g-10a", "g-10b"];
  for (let off = 0; off < 7; off++) {
    const d = new Date();
    d.setDate(d.getDate() + off);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    for (const g of groups) {
      await page.goto(`/planung/vertretungen?gruppe=${g}&datum=${ymd(d)}`);
      const button = page.getByRole("button", { name: / mit .+ übernehmen: / }).first();
      if ((await button.count()) === 0) continue;
      const [, code, subject, label] = / *(.+?) mit (.+) übernehmen: (.+)$/.exec((await button.getAttribute("aria-label"))!)!;
      await button.click();
      const form = page.getByRole("region", { name: /^Stunden am/ }).getByRole("form", { name: label, exact: true });
      await expect(form.getByLabel("Fach").locator("option:checked")).toHaveText(subject!);
      await expect(form.getByLabel("Vertretung durch").locator("option:checked")).toContainText(code!);
      await expect(page.getByRole("region", { name: /^Stunden am/ }).getByText(`→ ${subject}`).first()).toBeVisible();
      expect(errors).toEqual([]);
      return;
    }
  }
  throw new Error("kein Vorschlag mit eigenem Fach gefunden");
});
