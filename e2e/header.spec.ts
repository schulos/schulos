import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test("Sicherheits-Header: CSP mit Nonce je Anfrage, feste Header, Cookies httpOnly + SameSite", async ({ page, request }) => {
  const a = await request.get("/login");
  const b = await request.get("/login");
  const csp = a.headers()["content-security-policy"]!;
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  expect(nonce).toBeTruthy();
  expect(b.headers()["content-security-policy"]).not.toContain(nonce!);
  expect(csp).toContain("frame-ancestors 'self'");
  expect(csp).not.toContain("unsafe-eval");
  // Next setzt den Nonce in seine Skripte
  const html = await a.text();
  expect(html).toContain(`nonce="${nonce}"`);

  const h = a.headers();
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("SAMEORIGIN");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["permissions-policy"]).toContain("camera=()");
  expect(h["strict-transport-security"]).toContain("max-age=");
  expect(h["x-powered-by"]).toBeUndefined();
  // auch API-Antworten
  expect((await request.get("/api/health")).headers()["x-content-type-options"]).toBe("nosniff");
  // keine Seiten-CSP auf API-Antworten – sonst überschreibt sie die sandbox-CSP der Datei-Routen (S8)
  expect((await request.get("/api/health")).headers()["content-security-policy"]).toBeUndefined();

  const errors = collectErrors(page);
  await login(page, "jana.brandt");
  const session = (await page.context().cookies()).find((c) => c.name.endsWith("session_token"));
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Lax");
  // Seiten mit Theme-Skript, Fachfarben (style-Attribute) und Live-Verbindung laufen ohne CSP-Verstoß
  for (const path of ["/", "/stundenplan", "/dateien", "/messenger"]) await page.goto(path);
  await page.getByRole("button", { name: /Jana Brandt/ }).click();
  await page.getByRole("menuitemradio", { name: "Dunkel" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(errors.filter((e) => /Content Security Policy|Refused to/i.test(e))).toEqual([]);
  expect(errors).toEqual([]);
});
