import { expect, test, type Page } from "@playwright/test";
import { totpCode } from "@schulos/server/totp-code";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { E2E_ADMIN, MAIN_ADMIN, MAIN_PORT } from "../playwright.config";

/** Screenshots zur Sichtkontrolle (gitignored) */
const SHOTS = (name: string) => path.join(import.meta.dirname, "..", "..", "..", ".data", "shots", name);

// Seriell: der zweite Test meldet sich mit dem im ersten eingerichteten zweiten Faktor an.
test.describe.configure({ mode: "serial" });
let backupSecret = "";
const used = new Set<string>();

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

async function passwordStep(page: Page, password = E2E_ADMIN.password) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Benutzername").fill(E2E_ADMIN.username);
  await page.getByLabel("Passwort").fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
}

/** Nächster Code aus einem neuen 30-s-Fenster (ein Code gilt nur einmal). */
async function freshCode(secret: string, used: Set<string>): Promise<string> {
  for (;;) {
    const c = totpCode(secret);
    if (!used.has(c)) {
      used.add(c);
      return c;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

test("Erststart-Admin: Pflicht-Einrichtung des zweiten Faktors, Anmeldung mit Code, Protokoll, Abmelden", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);

  // falsches Passwort
  await passwordStep(page, "falsch-falsch");
  await expect(page.locator("form").getByRole("alert")).toHaveText("Benutzername oder Passwort ist falsch.");

  // erste Anmeldung: ohne zweiten Faktor geht es nur zur Einrichtung (React leert das Formular nach dem Fehler – TD-02)
  await page.getByLabel("Benutzername").fill(E2E_ADMIN.username);
  await page.getByLabel("Passwort").fill(E2E_ADMIN.password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page).toHaveURL(/\/zwei-faktor/);
  await expect(page.getByText(/für jedes Konto Pflicht/)).toBeVisible();
  await page.goto("/protokoll");
  await expect(page).toHaveURL(/\/zwei-faktor/);

  const start = page.getByRole("form", { name: "Einrichtung starten" });
  await start.getByLabel("Passwort zur Bestätigung").fill(E2E_ADMIN.password);
  await start.getByRole("button", { name: "Einrichtung starten" }).click();
  await expect(page.getByRole("img", { name: "QR-Code für die Authenticator-App" })).toBeVisible();
  const secret = (await page.getByLabel("Geheimnis").textContent())!.replace(/\s/g, "");
  backupSecret = secret;
  await expect(page.getByRole("list", { name: "Wiederherstellungscodes" }).getByRole("listitem")).toHaveCount(10);
  const confirm = page.getByRole("form", { name: "Code bestätigen" });
  await confirm.getByLabel("2. Code aus der App").fill(await freshCode(secret, used));
  await confirm.getByRole("button", { name: "Bestätigen und einschalten" }).click();
  await expect(page.getByRole("status")).toContainText("Zwei-Faktor-Anmeldung ist eingerichtet");

  await page.getByRole("link", { name: "Zur Übersicht" }).click();
  await expect(page.getByRole("heading", { name: "Übersicht", level: 1 })).toBeVisible();
  await expect(page.getByText("Noch keine Instanz gekoppelt")).toBeVisible();

  // Abmelden, neue Anmeldung verlangt den Code
  await page.getByRole("button", { name: "Abmelden" }).click();
  await passwordStep(page);
  await expect(page).toHaveURL(/\/login\/zweiter-faktor/);
  await page.getByLabel("Code aus der Authenticator-App").fill("000000");
  await page.getByRole("button", { name: "Bestätigen" }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText("Der Code ist falsch");
  await page.getByLabel("Code aus der Authenticator-App").fill(await freshCode(secret, used));
  await page.getByRole("button", { name: "Bestätigen" }).click();
  await expect(page.getByRole("heading", { name: "Übersicht", level: 1 })).toBeVisible();

  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Protokoll" }).click();
  const rows = page.getByRole("row");
  await expect(rows.filter({ hasText: "Erststart: Admin-Konto angelegt" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Zwei-Faktor-Anmeldung eingerichtet" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Anmeldung" }).filter({ hasText: E2E_ADMIN.name }).first()).toBeVisible();

  expect(errors).toEqual([]);
});

test("Sicherheits-Header und CSP mit Nonce wie im Hauptsystem", async ({ request }) => {
  const res = await request.get("/login");
  const csp = res.headers()["content-security-policy"]!;
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(res.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(res.headers()["x-powered-by"]).toBeUndefined();
  const health = await (await request.get("/api/health")).json();
  expect(health).toMatchObject({ ok: true, app: "schulos-backup", db: "up" });
});

/** Zweiten Faktor im Hauptsystem einrichten (Produktivinstanz: Pflicht für den Admin) – liefert das Geheimnis. */
async function setupMainTwoFactor(page: Page): Promise<string> {
  const start = page.getByRole("form", { name: "Einrichtung starten" });
  await start.getByLabel("Passwort zur Bestätigung").fill(MAIN_ADMIN.password);
  await start.getByRole("button", { name: "Einrichtung starten" }).click();
  const secret = (await page.getByLabel("Geheimnis").textContent())!.replace(/\s/g, "");
  const confirm = page.getByRole("form", { name: "Code bestätigen" });
  await confirm.getByLabel("2. Code aus der App").fill(await freshCode(secret, used));
  await confirm.getByRole("button", { name: "Bestätigen und einschalten" }).click();
  await expect(page.getByRole("status")).toContainText("eingerichtet");
  return secret;
}

test("Kopplung über beide Oberflächen: Code auf dem Backupserver, Eingabe im Hauptsystem, Wiederherstellungsschlüssel", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  const main = `http://localhost:${MAIN_PORT}`;

  // Backupserver: anmelden (zweiter Faktor aus dem ersten Test) und Code erzeugen
  await passwordStep(page);
  await page.getByLabel("Code aus der Authenticator-App").fill(await freshCode(backupSecret, used));
  await page.getByRole("button", { name: "Bestätigen" }).click();
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Instanzen" }).click();
  await expect(page.getByText("Noch keine Instanz gekoppelt")).toBeVisible();
  await page.getByRole("button", { name: "Kopplungscode erzeugen" }).click();
  const codeOut = page.getByLabel("Kopplungscode", { exact: true });
  await expect(codeOut).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const code = (await codeOut.textContent())!.trim();
  await expect(page.getByLabel("Offene Codes", { exact: true })).toContainText("gültig bis");

  // Hauptsystem (anderer Port, gleicher Host – die Sitzung des Backupservers bleibt dank eigenem Cookie-Präfix bestehen)
  await page.goto(`${main}/login`);
  await page.getByLabel("Benutzername").fill(MAIN_ADMIN.username);
  await page.getByLabel("Passwort").fill(MAIN_ADMIN.password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page).toHaveURL(/\/zwei-faktor/);
  await setupMainTwoFactor(page);
  await page.goto(`${main}/verwaltung`);
  await expect(page.getByLabel("Sicherung", { exact: true })).toContainText("Keine Sicherung eingerichtet");
  await page.goto(`${main}/verwaltung/backup`);
  await expect(page.getByRole("alert").filter({ hasText: "Keine Sicherung eingerichtet" })).toBeVisible();

  const form = page.getByRole("form", { name: "Backupserver koppeln" });
  await form.getByLabel("Adresse des Backupservers").fill("http://localhost:3140");
  await form.getByLabel("Kopplungscode").fill("AAAA-BBBB-CCCC");
  await form.getByRole("button", { name: "Koppeln" }).click();
  await expect(form.getByRole("alert")).toContainText("unbekannt, abgelaufen oder schon verwendet");
  await expect(form.getByLabel("Adresse des Backupservers")).toHaveValue("http://localhost:3140");
  await expect(form.getByLabel("Name dieser Instanz auf dem Backupserver")).toHaveValue("Gesamtschule am Lindenhof");
  await form.getByLabel("Kopplungscode").fill(code.toLowerCase());
  await form.getByRole("button", { name: "Koppeln" }).click();

  const recovery = page.getByLabel("Wiederherstellungsschlüssel", { exact: true });
  await expect(recovery).toHaveText(/^([0-9A-Z]{5}-){5}[0-9A-Z]{5}$/);
  await page.getByLabel("Ausgedruckt und sicher verwahrt").check();
  await page.getByRole("button", { name: "Bestätigen" }).click();
  await expect(recovery).toHaveCount(0);
  const card = page.getByLabel("Kopplung");
  await expect(card.getByText("gekoppelt", { exact: true })).toBeVisible();
  await expect(card).toContainText("SchulOS Backup · http://localhost:3140");

  // Sicherungsstand (ohne laufenden Agenten) und „Jetzt sichern“ über den Backupserver
  const stand = page.getByLabel("Sicherungsstand");
  await expect(stand).toContainText("noch kein Backup");
  await expect(stand).toContainText("hat sich noch nicht gemeldet");
  await stand.getByRole("button", { name: "Jetzt sichern" }).click();
  await expect(stand.getByRole("status")).toContainText("Angefordert");
  await page.screenshot({ path: SHOTS("haupt-backup.png"), fullPage: true });
  await page.goto(`${main}/verwaltung`);
  await expect(page.getByLabel("Sicherung", { exact: true })).toHaveCount(0); // gekoppelt, noch kein Lauf: keine Warnung

  // Zugangsdaten liegen nur in der Konfigurationsdatei des Hauptsystems
  const stored = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "..", "..", ".data", "e2e-pair-main-config", "backup-pairing.json"), "utf8"));
  expect(stored).toMatchObject({ instanceName: "Gesamtschule am Lindenhof", recoveryConfirmedAt: expect.any(String) });
  expect(await page.content()).not.toContain(stored.repoPassword);

  // zurück auf dem Backupserver: Instanz, rest-server-Zugang, Protokoll
  await page.goto("/instanzen");
  const inst = page.getByLabel("Gesamtschule am Lindenhof", { exact: true });
  await expect(inst).toContainText(main);
  await expect(inst).toContainText(stored.restUser);
  await expect(inst).toContainText("der Agent startet innerhalb einer Minute");

  // Detailseite: Zeitplan und Aufbewahrung (Vorschau, Begründung über 3 Monate)
  await inst.getByRole("link", { name: "Zeitplan, Aufbewahrung, Stände" }).click();
  await expect(page.getByRole("heading", { name: "Gesamtschule am Lindenhof", level: 1 })).toBeVisible();
  const zeitplan = page.getByRole("form", { name: "Zeitplan" });
  await zeitplan.getByLabel("Uhrzeiten (täglich)").fill("12:30, 1:30");
  await zeitplan.getByRole("button", { name: "Zeitplan speichern" }).click();
  await expect(zeitplan.getByRole("status")).toContainText("täglich 01:30, 12:30 Uhr");
  const aufbewahrung = page.getByRole("form", { name: "Aufbewahrung" });
  await expect(aufbewahrung.getByLabel("Vorschau Aufbewahrung")).toContainText("höchstens 21 Stände, der älteste ist ≈ 3 Monate");
  await aufbewahrung.getByLabel("Monatsstände").fill("6");
  await expect(aufbewahrung.getByLabel("Vorschau Aufbewahrung")).toContainText("≈ 6 Monate");
  await expect(aufbewahrung.getByRole("note")).toContainText("Löschkonzept");
  await aufbewahrung.getByRole("button", { name: "Aufbewahrung speichern" }).click();
  await expect(aufbewahrung).toContainText("nur mit Begründung");
  await aufbewahrung.getByLabel("Monatsstände").fill("3");
  await aufbewahrung.getByRole("button", { name: "Aufbewahrung speichern" }).click();
  await expect(aufbewahrung.getByRole("status")).toContainText("Gespeichert");
  await expect(page.getByLabel("Sicherungsstände")).toBeVisible();
  await page.screenshot({ path: SHOTS("backup-instanz.png"), fullPage: true });
  const htpasswd = path.join(import.meta.dirname, "..", "..", "..", ".data", "e2e-backup-rest", ".htpasswd");
  expect(existsSync(htpasswd) && readFileSync(htpasswd, "utf8")).toMatch(new RegExp(`^${stored.restUser}:\\$2[aby]\\$10\\$`, "m"));
  await page.goto("/protokoll");
  await expect(page.getByRole("row").filter({ hasText: "Hauptsystem gekoppelt" })).toHaveCount(1);

  expect(errors).toEqual([]);
});

