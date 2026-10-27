import { expect, type Browser, type Locator, type Page } from "@playwright/test";

export const DEMO_PASSWORD = "schulos";

export async function login(page: Page, username: string, password = DEMO_PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Benutzername").fill(username);
  await page.getByLabel("Passwort").fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page).toHaveURL("/");
}

/** Anmeldung mit Startpasswort der Verwaltung: SchulOS verlangt zuerst ein eigenes Passwort (B-11). */
export async function loginWithStartPassword(page: Page, username: string, startPassword: string, newPassword = "Tafel Kreide Pause") {
  await page.goto("/login");
  await page.getByLabel("Benutzername").fill(username);
  await page.getByLabel("Passwort").fill(startPassword);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page).toHaveURL("/passwort");
  await expect(page.getByRole("note")).toContainText("Startpasswort");
  const form = page.getByRole("form", { name: "Passwort ändern" });
  await form.getByLabel("Bisheriges Passwort").fill(startPassword);
  await form.getByLabel("Neues Passwort", { exact: true }).fill(newPassword);
  await form.getByLabel("Neues Passwort wiederholen").fill(newPassword);
  await form.getByRole("button", { name: "Passwort ändern" }).click();
  await expect(page.getByRole("status")).toContainText("Das Passwort ist geändert");
  await page.getByRole("link", { name: "Weiter zu SchulOS" }).click();
  await expect(page).toHaveURL("/");
}

/** Sammelt Browser-Fehler, damit Tests sie prüfen können. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // P4-73 im QEMU-Test (@iso): Caddy nutzt dort sein internes Zertifikat, dem der Browser nicht traut – Chromium lädt
    // dann /sw.js nicht und meldet das selbst in der Konsole (die Registrierung fängt den Fehler ab). Nur gegen fremde
    // Instanzen (SCHULOS_E2E_URL) ignorieren; in der normalen Suite bleibt jeder Konsolenfehler ein Fehler.
    if (process.env.SCHULOS_E2E_URL && m.text().includes("SSL certificate error occurred when fetching the script")) return;
    errors.push(m.text());
  });
  return errors;
}

/**
 * Q5-11: Die Demo-Schule veröffentlicht den Vertretungsplan erst nach Freigabe. Auf Stundenplanung → Vertretungen: ist der
 * angezeigte Tag ein Entwurf, ihn veröffentlichen (sonst sehen Schüler:innen/Monitor die Änderung nicht und es gibt keinen Gong).
 */
export async function publishIfDraft(page: Page) {
  await page.reload();
  const button = page.getByRole("button", { name: "Tag veröffentlichen" });
  if ((await button.count()) > 0) {
    await button.click();
    await expect(page.getByRole("status").filter({ hasText: "Veröffentlicht" })).toBeVisible();
  }
}

/** „2027-02-01“ → „01.02.2027“ (Anzeige auf den Planungsseiten). */
export const deDate = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

/**
 * SP3-04 (F-10-1): ein Solver-Lauf kommt nur über eine Planversion in den gültigen Plan – „In den Entwurf übernehmen“ (neuer Entwurf ab
 * Stichtag) → „Zur Prüfung geben“ → „Freigeben“ (Schulleitung `petra.lindner` in einem zweiten Kontext, wenn die angemeldete Person kein
 * Prüfrecht hat) → „Ab … veröffentlichen“. Liefert die Versions-id; die Seite steht danach auf der Veröffentlichungsseite (Status „Veröffentlicht“).
 */
export async function publishRun(page: Page, browser: Browser, runUrl: string, from: string): Promise<string> {
  await page.goto(runUrl);
  const toDraft = page.getByRole("form", { name: "In den Entwurf übernehmen" });
  await toDraft.getByLabel("Entwurf", { exact: true }).selectOption("neu");
  await toDraft.getByLabel("Stichtag (nur neuer Entwurf)").fill(from);
  await toDraft.getByRole("button", { name: "In den Entwurf übernehmen" }).click();
  await expect(page).toHaveURL(/[?&]entwurf=[\w-]+/);
  const versionId = new URL(page.url()).searchParams.get("entwurf")!;
  await approveVersion(page, browser, versionId);
  await publishVersionAt(page, versionId, from);
  return versionId;
}

