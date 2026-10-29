import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch, publishIfDraft } from "./helpers";

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Nächster Tag (heute oder später) mit diesem Wochentag (0 = Montag). */
function nextWeekday(weekday: number): string {
  const d = new Date();
  while ((d.getDay() + 6) % 7 !== weekday) d.setDate(d.getDate() + 1);
  return ymd(d);
}

test("Vertretungsbedarf: Lehrkraft krank → offene Stunden; Klasse auf Exkursion → Freisetzungen mit Entfall; aufheben", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  // ein Tag, an dem Jana Brandt die 7b unterrichtet (der Demo-Plan kommt aus dem Solver – der Wochentag steht nicht fest)
  await page.goto("/planung/stundenplan?gruppe=g-7b");
  const plan = page.getByRole("table", { name: "Stundenplan Klasse 7b" });
  const bra = plan.getByRole("link", { name: /BRA/ }).first();
  await expect(bra).toBeVisible();
  const weekday = await bra.evaluate((el) => {
    const td = el.closest("td")!;
    return Array.from(td.parentElement!.children).indexOf(td) - 1;
  });
  expect(weekday).toBeGreaterThanOrEqual(0);
  await page.goto(`/planung/vertretungen?datum=${nextWeekday(weekday)}`);
  const form = page.getByRole("form", { name: "Abwesenheit eintragen" });
  await form.getByLabel("Lehrkraft", { exact: true }).selectOption({ label: "BRA – Jana Brandt" });
  await form.getByLabel("Grund").selectOption({ label: "krank" });
  await form.getByRole("button", { name: "Abwesenheit eintragen" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Abwesenheit eingetragen." })).toBeVisible();

  const needs = page.getByRole("region", { name: /^Vertretungsbedarf am/ });
  await expect(needs.getByRole("list", { name: "Abwesenheiten" })).toContainText("BRA");
  await expect(needs.getByText(/^\d+ offen$/)).toBeVisible();
  const open = page.getByRole("table", { name: "Offene Stunden abwesender Lehrkräfte" });
  await expect(open.getByRole("row").filter({ hasText: "Klasse 7b" }).first()).toBeVisible();

  // Klasse 9a auf Exkursion: Stunden werden Freisetzungen, Entfall für alle
  await page.getByLabel("Klasse/Kurs fehlt").check();
  await form.getByLabel("Klasse/Kurs", { exact: true }).selectOption({ label: "Klasse 9a" });
  await form.getByLabel("Grund").selectOption({ label: "Exkursion" });
  await form.getByLabel("Ergänzung").fill("Landtag");
  await form.getByRole("button", { name: "Abwesenheit eintragen" }).click();
  await expect(page.getByLabel("Klasse/Kurs fehlt")).toBeChecked();
  const released = page.getByRole("table", { name: "Freisetzungen" });
  await expect(released.getByText("Entfall fehlt").first()).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/vertretungsbedarf.png", fullPage: true });
  await page.getByRole("button", { name: "Entfall für alle eintragen" }).click();
  await expect(released.getByText("Entfall fehlt")).toHaveCount(0);
  await expect(released.getByText("Entfall eingetragen").first()).toBeVisible();

  // vom Bedarf zur Stunde: Vertretung eintragen öffnet die Stunden der Lehrkraft
  await open.getByRole("link", { name: "Vertretung eintragen" }).first().click();
  await expect(page).toHaveURL(/lehrkraft=u-jana\.brandt/);

  await page.getByRole("button", { name: "Abwesenheit BRA aufheben" }).click();
  await page.getByRole("button", { name: "Abwesenheit Klasse 9a aufheben" }).click();
  await expect(page.getByText("Für diesen Tag ist keine Abwesenheit eingetragen.")).toBeVisible();

  // eingetragene Entfälle der 9a wieder aufheben – sonst fehlen dem nächsten Test Stunden (KRA unterrichtet freitags nur dort)
  const cancelled = page.getByRole("region", { name: /^Alle Änderungen am/ }).getByRole("button", { name: /^Aufheben: Klasse 9a / });
  for (let n = await cancelled.count(); n > 0; n--) {
    await cancelled.first().click();
    await expect(cancelled).toHaveCount(n - 1);
  }
  expect(errors).toEqual([]);
});

test("Vertretungsvorschläge mit Punkten übernehmen, Statistik zählt die Vertretung", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  // TD-16: nicht vom Vorgabedatum abhängen (je nach Wochentag unterrichtet KRA nur in der 9a, und deren Stunden sind frei) –
  // den nächsten Tag der Woche nehmen, an dem KRA Stunden mit Vorschlägen hat
  const group = page.getByRole("group", { name: /^Vorschläge: / }).first();
  for (let weekday = 0; weekday < 5; weekday++) {
    await page.goto(`/planung/vertretungen?datum=${nextWeekday(weekday)}`);
    await page.getByLabel("Lehrkraft (z. B. erkrankt)").selectOption({ label: "KRA – Stefan Krause" });
    await page.getByRole("button", { name: "Anzeigen" }).click();
    await expect(page).toHaveURL(/lehrkraft=/);
    if ((await group.getByText(/Punkte$/).count()) > 0) break;
  }
  await expect(group.getByText(/Punkte$/).first()).toBeVisible();
  await expect(group).toContainText(/Randstunde|Hohlstunde|unterrichtet|hat sonst frei|Freisetzung/);
  await page.screenshot({ path: ".data/shots/e2e/vertretung-vorschlaege.png", fullPage: true });
  const first = group.getByRole("button", { name: /übernehmen/ }).first();
  const code = (await first.textContent())!.replace(/ (mit .+ )?übernehmen$/, "").trim();
  await first.click();
  await expect(page.getByRole("table").last().getByRole("cell", { name: code }).first()).toBeVisible();

  await page.getByRole("link", { name: "Statistik" }).click();
  await expect(page.getByRole("heading", { name: "Vertretungsstatistik", level: 1 })).toBeVisible();
  const row = page.getByRole("table", { name: "Vertretungen je Lehrkraft" }).getByRole("row").filter({ hasText: code });
  await expect(row).toBeVisible();
  await page.getByRole("link", { name: "Dieser Monat" }).click();
  await expect(page).toHaveURL(/zeitraum=monat/);
  expect(errors).toEqual([]);
});

