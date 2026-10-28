import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// SP3-09a: Planen im Folgejahr – Jahreswahl im Kopf des Planungsbereichs. Die E2E-Demo hat nur 2026/27; die Spec legt 2027/28 an (Stammdaten,
// ohne Klassen – die entstehen erst mit der Versetzung, die die gemeinsame DB für spätere Specs verändern würde; Matrix/Lehraufträge/Pflege mit
// Klassen im Folgejahr deckt `planungsjahr.test.ts` ab) und löscht es am Ende wieder (Deputat im Folgejahr geht per Kaskade mit). Die Wahl ist
// ein Sitzungs-Cookie des Browser-Kontexts – andere Specs sehen sie nicht. Nichts hängt am Wochentag oder an der Uhrzeit.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const TEACHER = "u-jana.brandt";

async function axe(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(res.violations.map((v) => `${label}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function folgejahr(page: Page, action: "anlegen" | "loeschen") {
  await page.goto("/verwaltung/stammdaten?bereich=schuljahre");
  if (action === "anlegen") {
    await page.getByRole("button", { name: "Folgejahr anlegen" }).click();
    await expect(page.getByLabel("Name 2027/28")).toHaveValue("2027/28");
  } else if ((await page.getByRole("button", { name: "2027/28 löschen" }).count()) > 0) {
    await page.getByRole("button", { name: "2027/28 löschen" }).click();
    await expect(page.getByLabel("Name 2027/28")).toHaveCount(0);
  }
}

test("SP3-09a: Planungsjahr im Kopf wechseln, Matrix und Deputat im Folgejahr, laufendes Jahr unberührt (axe, 360 px dunkel)", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const admin = await browser.newContext();
  const sek = await admin.newPage();
  await login(sek, "sabine.kowalski");
  await folgejahr(sek, "anlegen");
  try {
    const errors = collectErrors(page);
    await login(page, "frank.schulte");
    await page.goto(`/planung/unterricht?ansicht=lehrkraefte&lehrkraft=${TEACHER}`);
    const bar = page.getByRole("region", { name: "Planungsjahr" });
    await expect(bar).toHaveAttribute("data-rolle", "laufend");
    await expect(bar).toContainText("Du planst das Schuljahr 2026/27 · laufendes Schuljahr");
    const before = await page.getByLabel("Pflichtstunden").inputValue();

    // Wechsel ins Folgejahr: Kennzeichnung im Kopf, Seite bleibt (Lehrkraft), Deputat des Folgejahrs ist noch leer
    await bar.getByLabel("Planungsjahr wählen").selectOption({ label: "2027/28 (Folgejahr)" });
    await bar.getByRole("button", { name: "Wechseln" }).click();
    await expect(page).toHaveURL(new RegExp(`/planung/unterricht\\?ansicht=lehrkraefte&lehrkraft=${TEACHER}$`));
    await expect(bar).toHaveAttribute("data-rolle", "folgejahr");
    await expect(bar).toContainText("Du planst das Schuljahr 2027/28 · Folgejahr");
    await expect(bar.getByTestId("planungsjahr-hinweis")).toContainText("das laufende Schuljahr 2026/27 bleibt unverändert");
    await expect(page.getByText(/^Schuljahr 2027\/28 · Lehraufträge/)).toBeVisible();
    await expect(page.getByTestId("folgejahr-ohne-klassen")).toContainText("noch keine Klassen");
    await expect(page.getByTestId("folgejahr-ohne-klassen").getByRole("link", { name: "Schuljahreswechsel" })).toHaveAttribute("href", "/verwaltung/schuljahreswechsel");
    await expect(page.getByRole("button", { name: /Aus Stundenplan übernehmen/ })).toHaveCount(0);
    await page.getByLabel("Pflichtstunden").fill("21");
    await page.getByRole("button", { name: "Pflichtstunden speichern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Gespeichert." })).toBeVisible();
    await expect(page.getByText("Soll 21", { exact: true }).first()).toBeVisible();

    // Matrix im Folgejahr: verständlicher Leerzustand mit Weg zur Versetzung; die Wahl bleibt beim Seitenwechsel erhalten
    await page.getByRole("link", { name: "Matrix", exact: true }).click();
    await expect(page.getByText("Noch keine Klassen im Schuljahr 2027/28", { exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByRole("link", { name: "Schuljahreswechsel" }).first()).toBeVisible();
    await expect(bar).toHaveAttribute("data-rolle", "folgejahr");
    await axe(page, "Matrix im Folgejahr");
    await page.screenshot({ path: ".data/shots/e2e/planung-folgejahr.png", fullPage: true });

    // Stundenplan-Pflege: ohne Entwurf fürs Folgejahr der Weg zur Vorlage „Neues Schuljahr“
    await page.goto("/planung/stundenplan");
    await expect(page.getByText("Noch kein Entwurf für 2027/28", { exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByRole("link", { name: "Planversionen" })).toHaveAttribute("href", "/planung/versionen#vorlagen");
    // SP3-09b: Automatisch planen folgt der Wahl – ohne Entwurf der Weg zur Vorlage; Seiten des Tagesgeschäfts arbeiten im laufenden Schuljahr und sagen es
    await page.goto("/planung/solver");
    await expect(page.getByText("Noch kein Entwurf für 2027/28", { exact: true })).toBeVisible();
    await expect(page.getByRole("form", { name: "Lauf starten" })).toHaveCount(0);
    await page.goto("/planung/aufsichten");
    await expect(bar.getByTestId("planungsjahr-hinweis")).toContainText("Diese Seite arbeitet immer im laufenden Schuljahr 2026/27");

    // 360 px, dunkel – derselbe Kontext (Cookie) im schmalen Fenster
    const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: "dark", isMobile: false, storageState: await page.context().storageState() });
    const p = await narrow.newPage();
    const pErrors = collectErrors(p);
    await p.goto("/planung/unterricht?ansicht=matrix");
    await expect(p.getByRole("region", { name: "Planungsjahr" })).toHaveAttribute("data-rolle", "folgejahr");
    await expect(p.getByText("Noch keine Klassen im Schuljahr 2027/28", { exact: true })).toBeVisible();
    expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await axe(p, "Matrix im Folgejahr 360 px dunkel");
    expect(pErrors).toEqual([]);
    await narrow.close();

    // zurück ins laufende Schuljahr: Deputat dort unverändert
    await page.goto(`/planung/unterricht?ansicht=lehrkraefte&lehrkraft=${TEACHER}`);
    await bar.getByLabel("Planungsjahr wählen").selectOption({ label: "2026/27 (laufendes Schuljahr)" });
    await bar.getByRole("button", { name: "Wechseln" }).click();
    await expect(bar).toHaveAttribute("data-rolle", "laufend");
    await expect(page.getByLabel("Pflichtstunden")).toHaveValue(before);
    await expect(page.getByTestId("folgejahr-ohne-klassen")).toHaveCount(0);
    await axe(page, "Lehrkraft im laufenden Schuljahr");
    expect(errors).toEqual([]);
  } finally {
    await folgejahr(sek, "loeschen");
    await admin.close();
  }
});
