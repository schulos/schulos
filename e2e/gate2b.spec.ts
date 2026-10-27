import { expect, test } from "@playwright/test";
import { collectErrors, login, publishIfDraft } from "./helpers";

// Gate 2b – Stunden- und Raumplanung im Zusammenspiel: Abwesenheit → offene Stunden → Vertretungsvorschlag →
// Lehrerzimmer-Monitor; Raumsperrung → Ausweichraum-Vorschlag.
test("Gate 2b – Lehrkraft krank → offene Stunden → Vorschlag übernehmen → Monitor zeigt die Vertretung; Raumsperrung → Raumvorschlag", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await login(page, "frank.schulte");

  // 1. Lehrkraft krank melden
  await page.goto("/planung/vertretungen");
  const form = page.getByRole("form", { name: "Abwesenheit eintragen" });
  await form.getByLabel("Lehrkraft", { exact: true }).selectOption({ label: "BRA – Jana Brandt" });
  await form.getByLabel("Grund").selectOption({ label: "krank" });
  await form.getByRole("button", { name: "Abwesenheit eintragen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Abwesenheit eingetragen." })).toBeVisible();

  // 2. offene Stunden → zur Stunde → bester Vorschlag mit Begründung übernehmen
  const open = page.getByRole("table", { name: "Offene Stunden abwesender Lehrkräfte" });
  const firstOpen = open.getByRole("row").filter({ hasText: "offen" }).first();
  const period = (await firstOpen.getByRole("cell").first().textContent())!.trim(); // „3.“
  const groupName = (await firstOpen.getByRole("cell").nth(1).textContent())!.trim();
  await firstOpen.getByRole("link", { name: "Vertretung eintragen" }).click();
  await expect(page).toHaveURL(/lehrkraft=u-jana\.brandt/);
  const suggestions = page.getByRole("group", { name: new RegExp(`^Vorschläge: ${period.replace(".", "\\.")} Std · .* · ${groupName}$`) });
  await expect(suggestions.getByText(/Punkte$/).first()).toBeVisible();
  const best = suggestions.getByRole("button", { name: /übernehmen/ }).first();
  const code = (await best.textContent())!.replace(/ (mit .+ )?übernehmen$/, "").trim();
  await best.click();
  await expect(open.getByRole("row").filter({ hasText: groupName }).filter({ hasText: period }).getByText("Vertretung")).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/gate2b-vertretung.png", fullPage: true });
  // Q5-11: Demo-Schule mit Freigabe – erst veröffentlichen, dann zeigt der Monitor die Vertretung
  await publishIfDraft(page);

  // 3. Lehrerzimmer-Monitor zeigt die Vertretung (wer für wen)
  await page.goto("/monitor/demo-lehrerzimmer-lindenhof-2026");
  const row = page
    .getByRole("row")
    .filter({ hasText: groupName.replace(/^Klasse /, "") })
    .filter({ hasText: "BRA" })
    .filter({ hasText: code });
  await expect(row.first()).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/gate2b-monitor.png" });

  // 4. Raumsperrung → betroffene Stunden mit Ausweichraum → übernehmen
  await page.goto("/stundenplan/raeume?ansicht=sperrungen");
  const block = page.getByRole("form", { name: "Raum sperren" });
  await block.getByLabel("Raum").selectOption("106");
  await block.getByLabel("bis Tag").fill(new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10));
  await block.getByLabel("Grund").selectOption({ label: "Renovierung" });
  await block.getByRole("button", { name: "Raum sperren" }).click();
  const affected = page.getByRole("table", { name: "Stunden in gesperrten Räumen" });
  const before = await affected.getByText("verlegt", { exact: true }).count();
  await affected
    .getByRole("button", { name: /verlegen$/ })
    .first()
    .click();
  await expect(affected.getByText("verlegt", { exact: true })).toHaveCount(before + 1);
  await page.screenshot({ path: ".data/shots/e2e/gate2b-raumsperrung.png", fullPage: true });

  // aufräumen: Sperrung und Abwesenheit aufheben (Vertretung/Raumänderung bleiben als Änderungen stehen)
  await page.getByRole("button", { name: "Sperrung 106 aufheben" }).click();
  await expect(page.getByText("Keine Sperrungen")).toBeVisible();
  await page.goto("/planung/vertretungen");
  await page.getByRole("button", { name: "Abwesenheit BRA aufheben" }).click();
  await expect(page.getByText("Für diesen Tag ist keine Abwesenheit eingetragen.")).toBeVisible();
  expect(errors).toEqual([]);
});
