import { expect, test, type Browser } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// Gate 3 (P3-10): die Bausteine der Phase 3 im Zusammenspiel. Einzelheiten testen kurse/umfragen/schnellumfrage/foren/pinnwaende.spec.ts.
const STUDENTS = ["lea.schaefer", "anton.kaya", "aylin.terhorst", "can.kaya", "can.wolf"];

async function signedIn(browser: Browser, user: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, user);
  return { ctx, page };
}

test("Gate 3 – Lehrkraft startet im Kurs eine Schnellumfrage, fünf Schüler:innen antworten, das Ergebnis erscheint live erst ab 5 Antworten", async ({ browser }) => {
  const teacher = await signedIn(browser, "jana.brandt");
  const errors = collectErrors(teacher.page);
  const students = await Promise.all(STUDENTS.map((u) => signedIn(browser, u)));
  try {
    for (const s of students) await s.page.goto("/kurse/g-7b");
    await teacher.page.goto("/kurse/g-7b");
    const card = teacher.page.getByRole("article").filter({ has: teacher.page.getByRole("heading", { name: "Schnellumfrage" }) });
    await card.getByText("Schnellumfrage starten").click();
    await card.getByLabel("Frage", { exact: true }).fill("Gate 3: Bereit für den Test?");
    await card.getByLabel("Antwort 1").fill("Ja");
    await card.getByLabel("Antwort 2").fill("Nein");
    await card.getByRole("button", { name: "Starten" }).click();
    const poll = card.getByRole("region", { name: "Schnellumfrage: Gate 3: Bereit für den Test?" });
    await expect(poll).toContainText("0 Antworten");

    for (const [i, s] of students.entries()) {
      const own = s.page.getByRole("region", { name: "Schnellumfrage: Gate 3: Bereit für den Test?" });
      await own.getByRole("button", { name: i < 3 ? "Ja" : "Nein" }).click();
      await expect(poll.getByRole("status")).toContainText(i === 0 ? "1 Antwort" : `${i + 1} Antworten`);
      if (i < 4) await expect(poll).toContainText("Das Ergebnis erscheint ab 5 Antworten.");
    }
    // ab der fünften Antwort live die Verteilung – bei der Lehrkraft und bei den Schüler:innen
    await expect(poll.getByRole("progressbar", { name: "Ja: 3 von 5" })).toBeVisible();
    await expect(poll.getByRole("progressbar", { name: "Nein: 2 von 5" })).toBeVisible();
    await expect(students[0]!.page.getByRole("progressbar", { name: "Ja: 3 von 5" })).toBeVisible();
    await teacher.page.screenshot({ path: ".data/shots/e2e/gate3-schnellumfrage.png", fullPage: true });
    await poll.getByRole("button", { name: "Beenden" }).click();
    await expect(poll.getByRole("status")).toContainText("beendet");
    expect(errors).toEqual([]);
  } finally {
    await teacher.ctx.close();
    for (const s of students) await s.ctx.close();
  }
});

test("Gate 3 – Forenbeitrag wird ausgeblendet, Pinnwand-Karte erscheint live", async ({ browser }) => {
  const teacher = await signedIn(browser, "jana.brandt");
  const student = await signedIn(browser, "anton.kaya");
  try {
    // Schüler schreibt im Klassenforum, Klassenleitung blendet aus – der Schüler sieht nur noch den Grund
    await student.page.goto("/foren/g-7b");
    await student.page.getByLabel("Titel").fill("Gate 3 Forum");
    await student.page.getByLabel("Beitrag").fill("Dieser Satz wird ausgeblendet");
    await student.page.getByRole("button", { name: "Thema starten" }).click();
    await expect(student.page.getByRole("heading", { name: "Gate 3 Forum", level: 1 })).toBeVisible();
    await teacher.page.goto(student.page.url());
    const post = teacher.page.getByRole("list", { name: "Beiträge" }).getByRole("listitem").first();
    await post.getByRole("button", { name: "Ausblenden" }).click();
    await post.getByLabel("Grund (sehen alle)").fill("Gate-Test");
    await post.getByRole("button", { name: "Ausblenden" }).click();
    // erst neu laden, wenn das Ausblenden gespeichert ist (sonst Wettlauf mit der Server Action)
    await expect(post.getByText("Von der Moderation ausgeblendet: Gate-Test")).toBeVisible();
    await student.page.reload();
    await expect(student.page.getByText("Von der Moderation ausgeblendet: Gate-Test")).toBeVisible();
    await expect(student.page.getByText("Dieser Satz wird ausgeblendet")).toHaveCount(0);

    // Karte des Schülers erscheint live auf der Pinnwand der Lehrkraft
    await teacher.page.goto("/pinnwaende/board-7b-projekt");
    await student.page.goto("/pinnwaende/board-7b-projekt");
    await student.page.getByRole("button", { name: "Karte in Ideen hinzufügen" }).click();
    const form = student.page.getByRole("form", { name: "Neue Karte in Ideen" });
    await form.getByLabel("Titel").fill("Gate 3 Karte");
    await form.getByRole("button", { name: "Anheften" }).click();
    await expect(teacher.page.getByRole("list", { name: "Karten in Ideen" })).toContainText("Gate 3 Karte");
  } finally {
    await teacher.ctx.close();
    await student.ctx.close();
  }
});