/** Entwurf zur Prüfung geben und freigeben (ohne eigenes Prüfrecht: als Schulleitung in einem zweiten Kontext). */
export async function approveVersion(page: Page, browser: Browser, versionId: string) {
  const review = `/planung/versionen/pruefung?version=${versionId}`;
  await page.goto(review);
  await page.getByRole("button", { name: "Zur Prüfung geben" }).click();
  await expect(page.getByRole("status")).toContainText("Zur Prüfung gegeben");
  if ((await page.getByRole("button", { name: "Freigeben" }).count()) > 0) {
    await page.getByRole("button", { name: "Freigeben" }).click();
  } else {
    const ctx = await browser.newContext();
    const sl = await ctx.newPage();
    await login(sl, "petra.lindner");
    await sl.goto(review);
    await sl.getByRole("button", { name: "Freigeben" }).click();
    await expect(sl.getByRole("status")).toContainText("Freigegeben");
    await ctx.close();
  }
}

/** Freigegebene Version ab Stichtag veröffentlichen (Vorschau → „Ab … veröffentlichen“). */
export async function publishVersionAt(page: Page, versionId: string, from: string) {
  await page.goto(`/planung/versionen/veroeffentlichen?version=${versionId}&ab=${from}`);
  await page.getByRole("button", { name: `Ab ${deDate(from)} veröffentlichen` }).click();
  await expect(page.getByRole("status")).toContainText("Veröffentlicht", { timeout: 60_000 });
}

/** Veröffentlichung zurücknehmen (mit Rückfrage) und die Version anschließend verwerfen (aufräumen für folgende Specs). */
export async function undoAndDiscardVersion(page: Page, versionId: string) {
  await page.goto(`/planung/versionen/veroeffentlichen?version=${versionId}`);
  if ((await page.getByRole("button", { name: "Veröffentlichung zurücknehmen" }).count()) > 0) {
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Veröffentlichung zurücknehmen" }).click();
    await expect(page.getByRole("status")).toContainText("Veröffentlichung zurückgenommen", { timeout: 60_000 });
  }
  await page.goto("/planung/versionen");
  const card = page.locator("article").filter({ has: page.locator(`a[href*="version=${versionId}"]`) }).first();
  if ((await card.getByRole("button", { name: "Verwerfen" }).count()) > 0) {
    page.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "Verwerfen" }).click();
    await expect(page.getByRole("status")).toContainText("verworfen");
  }
}

/**
 * VT-04: Vertretungsnachrichten gehen zur geplanten Zeit raus (Vortag 18:00, heute sofort, nicht in der Ruhezeit). Auf Stundenplanung →
 * Vertretungen alle eingeplanten Nachrichten „jetzt senden“, damit Tests nicht von der Uhrzeit abhängen.
 */
export async function sendPlannedNow(page: Page) {
  await page.reload();
  const planned = page.getByRole("list", { name: "Geplante Nachrichten" });
  const buttons = planned.getByRole("button", { name: /^Jetzt senden/ });
  for (let i = 0; i < 10 && (await buttons.count()) > 0; i++) {
    const label = (await buttons.first().getAttribute("aria-label"))!;
    await buttons.first().click();
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  }
}

/**
 * Konto wechseln: erst die Seite verlassen (schließt die Live-Verbindung der Shell), dann die Cookies löschen.
 * Sonst verbindet sich deren EventSource ohne Sitzung neu, bekommt die Login-Seite (HTML) und meldet einen Konsolenfehler.
 */
export async function logoutForSwitch(page: Page) {
  await page.goto("about:blank");
  await page.context().clearCookies();
}

/** Anfragen an fremde Hosts mitschreiben (TD-04: z. B. Tafeln laden nichts aus dem Netz, auch keine Schriften). */
export function collectExternal(page: Page): string[] {
  const out: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith("http") && !["localhost", "127.0.0.1"].includes(u.hostname)) out.push(r.url());
  });
  return out;
}

/** Tafeln (P3-12): Anzahl sichtbarer Elemente – die Zeichenfläche ist ein Canvas, die Seite spiegelt sie in `data-elements`. */
export async function boardCount(page: Page): Promise<number> {
  return Number(await page.getByRole("region", { name: "Tafel" }).getAttribute("data-elements"));
}

