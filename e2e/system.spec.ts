import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { collectErrors, login, logoutForSwitch } from "./helpers";

// Verwaltung → System (B-33): den Status schreibt sonst `schulosctl system-sync` auf dem Server – hier legt der Test
// ihn in den Konfigurationsordner des E2E-Servers (.data/config) und prüft den Auftrag, den die Seite zurückschreibt.
const dir = path.join(process.cwd(), ".data", "config");
const statusFile = path.join(dir, "system-status.json");
const orderFile = path.join(dir, "system-auftrag.json");

function writeStatus(extra: Record<string, unknown> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    statusFile,
    JSON.stringify({
      version: 1,
      checkedAt: new Date().toISOString(),
      current: "1.4.2",
      channel: "stabil",
      update: {
        status: "verfügbar",
        kind: "minor",
        securityRelevant: true,
        steps: [
          {
            version: "1.5.0",
            publishedAt: "2026-09-20T08:00:00Z",
            securityRelevant: true,
            changes: [
              { kind: "neu", text: "Elternsprechtage online buchen" },
              { kind: "sicherheit", text: "Anmeldung besser gegen Ausprobieren geschützt" },
            ],
          },
        ],
      },
      approved: null,
      protocol: [
        { at: "2026-10-01T02:10:00Z", step: "fertig", ok: true, from: "1.4.1", to: "1.4.2", detail: "Sicherungs-Dump gelöscht" },
        { at: "2026-10-01T02:05:00Z", step: "loeschnachweis", ok: true, to: "1.4.2", detail: "Kopie der Datenbank und Probelauf-Container entfernt" },
      ],
      os: { name: "Debian GNU/Linux 13 (trixie)", versionId: "13", codename: "trixie", securityUntil: "2028-08-09", ltsUntil: "2030-06-30" },
      ...extra,
    }),
  );
}

test.afterAll(() => {
  rmSync(statusFile, { force: true });
  rmSync(orderFile, { force: true });
});