test("SP-12 Fachtausch: Vertretung mit anderem Fach – Klasse, Eltern, Druck und Monitor sehen „Informatik statt …“", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "frank.schulte");
  await page.goto("/planung/vertretungen?gruppe=g-7b");
  const date = await page.getByLabel("Datum").inputValue();
  const lessons = page.getByRole("region", { name: /^Stunden am/ });
  // eine Stunde ohne Änderung (andere Tests lassen evtl. Vertretungen stehen)
  const label = (await lessons.getByRole("form").filter({ hasNot: page.getByRole("button", { name: "Aufheben" }) }).first().getAttribute("aria-label"))!;
  const form = lessons.getByRole("form", { name: label, exact: true });
  const regular = label.split(" · ")[1]!;
  expect(regular).not.toBe("Informatik");
  await form.getByRole("radio", { name: "Vertretung", exact: true }).check();
  const teacher = form.getByLabel("Vertretung durch");
  await teacher.selectOption((await teacher.locator('optgroup[label="Frei"] option').first().getAttribute("value"))!);
  // Vorgabe ist das reguläre Fach
  await expect(form.getByLabel("Fach").locator("option:checked")).toHaveText(`${regular} (regulär)`);
  await form.getByLabel("Fach").selectOption({ label: "Informatik" });
  await form.getByRole("button", { name: "Speichern" }).click();
  await expect(form.getByRole("status")).toContainText("Gespeichert");
  await publishIfDraft(page);
  // das Veröffentlichen leitet ohne `gruppe` weiter – für die Stundenliste der 7b zurück auf die Klassensicht
  await page.goto(`/planung/vertretungen?gruppe=g-7b&datum=${date}`);
  const all = page.getByRole("region", { name: /^Alle Änderungen am/ });
  await expect(all.getByText(`Informatik statt ${regular}`)).toBeVisible();
  await expect(lessons.getByText("→ Informatik").first()).toBeVisible();
  await page.screenshot({ path: ".data/shots/e2e/vertretung-fachtausch.png", fullPage: true });

  // Druck und Monitor
  await page.goto("/druck/vertretungsplan");
  await expect(page.getByText(`Informatik statt ${regular}`).first()).toBeVisible();
  await page.goto("/monitor/demo-foyer-lindenhof-2026");
  await expect(page.getByText(`Informatik (statt ${regular})`).first()).toBeVisible();

  // Schülerin: Vertretungsplan und Stundenplan
  await logoutForSwitch(page);
  await login(page, "lea.schaefer");
  await page.goto("/stundenplan/vertretungen");
  await expect(page.getByText(`Informatik statt ${regular}`).first()).toBeVisible();
  await page.goto(`/stundenplan?woche=${date}`);
  await expect(page.getByText(`statt ${regular}`).first()).toBeVisible();
  // Elternteil
  await logoutForSwitch(page);
  await login(page, "daniela.schaefer");
  await page.goto("/stundenplan/vertretungen");
  await expect(page.getByText(`Informatik statt ${regular}`).first()).toBeVisible();

  // aufräumen
  await logoutForSwitch(page);
  await login(page, "frank.schulte");
  await page.goto(`/planung/vertretungen?datum=${date}`);
  await page
    .getByRole("region", { name: /^Alle Änderungen am/ })
    .getByRole("row")
    .filter({ hasText: `Informatik statt ${regular}` })
    .getByRole("button", { name: /^Aufheben/ })
    .click();
  await expect(page.getByText(`Informatik statt ${regular}`)).toHaveCount(0);
  expect(errors).toEqual([]);
});
