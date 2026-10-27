import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login, publishIfDraft, sendPlannedNow } from "./helpers";

// VT-04 (F-10-11): Vertretungsnachricht zur sinnvollen Zeit. Ein Entfall in drei Wochen wird veröffentlicht – die Nachricht ist dann
// für den Vortag 18:00 eingeplant („geplant für …“), die Schülerin hat noch keinen Gong. „jetzt senden“ (Schüler:innen und Eltern)
// schickt sie sofort; danach hat die Schülerin den Gong mit dem Endstand. Dazu axe auf der Planungsseite mit der Liste.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axeClean(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).include("main").withTags(TAGS).analyze();
  expect(
    r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`)),
    `axe-Befunde auf ${where}`,
  ).toEqual([]);
}

/** Dienstag in drei Wochen – weit weg von den Demo-Vertretungen und den Tagen anderer Specs */
function tuesdayInThreeWeeks(): string {
  const d = new Date();
  const wd = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - wd + 22);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("VT-04: Veröffentlichen plant die Nachricht für den Vortag 18:00 ein, „jetzt senden“ schickt sie sofort", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const NOTE = "VT04-E2E Arbeitsblatt";
  const date = tuesdayInThreeWeeks();
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto(`/planung/vertretungen?datum=${date}&gruppe=g-7b`);
  const form = page.getByRole("form", { name: /^\d+\. Std · / }).first();
  await expect(form).toBeVisible();
  await form.getByRole("radio", { name: "Entfall" }).check();
  await form.getByLabel("Hinweis für Schüler:innen").fill(NOTE);
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Gespeichert");
  await publishIfDraft(page);
  await expect(page.getByRole("status").filter({ hasText: "Veröffentlicht" })).toContainText("eingeplant");

  // „geplant für …“ – Vortag 18:00 (Vorgabe), getrennt nach Zielgruppe
  const planned = page.getByRole("list", { name: "Geplante Nachrichten" });
  const day = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: "Europe/Berlin" }).format(new Date(`${date}T12:00:00Z`));
  const students = planned.getByRole("listitem").filter({ hasText: day }).filter({ hasText: "Schüler:innen und Eltern" });
  await expect(students).toContainText(/geplant für .+, 18:00 Uhr/);
  await axeClean(page, "Vertretungen mit geplanten Nachrichten");
  await page.screenshot({ path: ".data/shots/e2e/vertretung-benachrichtigung.png", fullPage: true });

  // die Schülerin hat noch keine Nachricht zu dem Tag
  const ctx = await browser.newContext();
  const lea = await ctx.newPage();
  const leaErrors = collectErrors(lea);
  await login(lea, "lea.schaefer");
  await lea.getByRole("button", { name: /Gong/ }).click();
  await expect(lea.getByRole("dialog", { name: "Gong" })).toBeVisible();
  await expect(lea.getByText(NOTE)).toHaveCount(0);

  // jetzt senden (nur diese Zielgruppe) → Gong da, Eintrag weg
  await students.getByRole("button", { name: `Jetzt senden: ${day}, Schüler:innen und Eltern` }).click();
  await expect(page.getByRole("status").filter({ hasText: "Gesendet" })).toBeVisible();
  await expect(planned.getByRole("listitem").filter({ hasText: day }).filter({ hasText: "Schüler:innen und Eltern" })).toHaveCount(0);
  await lea.reload();
  await lea.getByRole("button", { name: /Gong/ }).click();
  await expect(lea.getByText(NOTE).first()).toBeVisible();

  // Rest (Lehrkräfte) ebenfalls senden, damit nachfolgende Specs eine leere Liste vorfinden
  await sendPlannedNow(page);
  expect([...errors, ...leaErrors]).toEqual([]);
  await ctx.close();
});
