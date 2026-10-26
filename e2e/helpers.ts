import { expect, type Locator, type Page } from "@playwright/test";

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
      return !!sel && !!p && sel.isCollapsed && p.contains(sel.anchorNode) && sel.anchorOffset === (sel.anchorNode?.textContent?.length ?? -1);
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
export async function pickTeacher(scope: Page | Locator, name: string, userId: string, opts: { offSubject?: boolean } = {}) {
  const box = scope.locator(`[data-teacher-select="${name}"]`);
  if (opts.offSubject) await box.getByRole("checkbox", { name: /alle anzeigen/ }).check();
  await box.getByRole("combobox").selectOption(userId);
  if (opts.offSubject) await box.getByRole("checkbox", { name: "Trotzdem zuweisen" }).check();
}