async function loginBackupAdmin(page: Page) {
  await passwordStep(page);
  await page.getByLabel("Code aus der Authenticator-App").fill(await freshCode(backupSecret, used));
  await page.getByRole("button", { name: "Bestätigen" }).click();
  await expect(page.getByRole("heading", { name: "Übersicht", level: 1 })).toBeVisible();
}

test("Konten: anlegen mit Startpasswort, Pflicht-Wechsel und 2FA-Einrichtung, sperren", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await loginBackupAdmin(page);
  await page.getByRole("navigation", { name: "Hauptnavigation" }).getByRole("link", { name: "Konten" }).click();
  await expect(page.getByLabel(E2E_ADMIN.name, { exact: true })).toContainText("du");
  const create = page.getByRole("form", { name: "Konto anlegen" });
  await create.getByLabel("Vorname").fill("Bert");
  await create.getByLabel("Nachname").fill("Backup");
  await create.getByLabel("Benutzername").fill("b.backup");
  await create.getByRole("button", { name: "Konto anlegen" }).click();
  const start = (await create.getByLabel("Startpasswort").textContent())!.trim();
  expect(start).toHaveLength(12);
  await expect(page.getByLabel("Bert Backup", { exact: true })).toContainText("Startpasswort");
  await page.screenshot({ path: SHOTS("backup-konten.png"), fullPage: true });

  // neue Person: Startpasswort → Pflicht-Wechsel → Pflicht-2FA
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Benutzername").fill("b.backup");
  await page.getByLabel("Passwort").fill(start);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page).toHaveURL(/\/passwort/);
  const pw = page.getByRole("form", { name: "Passwort ändern" });
  await pw.getByLabel("Bisheriges Passwort").fill(start);
  await pw.getByLabel("Neues Passwort", { exact: true }).fill("Bleistift Radiergummi Lineal");
  await pw.getByLabel("Neues Passwort wiederholen").fill("Bleistift Radiergummi Lineal");
  await pw.getByRole("button", { name: "Passwort ändern" }).click();
  await expect(page.getByRole("status")).toContainText("Das Passwort ist geändert");
  await page.getByRole("link", { name: "Weiter" }).click();
  await expect(page).toHaveURL(/\/zwei-faktor/);
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/\/login/);

  // Admin sperrt das Konto – Anmeldung danach abgelehnt
  await loginBackupAdmin(page);
  await page.goto("/konten");
  const bert = page.getByLabel("Bert Backup", { exact: true });
  await bert.getByRole("button", { name: "Sperren" }).click();
  await expect(bert).toContainText("gesperrt");
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Benutzername").fill("b.backup");
  await page.getByLabel("Passwort").fill("Bleistift Radiergummi Lineal");
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText("gesperrt");
  expect(errors).toEqual([]);
});
