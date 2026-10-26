import { expect, test } from "@playwright/test";
import { caretToEnd, collectErrors, login } from "./helpers";

// P3-11 (erster Teil von P3-13): zwei Browser bearbeiten denselben Text, die Änderung erscheint beim anderen – ohne WebSocket,
// über POST + den gemeinsamen Live-Kanal (SSE, Ereignis „text“).
test("P3-11: Lehrkraft und Schülerin schreiben gleichzeitig im selben Text; Export und Druckansicht", async ({ browser }) => {
  const teacherCtx = await browser.newContext();
  const studentCtx = await browser.newContext();
  const teacher = await teacherCtx.newPage();
  const student = await studentCtx.newPage();
  const errors = [...collectErrors(teacher), ...collectErrors(student)];
  try {
    await login(teacher, "jana.brandt");
    await login(student, "lea.schaefer");
    await teacher.goto("/texte");
    await teacher.getByRole("link", { name: /Klassenregeln/ }).click();
    await expect(teacher.getByRole("heading", { name: "Klassenregeln", exact: true, level: 1 })).toBeVisible();
    await student.goto("/texte/text-7b-regeln");
    const tBox = teacher.getByRole("textbox", { name: "Textinhalt" });
    const sBox = student.getByRole("textbox", { name: "Textinhalt" });
    await expect(tBox).toContainText("Unsere Klassenregeln");
    await expect(sBox).toContainText("Wir lassen einander ausreden.");
    // Schülerin: kein Verwalten-Bereich
    await expect(student.getByRole("heading", { name: "Text verwalten" })).toHaveCount(0);

    // Lehrkraft tippt hinter den letzten Absatz – die Schülerin sieht es live
    await caretToEnd(teacher, tBox, "Regel für den Pausenhof");
    await teacher.keyboard.press("Enter");
    await teacher.keyboard.type("Neue Regel von Frau Brandt");
    await expect(sBox).toContainText("Neue Regel von Frau Brandt");
    await expect(teacher.getByRole("status").filter({ hasText: /Gespeichert|dabei/ }).first()).toBeVisible();

    // Schülerin tippt – die Lehrkraft sieht es live
    await caretToEnd(student, sBox, "Neue Regel von Frau Brandt");
    await student.keyboard.press("Enter");
    await student.keyboard.type("Ergänzung von Lea");
    await expect(tBox).toContainText("Ergänzung von Lea");

    // Markdown-Export enthält beides, Druckansicht zeigt den Text
    await expect(async () => {
      const res = await teacher.request.get("/api/texte/text-7b-regeln/export.md");
      expect(res.status()).toBe(200);
      const md = await res.text();
      expect(md, md).toContain("# Unsere Klassenregeln");
      expect(md, md).toContain("\n\nNeue Regel von Frau Brandt\n\nErgänzung von Lea\n");
    }).toPass();
    await student.goto("/druck/text/text-7b-regeln");
    await expect(student.getByRole("heading", { name: "Klassenregeln", exact: true, level: 1 })).toBeVisible();
    await expect(student.getByText("Ergänzung von Lea")).toBeVisible();

    // Nur-Leitung-Modus: die Schülerin kann nicht mehr schreiben, der Server lehnt Updates ab
    await teacher.getByRole("form", { name: "Text verwalten" }).getByLabel("Wer schreibt?").selectOption({ label: "Nur Leitung schreibt, alle lesen" });
    await teacher.getByRole("button", { name: "Speichern" }).click();
    await student.goto("/texte/text-7b-regeln");
    await expect(student.getByRole("status").filter({ hasText: "Nur lesen" })).toBeVisible();
    const denied = await student.request.post("/api/texte/text-7b-regeln/update", { data: { update: "AAA=" } });
    expect(denied.status()).toBe(403);
    await teacher.getByRole("form", { name: "Text verwalten" }).getByLabel("Wer schreibt?").selectOption({ label: "Alle schreiben" });
    await teacher.getByRole("button", { name: "Speichern" }).click();
    await teacher.screenshot({ path: ".data/shots/e2e/text.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await teacherCtx.close();
    await studentCtx.close();
  }
});

test("P3-11: Nicht-Mitglieder sehen weder Seite noch API; Lehrkraft legt einen Text an und löscht ihn", async ({ page }) => {
  await login(page, "daniel.okafor");
  expect((await page.goto("/texte/text-7b-regeln"))?.status()).toBe(404);
  expect((await page.request.post("/api/texte/text-7b-regeln/sync", { data: {} })).status()).toBe(404);
  expect((await page.request.get("/api/texte/text-7b-regeln/export.md")).status()).toBe(404);
  await page.goto("about:blank");
  await page.context().clearCookies();

  await login(page, "jana.brandt");
  // Routen-Ebene (P311-05): nur JSON, nur same-origin, Größengrenze vor dem Lesen des Bodys
  const api = "/api/texte/text-7b-regeln/update";
  expect((await page.request.post(api, { headers: { "content-type": "text/plain" }, data: '{"update":"AAAA"}' })).status()).toBe(415);
  expect((await page.request.post(api, { headers: { "sec-fetch-site": "cross-site" }, data: { update: "AAAA" } })).status()).toBe(403);
  expect((await page.request.post(api, { data: { update: "A".repeat(400 * 1024) } })).status()).toBe(413);
  expect((await page.request.post(api, { data: { update: "nicht base64!" } })).status()).toBe(400);
  await page.goto("/texte");
  const form = page.getByRole("form", { name: "Neuer Text" });
  await form.getByLabel("Titel").fill("Protokoll Klassenrat");
  await form.getByLabel("Gruppe").selectOption({ label: "Klasse 7b" });
  await form.getByRole("button", { name: "Text anlegen" }).click();
  await expect(page.getByRole("heading", { name: "Protokoll Klassenrat", level: 1 })).toBeVisible();
  const box = page.getByRole("textbox", { name: "Textinhalt" });
  await box.click();
  await page.keyboard.type("Erster Tagesordnungspunkt");
  await expect(page.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();
  // neu laden: der Inhalt kommt vom Server
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Textinhalt" })).toContainText("Erster Tagesordnungspunkt");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Text löschen" }).click();
  await expect(page).toHaveURL("/texte");
  await expect(page.getByRole("link", { name: /Protokoll Klassenrat/ })).toHaveCount(0);
});

test("P3-11: Modul ausgeschaltet → Seite, Druckansicht und API antworten mit 404", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/verwaltung/rechte");
  const toggle = page.getByRole("checkbox", { name: "Modul Texte", exact: true });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(async () => {
    await page.reload();
    await expect(toggle).not.toBeChecked({ timeout: 1000 });
  }).toPass();
  try {
    expect((await page.goto("/texte"))?.status()).toBe(404);
    expect((await page.goto("/druck/text/text-7b-regeln"))?.status()).toBe(404);
    expect((await page.request.post("/api/texte/text-7b-regeln/sync", { data: {} })).status()).toBe(404);
    expect((await page.request.get("/api/texte/text-7b-regeln/export.md")).status()).toBe(404);
  } finally {
    await page.goto("/verwaltung/rechte");
    await toggle.check();
    await expect(async () => {
      await page.reload();
      await expect(toggle).toBeChecked({ timeout: 1000 });
    }).toPass();
  }
  expect((await page.goto("/texte"))?.status()).toBe(200);
});