/** Tafeln: Rechteck auf die Zeichenfläche ziehen (Werkzeug über die Toolbar, dann mit der Maus). */
export async function drawRectangle(page: Page, x: number, y: number) {
  // das Eingabefeld liegt unter dem Symbol – auf das umgebende Label klicken
  await page.getByTestId("toolbar-rectangle").locator("..").click();
  const box = (await page.locator("canvas.interactive").boundingBox())!;
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 120, box.y + y + 80, { steps: 5 });
  await page.mouse.up();
}

/**
 * Schreibmarke ans Ende des letzten Absatzes setzen. Klick + „Ende“ und dann prüfen, wo die Marke steht – ProseMirror
 * gleicht die Auswahl kurz nach dem Fokus noch einmal mit seinem Zustand ab (20-ms-Fenster); kommt die Tastatur schneller
 * als ein Mensch, springt die Marke an den Anfang. Deshalb so lange wiederholen, bis sie wirklich hinten steht.
 */
export async function caretToEnd(page: Page, box: Locator, lastText: string) {
  await expect(async () => {
    await box.getByText(lastText).click();
    await page.keyboard.press("End");
    const atEnd = await box.evaluate((el) => {
      const sel = window.getSelection();
      const p = [...el.querySelectorAll("p")].pop();
      const domAtEnd = !!sel && !!p && sel.isCollapsed && p.contains(sel.anchorNode) && sel.anchorOffset === (sel.anchorNode?.textContent?.length ?? -1);
      // Die DOM-Auswahl allein reicht nicht: ProseMirror übernimmt sie erst beim nächsten selectionchange in seinen Zustand. Steht
      // dort die Marke noch vorn, landen Enter und Tippen am Textanfang (main rot seit d4418f7). Darum auch den Editor-Zustand prüfen
      // (Tiptap hängt den Editor an sein DOM-Element).
      type PmEditor = { state: { selection: { empty: boolean; from: number }; doc: { content: { size: number }; lastChild: { type: { name: string } } | null } } };
      const editor = (el as HTMLElement & { editor?: PmEditor }).editor;
      if (!editor) return domAtEnd;
      const { selection, doc } = editor.state;
      return domAtEnd && selection.empty && doc.lastChild?.type.name === "paragraph" && selection.from === doc.content.size - 1;
    });
    expect(atEnd).toBe(true);
  }).toPass({ timeout: 10_000 });
}

/**
 * P5-17: Datenschutzhinweis des Notenbuchs beim ersten Öffnen bestätigen. Öffnet `/notenbuch` und bestätigt, falls der Hinweis
 * kommt (je Konto einmal je Schuljahr – Q-5A-22; nach einem Schuljahreswechsel in der E2E-DB also erneut, die E2E-Datenbank merkt
 * es sich sonst); danach steht die Seite auf `/notenbuch`.
 */
export async function confirmNotenbuchNotice(page: Page) {
  await page.goto("/notenbuch");
  const form = page.getByRole("form", { name: "Datenschutzhinweis zum Notenbuch" });
  if ((await form.count()) > 0) {
    await form.getByLabel("Ich habe den Hinweis gelesen und halte mich daran.").check();
    await form.getByRole("button", { name: "Bestätigen und weiter" }).click();
    await expect(form).toHaveCount(0);
  }
}

/**
 * SP2-12: Lehrkraft in der Zuweisungs-Auswahl (Lehrauftrag, Stunde, Kopplung) wählen – `name` ist der Feldname (z. B. `teacherId`,
 * `p0-teacherId`). Fachfremde Lehrkräfte gibt es nur über „alle anzeigen“ und mit „Trotzdem zuweisen“ (`offSubject`).
 */
export async function pickTeacher(scope: Page | Locator, name: string, userId: string, opts: { offSubject?: boolean; showAll?: boolean } = {}) {
  const box = scope.locator(`[data-teacher-select="${name}"]`);
  if (opts.offSubject || opts.showAll) await box.getByRole("checkbox", { name: /alle anzeigen/ }).check();
  await box.getByRole("combobox").selectOption(userId);
  if (opts.offSubject) await box.getByRole("checkbox", { name: "Trotzdem zuweisen" }).check();
}
