import { expect, test } from "@playwright/test";
import AxeBuilder from "./axe";
import { createOpenVerfahren, fillAnmeldung, linkFromDevMail } from "./anmeldung-helpers";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// KB-04: Klassenbildung im Schritt „Neuaufnahmen“ – Wünsche und „getrennt“ im Vorgang erfassen, Vorschlag mit Begründung und
// Kennzahlen, Festpinnen, „Neu vorschlagen“, Mehrlinge zusammen bzw. getrennt. Wie zz-gate4c läuft der Test durch einen ganzen
// Schuljahreswechsel und verändert die gemeinsame E2E-DB (ein weiteres Schuljahr). Darum liegt die Datei hinter zz-gate4c und
// ist wiederholbar: Zieljahr und Wechsel werden jedes Mal aus dem Stand der DB abgeleitet, E-Mail-Adressen tragen einen
// Lauf-Marker, der Wechsel wird am Ende abgeschlossen.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

test("KB-04: Wünsche und „getrennt“ erfassen → Vorschlag mit Begründung, Festpinnen, Neu vorschlagen, Mehrlinge", async ({ page }) => {
  test.setTimeout(420_000);
  const run = Date.now().toString(36);
  const net = 1 + Math.floor(Math.random() * 250); // eigenes Anfrage-Kontingent je Lauf (11. Einreichung je IP wird abgewiesen)
  const errors = collectErrors(page);

  // Zieljahr: das Folgejahr des aktuellen Schuljahrs (anlegen, falls es fehlt)
  await login(page, "petra.lindner");
  await page.goto("/verwaltung/schuljahreswechsel");
  const create = page.getByRole("button", { name: "Folgejahr anlegen" });
  if (await create.isVisible()) await create.click();
  await expect(page.getByRole("button", { name: "Schuljahreswechsel starten" })).toBeVisible();
  const label = (await page.getByLabel("Neues Schuljahr").locator("option:checked").innerText()).trim();
  const year = /^\d{4}\/\d{2}/.exec(label)![0];
  await logoutForSwitch(page);

  // Anträge: Zwillinge (gleiche E-Mail), Zwillinge, die getrennt werden sollen, zwei Kinder mit Wunsch
  const id = await createOpenVerfahren(page, `E2E Klassenbildung ${run}`, "2030-05-06", 6, year);
  const familien = [
    { email: `zwillinge.${run}.kb04@example.org`, kinder: ["Zoe", "Zeno"] },
    { email: `getrennt.${run}.kb04@example.org`, kinder: ["Vera", "Veit"] },
    { email: `paula.${run}.kb04@example.org`, kinder: ["Paula"] },
    { email: `pit.${run}.kb04@example.org`, kinder: ["Pit"] },
  ];
  let n = 0;
  for (const f of familien)
    for (const first of f.kinder) {
      n++;
      await fillAnmeldung(page, id, { first, last: "Klassenbild", email: f.email, time: "14:00–14:30" }, { ip: `198.18.${net}.${n}`, birth: `${Number(year.slice(0, 4)) - 11}-03-14` });
    }
  for (const f of familien)
    for (let i = 0; i < f.kinder.length; i++) {
      const path = await linkFromDevMail(page, f.email, "/anmeldung/bestaetigen/", i);
      await page.goto(path);
      await page.getByRole("button", { name: "Anmeldung bestätigen" }).click();
      await expect(page).toHaveURL(/\/anmeldung\/vorgang\//);
      await logoutForSwitch(page);
    }

  // Sekretariat: Wunsch „zusammen“ Paula–Pit; Zwillinge Vera/Veit „getrennt“; Zoe/Zeno bleiben bei der Vorgabe (zusammen)
  await login(page, "sabine.kowalski");
  const open = async (name: string) => {
    await page.goto(`/verwaltung/anmeldung/${id}/antraege`);
    await page.getByRole("link", { name: `Klassenbild, ${name}` }).click();
    return page.getByRole("article", { name: "Klassenwünsche" });
  };
  let kw = await open("Paula");
  const wish = kw.getByRole("form", { name: "Klassenwunsch erfassen" });
  await expect(wish.getByRole("textbox")).toHaveCount(0); // keine Begründung
  await wish.getByLabel("Wunsch").selectOption("zusammen");
  const pit = await wish.getByLabel("Kind").locator("option", { hasText: "Klassenbild, Pit" }).getAttribute("value");
  await wish.getByLabel("Kind").selectOption(pit!);
  await wish.getByRole("button", { name: "Wunsch speichern" }).click();
  await expect(kw.getByRole("list", { name: "Wünsche" })).toContainText("zusammen mit Klassenbild, Pit");
  kw = await open("Zoe");
  await expect(kw.getByRole("form", { name: "Familie getrennt" }).getByRole("checkbox")).not.toBeChecked();
  kw = await open("Vera");
  const sep = kw.getByRole("form", { name: "Familie getrennt" });
  await sep.getByRole("checkbox").check();
  await sep.getByRole("button", { name: "Speichern" }).click();
  await expect(sep.getByRole("status")).toHaveText("Gespeichert.");
  await logoutForSwitch(page);

  // Schulleitung: alle aufnehmen
  await login(page, "petra.lindner");
  await page.goto(`/verwaltung/anmeldung/${id}/entscheidung`);
  const list = page.getByRole("form", { name: "Entscheidung" });
  await list.getByRole("checkbox", { name: "Alle auswählen" }).check();
  await list.getByRole("button", { name: "Aufnehmen" }).click();
  await expect(list.getByRole("status")).toContainText("6 Anträge entschieden");

  // Schuljahreswechsel bis „Neuaufnahmen“
  await page.goto("/verwaltung/schuljahreswechsel");
  await page.getByRole("button", { name: "Schuljahreswechsel starten" }).click();
  await page.getByRole("button", { name: "Versetzung durchführen" }).click();
  const form = page.getByRole("form", { name: "Neuaufnahmen" });
  await expect(form).toBeVisible();
  await expect(form.getByRole("table", { name: "Zuordnung" })).toContainText("Klassenbild, Zoe");

  // zwei Klassen, neu vorschlagen → Größen 3/3, Zwillinge zusammen, getrennte Zwillinge getrennt, Wunsch erfüllt
  await form.getByRole("textbox", { name: /Neue Klassen/ }).fill(`5${run.slice(-3)}a, 5${run.slice(-3)}b`);
  const kennzahlen = form.getByRole("region", { name: "Kennzahlen je Klasse" });
  await kennzahlen.getByRole("button", { name: "Neu vorschlagen" }).click();
  await expect(kennzahlen.getByTestId("vorschlag-info")).toContainText("Vorschlag 2");
  const cls = async (name: string) => form.getByLabel(`Klasse für Klassenbild, ${name}`).inputValue();
  const check = async () => {
    const c = Object.fromEntries(await Promise.all(["Zoe", "Zeno", "Vera", "Veit", "Paula", "Pit"].map(async (k) => [k, await cls(k)] as const)));
    expect(c.Zoe).toMatch(/^5/);
    expect(c.Zeno).toBe(c.Zoe);
    expect(c.Vera).not.toBe(c.Veit);
    expect(c.Pit).toBe(c.Paula);
    return c;
  };
  await check();
  const rows = kennzahlen.getByRole("table").first().locator("tbody tr");
  await expect(rows).toHaveCount(2);
  for (const r of await rows.all()) await expect(r.locator("td").nth(1)).toHaveText("3");
  await expect(kennzahlen.getByRole("table").first()).toContainText("Wünsche erfüllt");
  await expect(kennzahlen.getByRole("table").first()).toContainText("1 / 1");

  // Begründung je Kind: Familie zusammen bzw. „getrennt“, Wunsch erfüllt
  await expect(form.getByRole("list", { name: "Begründung für Klassenbild, Zoe" })).toContainText("Familie zusammen (mit Klassenbild, Zeno)");
  await expect(form.getByRole("list", { name: "Begründung für Klassenbild, Vera" })).toContainText("Familie als „getrennt“ markiert: Geschwister in anderer Klasse");
  await expect(form.getByRole("list", { name: "Begründung für Klassenbild, Paula" })).toContainText("Wunsch „zusammen“ mit Klassenbild, Pit");
  await expect(form.getByRole("list", { name: "Begründung für Klassenbild, Paula" })).toContainText("erfüllt");

  // Festpinnen: Zoe bleibt beim Neu vorschlagen stehen, die Regeln gelten weiter
  const before = await cls("Zoe");
  await form.getByLabel("Festpinnen: Klassenbild, Zoe").check();
  await expect(kennzahlen.getByTestId("vorschlag-info")).toContainText("1 festgepinnt");
  await kennzahlen.getByRole("button", { name: "Neu vorschlagen" }).click();
  await expect(kennzahlen.getByTestId("vorschlag-info")).toContainText("Vorschlag 3");
  expect(await cls("Zoe")).toBe(before);
  await check();
  const a11y = await new AxeBuilder({ page }).include('form[aria-label="Neuaufnahmen"]').withTags(TAGS).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((nd) => nd.target.join(" ")).join(", ")}`)).toEqual([]);

  // Übernehmen und den Wechsel abschließen (die E2E-DB bleibt für einen weiteren Lauf benutzbar)
  await page.getByRole("button", { name: "Neuaufnahmen übernehmen" }).click();
  await expect(page.getByRole("status")).toContainText("6 Kinder in 2 Klassen übernommen");
  await page.getByRole("link", { name: "Weiter zum nächsten Schritt" }).click();
  // je nach Stand der DB gibt es Klassenbücher zu exportieren (erster Lauf) oder nicht
  for (let guard = 0; guard < 40; guard++) {
    const next = page.getByRole("button", { name: "Archivexport herunterladen" }).first();
    if (!(await next.isVisible())) break;
    const [d] = await Promise.all([page.waitForEvent("download"), next.click()]);
    await d.path();
    await page.goto("/verwaltung/schuljahreswechsel");
  }
  await page.getByRole("button", { name: /^Gruppen von .* archivieren$/ }).click();
  await page.getByLabel("Löschprotokoll, Löschsperren und nicht übergebene Archivexporte sind geprüft.").check();
  await page.getByRole("button", { name: "Geprüft" }).click();
  await page.getByRole("button", { name: "Schuljahreswechsel abschließen" }).click();
  await expect(page.getByText(`Neues Schuljahr nach ${year}`)).toBeVisible();
  expect(errors).toEqual([]);
});
