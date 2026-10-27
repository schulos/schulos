import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SP2-07 (SP-G-08): Vertretung Stufe 2 – Verlegung, Zusammenlegung, Bereitschaft mit dem Planungs-Login.

async function axe(page: Page, what: string) {
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  expect(res.violations.map((v) => `${what} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const lessonForms = (page: Page) => page.getByRole("form", { name: /^\d+\. Std · .+ · Klasse 7b$/ });
const periodOf = async (form: ReturnType<typeof lessonForms>) => Number(((await form.getAttribute("aria-label")) ?? "").split(".")[0]);

test.describe("Stundenplanung · Vertretung Stufe 2 (SP2-07)", () => {
  test("Verlegung auf die ausgefallene Stunde, Zusammenlegung, aufheben; Bereitschaft eintragen; A11Y hell/dunkel/schmal", async ({ page, browser }) => {
    const errors = collectErrors(page);
    await login(page, "frank.schulte");
    // nächster Schultag (Vorgabe der Seite), Stunden der 7b
    await page.goto("/planung/vertretungen?gruppe=g-7b");
    const forms = lessonForms(page);
    await expect(forms.first()).toBeVisible();
    const count = await forms.count();
    expect(count).toBeGreaterThan(2);
    const first = forms.first();
    const firstPeriod = await periodOf(first);
    // Raum der ausfallenden Stunde (Kopfzeile der Karte: „Klasse 7b · KLE · R 106“) – dort findet die verlegte Stunde statt
    const firstRoom = /· R (\S+)/.exec((await first.locator("xpath=..").innerText()) ?? "")?.[1] ?? "";

    // 1. Stunde des Tages entfällt …
    await first.getByRole("radio", { name: "Entfall" }).check();
    await first.getByRole("button", { name: "Speichern" }).click();
    await expect(lessonForms(page).first().getByRole("status")).toContainText("Gespeichert");

    // … eine spätere Stunde rückt nach vorn (die erste, deren Lehrkraft und Raum frei sind)
    let moved = "";
    for (let i = count - 1; i > 0 && !moved; i--) {
      const f = lessonForms(page).nth(i);
      await f.getByRole("radio", { name: "Verlegung" }).check();
      await f.getByLabel("Verlegen in").selectOption(String(firstPeriod));
      if (firstRoom) await f.getByLabel("Raum", { exact: true }).selectOption(firstRoom);
      await f.getByRole("button", { name: "Speichern" }).click();
      const done = f.getByRole("status").or(f.getByRole("alert"));
      await expect(done).toBeVisible();
      if ((await f.getByRole("status").count()) > 0) moved = (await f.getAttribute("aria-label")) ?? "";
    }
    expect(moved).not.toBe("");
    const day = page.getByRole("region", { name: /^Alle Änderungen am/ });
    await page.reload();
    await expect(day.getByText(`Verlegung aus der ${await periodOf(page.getByRole("form", { name: moved }))}. Std.`)).toBeVisible();
    await expect(day.getByText(`verlegt in die ${firstPeriod}. Std.`)).toBeVisible();
    // die ausgefallene Stunde kann nicht mehr einfach stattfinden
    const firstAgain = lessonForms(page).first();
    await firstAgain.getByRole("radio", { name: "Vertretung", exact: true }).check();
    await firstAgain.getByLabel("Vertretung durch").selectOption({ index: 1 });
    await firstAgain.getByRole("button", { name: "Speichern" }).click();
    await expect(firstAgain.getByText(/erst die Verlegung aufheben/).first()).toBeVisible();
    await page.screenshot({ path: ".data/shots/e2e/vertretung-verlegung.png", fullPage: true });

    // A11Y: Seite mit offenen Verlegungs-/Zusammenlegungsfeldern, hell und dunkel
    await page.reload();
    await lessonForms(page).nth(1).getByRole("radio", { name: "Zusammenlegung" }).check();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await axe(page, `Vertretungen (${scheme})`);
    }
    await page.emulateMedia({ colorScheme: "light" });

    // Zusammenlegung: eine Stunde, zu der eine andere Gruppe zur selben Zeit Unterricht hat
    let merged = false;
    for (let i = 1; i < count && !merged; i++) {
      const f = lessonForms(page).nth(i);
      const label = (await f.getAttribute("aria-label")) ?? "";
      if (label === moved) continue;
      await f.getByRole("radio", { name: "Zusammenlegung" }).check();
      const options = await f.getByLabel("Zusammenlegen mit").locator("option").count();
      if (options < 2) continue;
      await f.getByLabel("Zusammenlegen mit").selectOption({ index: 1 });
      await f.getByRole("button", { name: "Speichern" }).click();
      await expect(f.getByRole("status").or(f.getByRole("alert"))).toBeVisible();
      merged = (await f.getByRole("status").count()) > 0;
    }
    expect(merged).toBe(true);
    await page.reload();
    await expect(day.getByText(/^Zusammenlegung mit /).first()).toBeVisible();

    // Aufheben: Zusammenlegung, Verlegung, Entfall – danach keine Änderungen der 7b
    for (let n = 0; n < 6 && (await day.getByRole("button", { name: /^Aufheben: Klasse 7b/ }).count()) > 0; n++) {
      // zuerst alles außer dem Entfall (der ist gesperrt, solange die Verlegung steht)
      const rows = day.getByRole("row").filter({ hasNotText: "Entfall" });
      const target = (await rows.getByRole("button", { name: /^Aufheben: Klasse 7b/ }).count()) > 0 ? rows : day.getByRole("row");
      const before = await day.getByRole("button", { name: /^Aufheben: Klasse 7b/ }).count();
      await target.getByRole("button", { name: /^Aufheben: Klasse 7b/ }).first().click();
      await expect.poll(() => day.getByRole("button", { name: /^Aufheben: Klasse 7b/ }).count()).toBeLessThan(before);
    }
    await expect(day.getByRole("button", { name: /^Aufheben: Klasse 7b/ })).toHaveCount(0);

    // Bereitschaft: Seite, eintragen (erste Stunde, in der BRA nicht unterrichtet), entfernen
    await page.getByRole("link", { name: "Bereitschaften" }).click();
    await expect(page.getByRole("heading", { name: "Bereitschaften", level: 1 })).toBeVisible();
    const form = page.getByRole("form", { name: "Bereitschaft eintragen" });
    const periods = await form.getByLabel("Stunde").locator("option").count();
    let added = false;
    for (let p = periods - 1; p >= 0 && !added; p--) {
      await form.getByLabel("Lehrkraft").selectOption({ label: "BRA – Jana Brandt" });
      await form.getByLabel("Wochentag").selectOption("4");
      await form.getByLabel("Stunde").selectOption({ index: p });
      await form.getByRole("button", { name: "Eintragen" }).click();
      await expect(form.getByRole("status").or(form.getByRole("alert"))).toBeVisible();
      added = (await form.getByRole("status").count()) > 0;
    }
    expect(added).toBe(true);
    const remove = page.getByRole("button", { name: /^Bereitschaft BRA Freitag \d+\. Std entfernen$/ });
    await expect(remove).toBeVisible();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await axe(page, `Bereitschaften (${scheme})`);
    }
    await page.emulateMedia({ colorScheme: "light" });

    // schmal (Mobil): Seite scrollt nicht seitlich
    const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, storageState: await page.context().storageState() });
    const p = await narrow.newPage();
    for (const path of ["/planung/vertretungen/bereitschaft", "/planung/vertretungen?gruppe=g-7b"]) {
      await p.goto(path);
      await p.waitForLoadState("load");
      // kein seitliches Scrollen (Tabellen scrollen im Rahmen; `sr-only`-Spaltenköpfe ragten vor SP2-11 aus ihm heraus)
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
      await axe(p, `${path} (360 px)`);
    }
    await p.screenshot({ path: ".data/shots/e2e/vertretung-bereitschaft-360.png", fullPage: true });
    await narrow.close();

    await remove.click();
    await expect(remove).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Bereitschaften sind Personaldienst: ohne `stundenplan.substitute` 404", async ({ page }) => {
    await login(page, "jana.brandt");
    const res = await page.goto("/planung/vertretungen/bereitschaft");
    expect(res?.status()).toBe(404);
  });
});