// TD-06: Tab schließen mit noch nicht bestätigten Änderungen fragt nach; mit bestätigtem Stand nicht.
test("TD-06: Texte-Editor warnt beim Schließen nur bei unbestätigten Änderungen", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.type());
    void d.dismiss();
  });
  try {
    await login(page, "jana.brandt");
    await page.goto("/texte/text-7b-regeln");
    const box = page.getByRole("textbox", { name: "Textinhalt" });
    await expect(box).toContainText("Unsere Klassenregeln");
    await expect(page.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();

    // Updates sperren (auch den keepalive-Versand beim Schließen), dann tippen
    await ctx.route("**/api/texte/*/update", (r) => r.abort());
    await caretToEnd(page, box, "Regel für den Pausenhof");
    await page.keyboard.type("nur lokal");
    await expect(page.getByRole("status").filter({ hasText: "Keine Verbindung" })).toBeVisible();
    await Promise.all([page.waitForEvent("dialog", { timeout: 5000 }), page.close({ runBeforeUnload: true })]);
    expect(dialogs).toEqual(["beforeunload"]);
    expect(page.isClosed()).toBe(false); // Rückfrage abgelehnt → Tab bleibt offen

    // Ohne Änderung kein Dialog
    dialogs.length = 0;
    const clean = await ctx.newPage();
    clean.on("dialog", (d) => {
      dialogs.push(d.type());
      void d.dismiss();
    });
    await clean.goto("/texte/text-7b-regeln");
    await expect(clean.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();
    await clean.close({ runBeforeUnload: true });
    expect(dialogs).toEqual([]);
  } finally {
    await ctx.close();
  }
});
