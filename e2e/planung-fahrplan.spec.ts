import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { acknowledgeWarnings, approveVersion, collectErrors, login, publishVersionAt, undoAndDiscardVersion } from "./helpers";

// SP3-06: Planungsfahrplan-Durchlauf. Die Planung (frank.schulte) beginnt über die Übersicht mit der Vorlage „Änderung im laufenden Plan“
// (Folgeversion ab dem nächsten Schultag) → acht Schritte mit Ampel, Schritte 2–5 eingeklappt → Häkchen und Termin → Freigabe durch die
// Schulleitung → Veröffentlichen ist gesperrt, solange Warnungen nicht quittiert sind → Warnungen je Kategorie mit Begründung quittieren
// (eine zurücknehmen und wieder quittieren) → veröffentlichen → Schritt 8 erledigt → Korrektur-Protokoll → aufräumen. Übersicht und Fahrplan
// mit axe, schmal (360 px) und dunkel. Kein Bezug auf Wochentag oder Uhrzeit: der Stichtag kommt aus der Vorlage.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function axe(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).include("main").analyze();
  expect(res.violations.map((v) => `${label}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const toYmd = (de: string) => de.split(".").reverse().join("-");

test("SP3-06: Fahrplan „Änderung im laufenden Plan“ → Schritte → Quittieren als Bedingung → veröffentlichen", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");

  // Einstieg über die Übersicht: ohne offenen Entwurf führt die Kachel „Planungsfahrplan“ zu den Vorlagen
  await page.goto("/planung");
  await page.getByRole("navigation", { name: "Stundenplanung" }).getByRole("link", { name: "Fahrplan" }).click();
  await expect(page).toHaveURL(/\/planung\/fahrplan/);
  await expect(page.getByRole("heading", { name: "Planungsfahrplan", level: 1 })).toBeVisible();
  const more = page.getByText("Weitere Planung beginnen (Vorlagen)");
  if ((await more.count()) > 0) await more.click(); // ein anderer Entwurf ist offen – Vorlagen stehen eingeklappt darunter
  const template = page.locator("[data-vorlage=aenderung]");
  await expect(template).toBeVisible();
  await expect(page.locator("[data-vorlage=schuljahr]")).toContainText("Schuljahr");
  const offer = (await template.textContent())!.match(/Version (\d+\.\d+) ab (\d{2}\.\d{2}\.\d{4})/)!;
  const [, label, fromDe] = offer;
  const from = toYmd(fromDe!);
  await axe(page, "Fahrplan mit Vorlagen");
  await template.getByRole("button", { name: "Folgeversion anlegen" }).click();
  await expect(page).toHaveURL(/\/planung\/fahrplan\?version=[\w-]+&angelegt=1/);
  const versionId = new URL(page.url()).searchParams.get("version")!;
  await expect(page.getByRole("status")).toContainText(`Entwurf ${label}`);

  // acht Schritte, Status aus den Daten; bei der Änderung im laufenden Plan sind 2–5 eingeklappt
  const steps = page.locator("[data-schritt]");
  await expect(steps).toHaveCount(8);
  await expect(page.getByText("Bei einer Änderung im laufenden Plan meist unverändert – Einzelheiten zeigen")).toHaveCount(4);
  await expect(page.getByTestId("ampel-rahmen")).toContainText("erledigt");
  await expect(page.getByTestId("ampel-pruefen")).toContainText("offen");
  await expect(page.getByTestId("ampel-veroeffentlichen")).toContainText("offen");
  const step7 = page.locator("[data-schritt=pruefen]");
  await expect(step7.getByRole("link", { name: "Änderungen zum gültigen Plan" })).toHaveAttribute("href", `/planung/versionen/aenderungen?version=${versionId}`);
  await expect(step7.getByRole("link", { name: "Diagnose im Entwurf" })).toHaveAttribute("href", `/planung/unterricht?ansicht=diagnose&quelle=${versionId}`);

  // Häkchen (Schritt 5, eingeklappt) und optionaler Termin (Schritt 6)
  const step5 = page.locator("[data-schritt=wuensche]");
  await step5.getByText("Einzelheiten zeigen").click();
  await step5.getByRole("button", { name: "Raumsperren und Fixtermine geprüft" }).click();
  // nach dem Speichern ist der Schritt wieder eingeklappt (der Knopf liegt verborgen darin)
  await expect(page.locator("[data-schritt=wuensche]").getByRole("button", { name: "Raumsperren und Fixtermine geprüft", includeHidden: true })).toHaveAttribute("aria-pressed", "true");
  const step6 = page.locator("[data-schritt=setzen]");
  await step6.getByLabel("Termin (optional)").fill("2027-07-01");
  await step6.getByRole("button", { name: "Termin speichern" }).click();
  await expect(page.locator("[data-schritt=setzen]")).toContainText("bis 01.07.2027");

  // Übersicht: der Fahrplan ersetzt die Jahresplanung, solange ein Entwurf offen ist
  await page.goto("/planung");
  const region = page.getByRole("region", { name: "Planungsfahrplan" });
  await expect(region).toBeVisible();
  await expect(page.getByRole("region", { name: "Jahresplanung" })).toHaveCount(0);
  await expect(region.getByRole("list", { name: "Schritte des Fahrplans" }).getByRole("listitem")).toHaveCount(8);
  await axe(page, "Übersicht mit Fahrplan");

  // Prüfung und Freigabe (Schulleitung) – ohne Quittierung bleibt das Veröffentlichen gesperrt
  await approveVersion(page, browser, versionId, { acknowledge: false });
  await page.goto(`/planung/versionen/veroeffentlichen?version=${versionId}&ab=${from}`);
  await expect(page.getByTestId("fahrplan-sperre")).toContainText("nicht quittiert");
  await expect(page.getByRole("button", { name: /veröffentlichen$/ })).toHaveCount(0);
  await page.getByTestId("fahrplan-sperre").getByRole("link", { name: /Schritt 7/ }).click();
  await expect(page).toHaveURL(new RegExp(`/planung/fahrplan\\?version=${versionId}#schritt-pruefen$`));

  // quittieren: je Kategorie ein Formular mit Begründung; eine Quittierung zurücknehmen und wieder quittieren
  const forms = page.getByRole("form", { name: /quittieren$/ });
  expect(await forms.count()).toBeGreaterThan(0);
  const first = forms.first();
  await first.getByRole("button", { name: "Quittieren" }).click(); // Begründung fehlt → Browser verhindert das Absenden
  await expect(page).not.toHaveURL(/quittiert=/);
  await acknowledgeWarnings(page, versionId, "Mit der Schulleitung abgestimmt");
  await expect(page.getByTestId("ampel-pruefen")).not.toContainText("offen");
  const done = page.locator("[data-kategorie]").first();
  await done.getByText(/quittierte Warnung/).click();
  await expect(done).toContainText("„Mit der Schulleitung abgestimmt“");
  await done.getByRole("button", { name: "Zurücknehmen" }).first().click();
  await expect(page.getByTestId("ampel-pruefen")).toContainText("1 offen");
  await acknowledgeWarnings(page, versionId, "Doch in Ordnung");
  await expect(page.getByTestId("ampel-veroeffentlichen")).toContainText("Hinweise"); // bereit zum Veröffentlichen
  await page.screenshot({ path: ".data/shots/e2e/planung-fahrplan.png", fullPage: true });

  // 360 px, dunkel: Fahrplan als Liste ohne Überlauf
  const narrow = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: false, colorScheme: "dark", storageState: await page.context().storageState() });
  const p = await narrow.newPage();
  const pErrors = collectErrors(p);
  await p.goto(`/planung/fahrplan?version=${versionId}`);
  await expect(p.locator("[data-schritt]")).toHaveCount(8);
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await axe(p, "Fahrplan 360 px dunkel");
  await p.screenshot({ path: ".data/shots/e2e/planung-fahrplan-360-dunkel.png", fullPage: true });
  await p.goto("/planung");
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  expect(pErrors).toEqual([]);
  await narrow.close();

  // veröffentlichen ab dem Stichtag der Vorlage → Schritt 8 erledigt; die Übersicht zeigt wieder die Jahresplanung
  await publishVersionAt(page, versionId, from);
  await page.goto(`/planung/fahrplan?version=${versionId}`);
  await expect(page.getByTestId("ampel-veroeffentlichen")).toContainText("erledigt");
  await expect(page.locator("[data-schritt=veroeffentlichen]")).toContainText(`gültig ab ${fromDe}`);
  await page.goto("/planung");
  await expect(page.getByRole("region", { name: "Jahresplanung" })).toBeVisible();

  // Korrektur-Protokoll (Sofort-Korrekturen im gültigen Plan)
  await page.goto("/planung/versionen");
  await page.getByRole("link", { name: "Protokoll", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Korrektur-Protokoll", level: 1 })).toBeVisible();
  await axe(page, "Korrektur-Protokoll");

  // aufräumen: zurücknehmen und verwerfen
  await undoAndDiscardVersion(page, versionId);
  expect(errors).toEqual([]);
});