test("Verwaltung → System: Version, Änderungen, Freigabe und Kanal als Auftrag für den Server, Protokoll, Betriebssystem", async ({ page }) => {
  rmSync(statusFile, { force: true });
  rmSync(orderFile, { force: true });
  await login(page, "sabine.kowalski");
  expect((await page.goto("/verwaltung/system"))?.status()).toBe(404);

  await logoutForSwitch(page);
  const errors = collectErrors(page); // ab hier – der 404 oben ist gewollt
  await login(page, "admin");
  await page.goto("/verwaltung");
  await page.getByRole("link", { name: "System", exact: true }).click();
  await expect(page.getByRole("heading", { name: "System", level: 1 })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Noch kein Systemstatus" })).toBeVisible();
  // B-51: Abfragestatistik gibt es nur mit dem Server-Postgres – die E2E-DB ist PGlite
  await expect(page.getByRole("region", { name: "Langsame Abfragen" })).toContainText("Nicht verfügbar");
  // REPO-03: Vorschau-/Haftungshinweis dauerhaft auf der Seite, Bestätigung einmal je Fassung
  const hinweis = page.getByRole("article", { name: "Vorschau-Hinweis" });
  await expect(hinweis).toContainText("ohne Gewähr und ohne Support");
  await expect(hinweis).toContainText("Penetrationstest");
  const ack = hinweis.getByRole("button", { name: "Gelesen und verstanden" });
  if (await ack.count()) await ack.click();
  await expect(hinweis).toContainText("bestätigt");

  writeStatus();
  await page.reload();
  await expect(page.getByRole("article", { name: "Version" })).toContainText("1.4.2");
  const updates = page.getByRole("article", { name: "Updates" });
  await expect(updates).toContainText("SchulOS 1.5.0 verfügbar");
  await expect(updates).toContainText("sicherheitsrelevant");
  await expect(updates.getByRole("region", { name: "Änderungen in 1.5.0" })).toContainText("Elternsprechtage online buchen");
  await expect(page.getByRole("article", { name: "Betriebssystem" })).toContainText("Debian GNU/Linux 13 (trixie)");
  await expect(page.getByRole("region", { name: "Update-Protokoll" }).getByRole("row")).toHaveCount(3);

  await updates.getByRole("button", { name: "Im Wartungsfenster installieren" }).click();
  await expect(updates.getByRole("status").filter({ hasText: "im nächsten Wartungsfenster" })).toBeVisible();
  const order = JSON.parse(readFileSync(orderFile, "utf8")) as Record<string, unknown>;
  expect(order).toMatchObject({ version: 1, action: "freigabe", target: "1.5.0", when: "wartungsfenster" });

  const channel = page.getByRole("form", { name: "Update-Kanal" });
  await channel.getByLabel("Kanal").selectOption("beta");
  await channel.getByRole("button", { name: "Übernehmen" }).click();
  await expect(channel.getByRole("status")).toContainText("Kanal „beta“");
  expect(JSON.parse(readFileSync(orderFile, "utf8"))).toMatchObject({ action: "kanal", channel: "beta" });

  await page.reload();
  await expect(page.getByRole("article", { name: "Updates" })).toContainText("wartet auf den nächsten Abgleich");
  expect(existsSync(orderFile)).toBe(true);
  expect(errors).toEqual([]);
});

test("Verwaltung → System: Neustart nötig bei Passphrase – Hinweis, rot nach 14 Tagen, „Jetzt neu starten“ als Auftrag (Q5-18)", async ({ page }) => {
  rmSync(orderFile, { force: true });
  writeStatus({ reboot: { since: new Date(Date.now() - 3 * 86_400_000).toISOString(), reason: "passphrase" } });
  const errors = collectErrors(page);
  await login(page, "admin");
  await page.goto("/verwaltung/system");
  const card = page.getByRole("article", { name: "Neustart nötig" });
  await expect(card).toContainText("Passphrase erforderlich");
  await expect(card).toContainText("(3 Tage)");
  page.once("dialog", (d) => void d.accept());
  await card.getByRole("button", { name: "Jetzt neu starten" }).click();
  await expect(card.getByRole("status")).toContainText("Neustart beauftragt");
  expect(JSON.parse(readFileSync(orderFile, "utf8"))).toMatchObject({ version: 1, action: "neustart" });
  await page.reload();
  await expect(page.getByRole("article", { name: "Neustart nötig" }).getByRole("status")).toContainText("beim nächsten Abgleich");

  writeStatus({ reboot: { since: new Date(Date.now() - 15 * 86_400_000).toISOString(), reason: "passphrase" } });
  await page.reload();
  await expect(page.getByRole("article", { name: "Neustart nötig" })).toContainText("seit 15 Tagen überfällig");
  writeStatus();
  await page.reload();
  await expect(page.getByRole("article", { name: "Neustart nötig" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// Nur lokal mit Mailpit (docker run -p 1025:1025 -p 8025:8025 axllent/mailpit) und SCHULOS_SMTP_*/SCHULOS_ALARM_TO in der Umgebung:
// E2E_MAILPIT=http://127.0.0.1:8025 SCHULOS_SMTP_HOST=127.0.0.1 SCHULOS_SMTP_PORT=1025 … npm run e2e -- -g Testmail (127.0.0.1: localhost probiert unter
// Windows erst IPv6 und wartet)
test("Verwaltung → System: Testmail kommt beim SMTP-Server an", async ({ page, request }) => {
  const mailpit = process.env.E2E_MAILPIT;
  test.skip(!mailpit, "ohne Mailpit");
  await request.delete(`${mailpit}/api/v1/messages`);
  const errors = collectErrors(page);
  await login(page, "admin");
  await page.goto("/verwaltung/system");
  const card = page.getByRole("article", { name: "E-Mail-Benachrichtigung" });
  await expect(card).toContainText(process.env.SCHULOS_ALARM_TO ?? "");
  await card.getByRole("button", { name: "Testmail senden" }).click();
  await expect(card.getByRole("status")).toContainText("Testnachricht an");
  const list = (await (await request.get(`${mailpit}/api/v1/messages`)).json()) as { messages: { Subject: string; To: { Address: string }[] }[] };
  expect(list.messages[0]?.Subject).toBe("[SchulOS Gesamtschule am Lindenhof] Testnachricht");
  expect(errors).toEqual([]);
});
