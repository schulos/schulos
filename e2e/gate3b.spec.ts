import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { boardCount, caretToEnd, collectErrors, collectExternal, drawRectangle, login } from "./helpers";

// P3-13 – E2E Gate 3b (Texte und Tafeln): zwei Browser bearbeiten denselben neuen Text, Änderungen erscheinen beim anderen;
// eine neue Tafel wird gezeichnet, gespeichert und (neu geladen, aus dem Gruppenordner) wieder geöffnet; Lizenzprüfung grün.
test("Gate 3b: Text gemeinsam schreiben, Tafel gemeinsam zeichnen, speichern und wieder öffnen", async ({ browser }) => {
  const teacherCtx = await browser.newContext();
  const studentCtx = await browser.newContext();
  const teacher = await teacherCtx.newPage();
  const student = await studentCtx.newPage();
  const errors = [...collectErrors(teacher), ...collectErrors(student)];
  const external = [...collectExternal(teacher), ...collectExternal(student)];
  try {
    await login(teacher, "jana.brandt");
    await login(student, "lea.schaefer");

    // --- Text: Lehrkraft legt an, beide schreiben, jede Seite sieht die andere
    await teacher.goto("/texte");
    const textForm = teacher.getByRole("form", { name: "Neuer Text" });
    await textForm.getByLabel("Titel").fill("Gate 3b Protokoll");
    await textForm.getByLabel("Gruppe").selectOption({ label: "Klasse 7b" });
    await textForm.getByRole("button", { name: "Text anlegen" }).click();
    await expect(teacher.getByRole("heading", { name: "Gate 3b Protokoll", level: 1 })).toBeVisible();
    const tBox = teacher.getByRole("textbox", { name: "Textinhalt" });
    await tBox.click();
    await teacher.keyboard.type("Tagesordnung von Frau Brandt");
    await expect(teacher.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();

    await student.goto("/texte");
    await student.getByRole("link", { name: /Gate 3b Protokoll/ }).click();
    const sBox = student.getByRole("textbox", { name: "Textinhalt" });
    await expect(sBox).toContainText("Tagesordnung von Frau Brandt");
    await caretToEnd(student, sBox, "Tagesordnung von Frau Brandt");
    await student.keyboard.press("Enter");
    await student.keyboard.type("Punkt von Lea");
    await expect(tBox).toContainText("Punkt von Lea");
    await caretToEnd(teacher, tBox, "Punkt von Lea");
    await teacher.keyboard.press("Enter");
    await teacher.keyboard.type("Antwort der Lehrkraft");
    await expect(sBox).toContainText("Antwort der Lehrkraft");

    // --- Tafel: Lehrkraft legt an und zeichnet, die Schülerin sieht es live und zeichnet zurück
    await teacher.goto("/tafeln");
    const boardForm = teacher.getByRole("form", { name: "Neue Tafel" });
    await boardForm.getByLabel("Titel").fill("Gate 3b Skizze");
    await boardForm.getByLabel("Gruppe").selectOption({ label: "Klasse 7b" });
    await boardForm.getByRole("button", { name: "Tafel anlegen" }).click();
    await expect(teacher.getByRole("heading", { name: "Gate 3b Skizze", level: 1 })).toBeVisible();
    const boardUrl = teacher.url();
    await expect.poll(() => boardCount(teacher)).toBe(0);

    await student.goto("/tafeln");
    await student.getByRole("link", { name: /Gate 3b Skizze/ }).click();
    await expect(student).toHaveURL(boardUrl);
    await expect.poll(() => boardCount(student)).toBe(0);

    await drawRectangle(teacher, 500, 120);
    await expect.poll(() => boardCount(student), { timeout: 10_000 }).toBe(1);
    await drawRectangle(student, 500, 260);
    await expect.poll(() => boardCount(teacher), { timeout: 10_000 }).toBe(2);
    await expect(student.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();

    // speichern/öffnen: neu laden (Stand vom Server) und über den Gruppenordner wieder öffnen
    await teacher.reload();
    await expect.poll(() => boardCount(teacher)).toBe(2);
    await student.goto("/dateien?bereich=group%3Ag-7b");
    await student.getByRole("link", { name: "Gate 3b Skizze.excalidraw", exact: true }).click();
    await expect(student).toHaveURL(boardUrl);
    await expect.poll(() => boardCount(student)).toBe(2);

    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await teacherCtx.close();
    await studentCtx.close();
  }
});

test("Gate 3b: Lizenzprüfung grün, Excalidraw/Yjs/Tiptap unter MIT", () => {
  const out = execFileSync(process.execPath, ["scripts/licenses.mjs"], { encoding: "utf8" });
  expect(out).toContain("alle Lizenzen freigegeben");
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { license?: string }> };
  for (const p of ["@excalidraw/excalidraw", "yjs", "@tiptap/react", "@tiptap/extension-collaboration"]) {
    expect(lock.packages[`node_modules/${p}`]?.license, p).toBe("MIT");
  }
});
