import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

test("P3-08: Schülerin heftet eine Karte an, die Lehrkraft sieht sie live; moderiert erst nach Freigabe", async ({ browser }) => {
  const teacherCtx = await browser.newContext();
  const studentCtx = await browser.newContext();
  const teacher = await teacherCtx.newPage();
  const student = await studentCtx.newPage();
  const errors = [...collectErrors(teacher), ...collectErrors(student)];
  try {
    await login(teacher, "jana.brandt");
    await login(student, "lea.schaefer");
    await teacher.goto("/pinnwaende/board-7b-projekt");
    await student.goto("/pinnwaende");
    await student.getByRole("link", { name: /Projekt Klimaschutz/ }).click();
    await expect(student.getByRole("heading", { name: "Projekt Klimaschutz", level: 1 })).toBeVisible();
    await expect(student.getByRole("heading", { name: "Pinnwand verwalten" })).toHaveCount(0);

    await student.getByRole("button", { name: "Karte in Ideen hinzufügen" }).click();
    const form = student.getByRole("form", { name: "Neue Karte in Ideen" });
    await form.getByLabel("Titel").fill("Fahrradtag");
    await form.getByLabel("Text").fill("Einmal im Monat mit dem Rad kommen");
    await form.getByRole("button", { name: "Anheften" }).click();
    await expect(student.getByRole("list", { name: "Karten in Ideen" })).toContainText("Fahrradtag");

    // live bei der Lehrkraft, ohne neu zu laden
    await expect(teacher.getByRole("list", { name: "Karten in Ideen" })).toContainText("Fahrradtag");

    // Lehrkraft stellt auf „moderiert“ – neue Karten der Schülerin warten auf Freigabe
    await teacher.getByLabel("Wer postet?").selectOption({ label: "Alle posten, Leitung gibt frei" });
    await teacher.getByRole("button", { name: "Speichern" }).click();
    await expect(student.getByText("Alle posten, Leitung gibt frei")).toBeVisible();
    await student.getByRole("button", { name: "Karte in Quellen hinzufügen" }).click();
    const form2 = student.getByRole("form", { name: "Neue Karte in Quellen" });
    await form2.getByLabel("Art").selectOption({ label: "Link" });
    await form2.getByLabel("Titel").fill("Klimarechner");
    await form2.getByLabel("Adresse").fill("https://example.org/klima");
    await form2.getByRole("button", { name: "Anheften" }).click();
    const quellen = student.getByRole("list", { name: "Karten in Quellen" });
    await expect(quellen.getByRole("listitem").filter({ hasText: "Klimarechner" })).toContainText("wartet auf Freigabe");

    await teacher.getByRole("button", { name: "„Klimarechner“ freigeben" }).click();
    await expect(quellen.getByRole("listitem").filter({ hasText: "Klimarechner" })).not.toContainText("wartet auf Freigabe");
    await expect(quellen.getByRole("link", { name: "example.org" })).toBeVisible();

    await teacher.getByLabel("Wer postet?").selectOption({ label: "Alle posten" });
    await teacher.getByRole("button", { name: "Speichern" }).click();
    await teacher.screenshot({ path: ".data/shots/e2e/pinnwand.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await teacherCtx.close();
    await studentCtx.close();
  }
});

test("P3-08: Lehrkraft legt eine freie Pinnwand an und nimmt eine Kollegin auf", async ({ page }) => {
  await login(page, "jana.brandt");
  await page.goto("/pinnwaende");
  await page.getByLabel("Titel").fill("Fachschaft – Lektüreliste");
  await page.getByLabel("Für").selectOption({ label: "Frei (eigene Mitglieder)" });
  await page.getByRole("button", { name: "Pinnwand anlegen" }).click();
  await expect(page.getByRole("heading", { name: "Fachschaft – Lektüreliste", level: 1 })).toBeVisible();
  await page.getByLabel("Neue Spalte").fill("Klasse 7");
  await page.getByRole("button", { name: "Spalte", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Klasse 7", level: 2 })).toBeVisible();
  await page.getByLabel("Benutzername").fill("petra.lindner");
  await page.getByRole("button", { name: "Hinzufügen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Petra Lindner entfernen" })).toBeVisible();
});

test("P3-09: Karte per Tastatur verschieben, Druckansicht, Pinnwand auf dem Monitor", async ({ page, browser }) => {
  await login(page, "jana.brandt");
  await page.goto("/pinnwaende/board-7b-projekt");
  const ideen = page.getByRole("list", { name: "Karten in Ideen" });
  const quellen = page.getByRole("list", { name: "Karten in Quellen" });
  const energy = page.getByRole("button", { name: "„Energie sparen in der Schule“ nach Quellen" });
  await energy.focus();
  await page.keyboard.press("Enter");
  await expect(quellen).toContainText("Energie sparen in der Schule");
  await expect(ideen).not.toContainText("Energie sparen in der Schule");
  await page.getByRole("button", { name: "„Energie sparen in der Schule“ nach Ideen" }).click();
  await expect(ideen).toContainText("Energie sparen in der Schule");

  await page.getByRole("link", { name: "Druckansicht" }).click();
  await expect(page.getByRole("heading", { name: "Projekt Klimaschutz", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Ideen" })).toContainText("Energie sparen in der Schule");
  await expect(page.getByRole("button", { name: /Drucken/ })).toBeVisible();

  // Leitung erlaubt den Monitor, Verwaltung zeigt die Pinnwand auf einem Bildschirm – nur mit geprüften Karten (SEC-05)
  await page.goto("/pinnwaende/board-7b-projekt");
  const monitor = page.getByRole("checkbox", { name: /Auf Monitoren zeigen/ });
  await expect(monitor).toBeDisabled();
  await page.getByLabel("Wer postet?").selectOption({ label: "Alle posten, Leitung gibt frei" });
  await monitor.check();
  await page.getByRole("button", { name: "Speichern" }).click();
  await logoutForSwitch(page);
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/monitore");
  await page.getByLabel("Name", { exact: true }).last().fill("Flur 7");
  await page.getByLabel("Pinnwand zusätzlich zeigen").last().selectOption({ label: "Projekt Klimaschutz (Klasse 7b)" });
  await page.getByRole("button", { name: "Anlegen" }).click();
  const url = await page.getByTestId("monitor-url").textContent();
  const screen = await (await browser.newContext()).newPage();
  await screen.goto(url!);
  const board = screen.getByRole("region", { name: "Pinnwand Projekt Klimaschutz" });
  await expect(board).toContainText("Energie sparen in der Schule");
  await expect(board).not.toContainText("Jana Brandt");
});
