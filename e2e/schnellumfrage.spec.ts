import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test("P3-05: Lehrkraft startet im Kursraum eine Schnellumfrage, Schülerin sieht sie live im Gruppenchat und antwortet, Zähler steigt live", async ({ browser }) => {
  const teacherCtx = await browser.newContext();
  const studentCtx = await browser.newContext();
  const teacher = await teacherCtx.newPage();
  const student = await studentCtx.newPage();
  const errors = [...collectErrors(teacher), ...collectErrors(student)];
  try {
    await login(teacher, "jana.brandt");
    await login(student, "lea.schaefer");
    await student.goto("/messenger/room-g-7b");
    await expect(student.getByRole("heading", { name: "Klasse 7b" })).toBeVisible();
    // Schüler:innen starten keine Schnellumfrage
    await expect(student.getByText("Schnellumfrage starten")).toHaveCount(0);

    await teacher.goto("/kurse/g-7b");
    const card = teacher.getByRole("article").filter({ has: teacher.getByRole("heading", { name: "Schnellumfrage" }) });
    await card.getByText("Schnellumfrage starten").click();
    await card.getByLabel("Frage", { exact: true }).fill("Habt ihr die Aufgabe verstanden?");
    await card.getByLabel("Antwort 1").fill("Ja");
    await card.getByLabel("Antwort 2").fill("Teilweise");
    await card.getByLabel("Antwort 3").fill("Nein");
    await card.getByRole("button", { name: "Starten" }).click();
    const teacherPoll = card.getByRole("region", { name: "Schnellumfrage: Habt ihr die Aufgabe verstanden?" });
    await expect(teacherPoll).toContainText("0 Antworten");

    // live im Chat der Schülerin, ohne neu zu laden
    const studentPoll = student.getByRole("region", { name: "Schnellumfrage: Habt ihr die Aufgabe verstanden?" });
    await expect(studentPoll).toBeVisible();
    await studentPoll.getByRole("button", { name: "Teilweise" }).click();
    await expect(studentPoll).toContainText("Danke! Das Ergebnis erscheint ab 5 Antworten.");
    await expect(studentPoll.getByRole("button", { name: "Teilweise" })).toHaveCount(0);

    // Zähler der Lehrkraft steigt live
    await expect(teacherPoll.getByRole("status")).toContainText("1 Antwort");
    await teacherPoll.getByRole("button", { name: "Beenden" }).click();
    await expect(teacherPoll.getByRole("status")).toContainText("beendet");
    await expect(studentPoll.getByRole("status")).toContainText("beendet");
    await teacher.screenshot({ path: ".data/shots/e2e/schnellumfrage.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await teacherCtx.close();
    await studentCtx.close();
  }
});
