import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "./axe";
import { createOpenVerfahren, fillAnmeldung, linkFromDevMail } from "./anmeldung-helpers";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// LO-01…03: Losverfahren bei Anmeldeüberhang – Schulleitung bildet die Losgruppe aus der Entscheidungsliste, Seed-Hash vor dem
// Ziehen, neu losen nur mit Begründung, Übernahme (Aufnahme + Warteliste mit Rang), Protokoll-Druck, Rechte. Am Handy (360 px,
// dunkel, axe inkl. Zielgröße). Das Ergebnis wird hier unabhängig nachgerechnet (SHA-256 + FNV-1a), nicht mit SchulOS-Code.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const MOBILE = { viewport: { width: 360, height: 800 }, colorScheme: "dark" as const };

async function axeClean(page: Page) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function noOverflow(page: Page) {
  const r = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    wide: [...document.querySelectorAll("main *")]
      .filter((e) => e.getBoundingClientRect().right > 361 && !e.closest(".overflow-x-auto, .overflow-auto, nav"))
      .slice(-5)
      .map((e) => `${e.tagName}.${String(e.className).slice(0, 60)} → ${Math.round(e.getBoundingClientRect().right)}: ${(e.textContent ?? "").slice(0, 50)}`),
  }));
  expect(r.width, r.wide.join(" | ")).toBeLessThanOrEqual(360);
}

