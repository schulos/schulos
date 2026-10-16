import { expect, request, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// Q5-15: Kalender-Abo per widerrufbarem Link – ohne Sitzung abrufbar (nur lesend), von außen (Allowlist-Zone) gesperrt,
// nach dem Widerruf weg.
test("Kalender-Abo: Link anlegen, ohne Anmeldung abrufen, von außen gesperrt, widerrufen", async ({ page, baseURL }) => {
  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  await page.goto("/kalender");
  await page.getByRole("link", { name: "In der Kalender-App abonnieren" }).click();
  await expect(page.getByRole("heading", { name: "Kalender abonnieren", level: 1 })).toBeVisible();

  const form = page.getByRole("form", { name: "Abo-Link anlegen" });
  await form.getByLabel("Kalender").selectOption({ label: "Schule" });
  await form.getByLabel("Bezeichnung").fill("Handy");
  await form.getByRole("button", { name: "Link anlegen" }).click();
  const link = page.getByLabel("Abo-Link", { exact: true });
  await expect(link).toHaveValue(/\/api\/kalender\/abo\/[A-Za-z0-9_-]{43}$/);
  const path = new URL(await link.inputValue()).pathname;
  await page.screenshot({ path: ".data/shots/e2e/kalender-abo.png", fullPage: true });

  // ohne Cookies – wie eine Kalender-App
  const anon = await request.newContext({ baseURL });
  const res = await anon.get(path);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/calendar");
  expect(res.headers()["cache-control"]).toContain("no-store");
  expect(await res.text()).toContain("BEGIN:VCALENDAR");
  // von außen (nur öffentliche Seiten) gesperrt
  expect((await anon.get(path, { headers: { "x-schulos-extern": "1" } })).status()).toBe(403);
  expect((await anon.get("/api/kalender/abo/kein-gueltiger-link")).status()).toBe(404);

  await page.reload();
  const row = page.getByRole("table", { name: "Meine Abo-Links" }).getByRole("row").filter({ hasText: "Handy" });
  await expect(row).toContainText("Schule");
  await row.getByRole("button", { name: "Abo-Link Handy widerrufen" }).click();
  await expect(page.getByRole("table", { name: "Meine Abo-Links" })).toHaveCount(0);
  expect((await anon.get(path)).status()).toBe(404);
  await anon.dispose();
  expect(errors).toEqual([]);
});
