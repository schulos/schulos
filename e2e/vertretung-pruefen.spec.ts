import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SP2-16b (Q-SP2-16 = b): Abwesenheit verkürzt → eingetragene (Dauer-)Vertretungen danach bleiben stehen, sind als
// „Abwesenheit beendet – prüfen“ markiert und lassen sich einzeln behalten bzw. alle mit einem Klick entfernen.

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

test("Abwesenheit verkürzt: Vertretungen danach markiert, behalten bzw. alle entfernen; aufräumen", async ({ page }) => {
  // zwei Dauervertretungen, Verkürzen, Prüfen und Aufräumen über eine Woche – mehr als die üblichen 30 s
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/vertretungen");
  const week = page.getByRole("list", { name: "Wochenblick" });
  const date = new URL((await week.getByRole("link").first().getAttribute("href"))!, "http://x").searchParams.get("datum")!;
  const until = addDays(date, 7);

  // KLE eine Woche krank
  await page.goto(`/planung/vertretungen?datum=${date}`);
  const form = page.getByRole("form", { name: "Abwesenheit eintragen" });
  await form.getByLabel("Lehrkraft", { exact: true }).selectOption({ label: "KLE – Tobias Kleine" });
  await form.getByLabel("Grund").selectOption({ label: "krank" });
  await form.getByLabel("bis Tag").fill(until);
  await form.getByRole("button", { name: "Abwesenheit eintragen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Abwesenheit eingetragen." })).toBeVisible();

  // Dauervertretung für die ersten beiden Stunden von KLE (erste Lehrkraft der Auswahl); die erste muss klappen
  const codes: string[] = [];
  for (const i of [0, 1]) {
    await page.goto(`/planung/vertretungen?datum=${date}&lehrkraft=u-tobias.kleine`);
    const lesson = page.getByRole("form", { name: /^\d+\. Std · / }).nth(i);
    if (!(await lesson.isVisible())) break;
    await lesson.getByRole("radio", { name: "Vertretung", exact: true }).check();
    const substitute = lesson.getByLabel("Vertretung durch");
    await substitute.selectOption({ index: 1 });
    codes.push(((await substitute.locator("option:checked").innerText()) ?? "").split(" – ")[0]!);
    await lesson.getByLabel(/^Dauervertretung: für alle Tage der Abwesenheit/).check();
    await lesson.getByRole("button", { name: "Speichern" }).click();
    const done = lesson.getByRole("status").filter({ hasText: /^Dauervertretung an \d+ Tag/ });
    if (i === 0) await expect(done).toBeVisible();
    else await expect(done.or(lesson.getByRole("alert"))).toBeVisible();
  }

  // KLE ist früher zurück: Ende auf den ersten Tag vorgezogen
  await page.goto(`/planung/vertretungen?datum=${date}`);
  await page.getByLabel("Neues Ende: Abwesenheit KLE").fill(date);
  await page.getByRole("list", { name: "Abwesenheiten" }).screenshot({ path: ".data/shots/e2e/abwesenheit-verkuerzen.png" });
  await page.getByRole("button", { name: "Abwesenheit KLE verkürzen" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Abwesenheit verkürzt – \d+ Änderung/ })).toBeVisible();
  const review = page.getByRole("article", { name: /^Abwesenheit beendet – prüfen/ });
  await expect(review).toBeVisible();
  const rows = review.locator("tbody tr");
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).include("article[aria-labelledby=review-title]").analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await review.screenshot({ path: ".data/shots/e2e/vertretung-pruefen.png" });

  // im Tagesplan danach steht die Vertretung weiter – mit Markierung
  const first = await rows.first().getByRole("link").getAttribute("href");
  await page.goto(first!);
  const day = page.getByRole("region", { name: /^Alle Änderungen am/ });
  await expect(day.getByText("Abwesenheit beendet – prüfen").first()).toBeVisible();

  // eine behalten (Markierung weg), den Rest mit einem Klick entfernen
  await review.getByRole("button", { name: /^Behalten: / }).first().click();
  if (count > 1) {
    await expect(rows).toHaveCount(count - 1);
    await review.getByRole("button", { name: "Alle entfernen" }).click();
  }
  await expect(review).toBeHidden();

  // aufräumen: Vertretungen der Woche und die Abwesenheit
  for (let d = date; d <= until; d = addDays(d, 1)) {
    await page.goto(`/planung/vertretungen?datum=${d}`);
    const changes = page.getByRole("region", { name: /^Alle Änderungen am/ });
    for (const code of codes)
      for (let n = 0; n < 10; n++) {
        const left = changes.getByRole("row").filter({ hasText: code });
        const c = await left.count();
        if (c === 0) break;
        await left.first().getByRole("button", { name: /^Aufheben/ }).click();
        await expect(changes.getByRole("row").filter({ hasText: code })).toHaveCount(c - 1);
      }
  }
  await page.goto(`/planung/vertretungen?datum=${date}`);
  await page.getByRole("button", { name: "Abwesenheit KLE aufheben" }).click();
  await expect(page.getByRole("button", { name: "Abwesenheit KLE aufheben" })).toBeHidden();
  expect(errors).toEqual([]);
});