async function anmelden(page: Page, id: string, first: string, ip: string) {
  const email = `${first.toLowerCase()}.lo01@example.org`;
  await fillAnmeldung(page, id, { first, last: "Losfeld", email, time: "14:00–14:30" }, { ip });
  const confirmPath = await linkFromDevMail(page, email, "/anmeldung/bestaetigen/");
  await page.goto(confirmPath);
  await page.getByRole("button", { name: "Anmeldung bestätigen" }).click();
  await expect(page).toHaveURL(/\/anmeldung\/vorgang\//);
  await logoutForSwitch(page);
}

/** Unabhängig nachgerechnet: FNV-1a 32 Bit über „Seed:Nummer“, aufsteigend, bei Gleichstand nach der Nummer. */
function recompute(seed: string, numbers: string[]): string[] {
  const fnv = (s: string) => {
    let h = 0x811c9dc5;
    for (const b of Buffer.from(s, "utf8")) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    return h >>> 0;
  };
  return [...numbers].sort((a, b) => fnv(`${seed}:${a}`) - fnv(`${seed}:${b}`) || (a < b ? -1 : 1));
}

test("LO-01…03: Losgruppe bilden, Seed-Hash vorab, neu losen mit Begründung, übernehmen, Wartelisten-Rang, Protokoll, Rechte", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const id = await createOpenVerfahren(page, "E2E Losverfahren Klasse 5", "2030-03-12", 3);
  await anmelden(page, id, "Lotta", "198.51.100.71");
  await anmelden(page, id, "Linus", "198.51.100.72");
  await anmelden(page, id, "Lene", "198.51.100.73");

  // Sekretariat: kein Losverfahren in der Liste
  await login(page, "sabine.kowalski");
  await page.goto(`/verwaltung/anmeldung/${id}/entscheidung`);
  await expect(page.getByRole("link", { name: "Losfeld, Lotta" })).toBeVisible();
  await expect(page.getByText("Losverfahren: Losgruppe aus der Auswahl bilden")).toHaveCount(0);
  await logoutForSwitch(page);

  // Schulleitung am Handy
  const ctx = await browser.newContext(MOBILE);
  const m = await ctx.newPage();
  const errors = collectErrors(m);
  await login(m, "petra.lindner");
  await m.goto(`/verwaltung/anmeldung/${id}/entscheidung`);
  const list = m.getByRole("form", { name: "Entscheidung" });
  await list.getByRole("checkbox", { name: "Alle auswählen" }).check();
  await list.getByText("Losverfahren: Losgruppe aus der Auswahl bilden").click();
  await list.getByLabel("Plätze für die Losgruppe").fill("1");
  await noOverflow(m);
  await axeClean(m);
  await list.getByRole("button", { name: "Losgruppe bilden (3)" }).click();
  await expect(m).toHaveURL(/\/los\/[^/]+$/);
  const firstLot = m.url();
  await expect(m.getByRole("heading", { name: "Lauf 1" })).toBeVisible();
  const hash1 = (await m.getByTestId("seed-hash").innerText()).trim();
  expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  await expect(m.getByTestId("seed")).toHaveCount(0);
  await noOverflow(m);
  await axeClean(m);

  // ziehen (Zeug:innen nur Funktionen) → Seed sichtbar, passt zum Hash
  await m.getByLabel("Anwesende Zeug:innen (nur Funktionen, optional)").fill("Stellv. Schulleitung, Elternvertretung");
  await m.getByRole("button", { name: "Los ziehen" }).click();
  await expect(m.getByTestId("seed")).toBeVisible();
  const seed1 = (await m.getByTestId("seed").innerText()).trim();
  expect(createHash("sha256").update(seed1).digest("hex")).toBe(hash1);
  await expect(m.getByTestId("verify")).toHaveText("Seed passt zum Prüfwert, Reihenfolge stimmt");

  // neu losen ohne Begründung geht nicht (Pflichtfeld), mit Begründung → neuer Lauf, alter bleibt
  const redo = m.getByRole("form", { name: "Neu losen oder verwerfen" });
  await redo.getByLabel("Begründung (Pflicht)").fill("Platzzahl geprüft – ein Platz war schon vergeben");
  await redo.getByRole("button", { name: "Neu losen" }).click();
  await expect(m.getByRole("heading", { name: "Lauf 2" })).toBeVisible();
  const hash2 = (await m.getByTestId("seed-hash").innerText()).trim();
  expect(hash2).not.toBe(hash1);
  await expect(m.getByText("Platzzahl geprüft – ein Platz war schon vergeben")).toBeVisible();
  await m.getByRole("button", { name: "Los ziehen" }).click();
  await expect(m.getByTestId("seed")).toBeVisible();
  const seed2 = (await m.getByTestId("seed").innerText()).trim();
  expect(createHash("sha256").update(seed2).digest("hex")).toBe(hash2);
  const result = m.getByRole("article", { name: "Ergebnis" });
  const numbers = (await result.locator("tbody tr td:nth-child(2)").allInnerTexts()).map((s) => s.trim());
  expect(numbers).toHaveLength(3);
  expect(numbers).toEqual(recompute(seed2, numbers));
  await expect(result.locator("tbody tr").first()).toContainText("Aufnahme");
  await expect(result.locator("tbody tr").nth(2)).toContainText("Warteliste, Rang 2");
  await noOverflow(m);
  await axeClean(m);

  // übernehmen
  await m.getByRole("button", { name: "Ergebnis übernehmen" }).click();
  await expect(m.getByRole("heading", { name: "Lauf 2" })).toBeVisible();
  await expect(m.getByText("Übernommen", { exact: true }).first()).toBeVisible();
  await expect(m.getByRole("button", { name: "Ergebnis übernehmen" })).toHaveCount(0);
  await expect(result.locator("tbody tr").nth(1)).toContainText("Rang 1");

  // Entscheidungsliste: Rang auf der Warteliste, beide Läufe in der Übersicht
  await m.goto(`/verwaltung/anmeldung/${id}/entscheidung`);
  const lots = m.getByRole("article", { name: "Losverfahren" });
  await expect(lots.getByRole("listitem").filter({ hasText: "Lauf 1" })).toContainText("Verworfen");
  await expect(lots.getByRole("listitem").filter({ hasText: "Lauf 2" })).toContainText("Übernommen");
  await expect(m.getByRole("form", { name: "Entscheidung" }).getByRole("row").filter({ hasText: numbers[2]! })).toContainText("Rang 2");
  await noOverflow(m);
  await axeClean(m);

  await m.goto("/verwaltung/protokoll");
  await expect(m.getByText("Schulanmeldung: Losergebnis übernommen (Aufnahme/Warteliste)").first()).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();

  // Sekretariat: liest Lauf und Protokoll, handelt nicht
  await login(page, "sabine.kowalski");
  const lotPath = new URL(firstLot).pathname;
  await page.goto(lotPath);
  await expect(page.getByRole("heading", { name: "Lauf 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Los ziehen|Neu losen|Ergebnis übernehmen|Lauf verwerfen/ })).toHaveCount(0);
  const lotId = lotPath.split("/").at(-1)!;
  // Protokoll-Druck (A4, am Rechner) mit Namen aus den Anträgen, Seed, Rangliste und Begründung
  await page.getByRole("link", { name: "Protokoll drucken" }).click();
  await expect(page.getByRole("heading", { name: "Losprotokoll – Lauf 1" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText(seed1);
  await expect(page.getByRole("main")).toContainText("Losfeld, Lotta");
  await expect(page.getByRole("main")).toContainText("Platzzahl geprüft");
  await expect(page.getByRole("main")).toContainText("Stellv. Schulleitung, Elternvertretung");
  await axeClean(page);
  await logoutForSwitch(page);

  // Lehrkraft: weder Lauf noch Protokoll
  await login(page, "jana.brandt");
  expect((await page.goto(lotPath))?.status()).toBe(404);
  expect((await page.goto(`/druck/anmeldung-los/${lotId}`))?.status()).toBe(404);
});
