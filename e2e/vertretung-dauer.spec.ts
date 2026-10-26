import AxeBuilder from "@axe-core/playwright";
// Läuft nach freigabe-vertretungsplan/gate2*: die Vertretungen machen die Tage im Modus „Freigabe“ zu Entwürfen.
import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SP2-08 (SP-G-09, SP-G-10): Dauervertretung für den Zeitraum einer Abwesenheit, Vertretungsbedarf im Wochenblick.

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

test("Dauervertretung: Lehrkraft eine Woche krank → Vertretung einmal für alle Tage; Wochenblick; aufräumen", async ({ page, browser }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/vertretungen");
  // Wochenblick: fünf Schultage
  const week = page.getByRole("list", { name: "Wochenblick" });
  await expect(week.getByRole("listitem")).toHaveCount(5);
  const date = new URL((await week.getByRole("link").first().getAttribute("href"))!, "http://x").searchParams.get("datum")!;
  const until = addDays(date, 7);

  // BRA eine Woche krank
  await page.goto(`/planung/vertretungen?datum=${date}`);
  const form = page.getByRole("form", { name: "Abwesenheit eintragen" });
  await form.getByLabel("Lehrkraft", { exact: true }).selectOption({ label: "BRA – Jana Brandt" });
  await form.getByLabel("Grund").selectOption({ label: "krank" });
  await form.getByLabel("bis Tag").fill(until);
  await form.getByRole("button", { name: "Abwesenheit eintragen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Abwesenheit eingetragen." })).toBeVisible();
  await expect(week.getByText(/\d+ offen/).first()).toBeVisible();

  // erste Stunde von BRA: Vertretung als Dauervertretung (erste freie Lehrkraft)
  await page.goto(`/planung/vertretungen?datum=${date}&lehrkraft=u-jana.brandt`);
  const lesson = page.getByRole("form", { name: /^\d+\. Std · / }).first();
  await expect(lesson).toBeVisible();
  await lesson.getByLabel("Art").selectOption("substitute");
  const substitute = lesson.getByLabel("Vertretung durch");
  await substitute.selectOption({ index: 1 });
  const code = ((await substitute.locator("option:checked").innerText()) ?? "").split(" – ")[0]!;
  const permanent = lesson.getByLabel(/^Dauervertretung: für alle Tage der Abwesenheit/);
  await expect(permanent).toBeVisible();
  await permanent.check();
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await lesson.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Dauervertretung an \d+ Tag/ })).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/dauervertretung.png", fullPage: true });

  // dunkel und schmal: Wochenblick ohne seitliches Scrollen, A11Y
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark", storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  await p.goto(`/planung/vertretungen?datum=${date}`);
  await expect(p.getByRole("list", { name: "Wochenblick" })).toBeVisible();
  const res = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).include("section[aria-labelledby=week-title]").analyze();
  expect(res.violations.map((v) => v.id)).toEqual([]);
  const box = await p.getByRole("list", { name: "Wochenblick" }).boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  await narrow.close();

  // aufräumen: Vertretungen dieser Lehrkraft an allen Tagen bis „bis“, dann die Abwesenheit
  for (let d = date; d <= until; d = addDays(d, 1)) {
    await page.goto(`/planung/vertretungen?datum=${d}`);
    const day = page.getByRole("region", { name: /^Alle Änderungen am/ });
    for (let n = 0; n < 10; n++) {
      const rows = day.getByRole("row").filter({ hasText: code });
      const count = await rows.count();
      if (count === 0) break;
      await rows.first().getByRole("button", { name: /^Aufheben/ }).click();
      await expect(day.getByRole("row").filter({ hasText: code })).toHaveCount(count - 1);
    }
  }
  await page.goto(`/planung/vertretungen?datum=${date}`);
  await page.getByRole("button", { name: "Abwesenheit BRA aufheben" }).click();
  await expect(page.getByText("Für diesen Tag ist keine Abwesenheit eingetragen.")).toBeVisible();
  expect(errors).toEqual([]);
});
