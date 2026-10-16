// Screenshots vom gebauten Server: startet `next start`, meldet sich an, fotografiert Seiten.
// Aufruf: node scripts/shot.mjs --user jana.brandt [--mobile] [--dark] dev/ui verwaltung
// Bilder landen in .data/shots/ (gitignored). Pfade ohne führenden Slash (Git Bash).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const user = opt("user", "jana.brandt");
const skip = new Set([opt("user"), opt("port"), opt("out")]);
const pages = args.filter((a) => !a.startsWith("--") && !skip.has(a));
const port = opt("port", "3125");
const outDir = opt("out", ".data/shots");
const base = `http://localhost:${port}`;
mkdirSync(outDir, { recursive: true });

try {
  await fetch(base);
  console.error(`Port ${port} ist belegt.`);
  process.exit(2);
} catch {}

const server = spawn(`npx next start -p ${port}`, { shell: true, stdio: "ignore" });
const kill = () =>
  process.platform === "win32"
    ? spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" })
    : server.kill();

let browser;
try {
  for (let i = 0; ; i++) {
    try {
      await fetch(`${base}/login`);
      break;
    } catch {
      if (i > 60) throw new Error("Server kam nicht hoch");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: flag("mobile") ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    deviceScaleFactor: flag("mobile") ? 2 : 1,
    colorScheme: flag("dark") ? "dark" : "light",
    locale: "de-DE",
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  if (user !== "none") {
    await page.goto(`${base}/login`);
    await page.getByLabel("Benutzername").fill(user);
    await page.getByLabel("Passwort").fill(opt("password", "schulos"));
    await page.getByRole("button", { name: "Anmelden" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
  }
  const suffix = `${user}${flag("mobile") ? "-mobile" : ""}${flag("dark") ? "-dark" : ""}`;
  for (const p of pages.length ? pages : [""]) {
    await page.goto(`${base}/${p.replace(/^\/+/, "")}`);
    await page.waitForLoadState("networkidle");
    // Pfade mit Query (?woche=…) ergeben sonst unter Windows ungültige Dateinamen
    const file = `${outDir}/${(p || "home").replace(/[\\/?&=:*"<>|]/g, "_")}-${suffix}.png`;
    await page.screenshot({ path: file, fullPage: flag("full") });
    console.log(`${page.url()} → ${file}`);
  }
  if (errors.length) console.log("Browser-Fehler:\n" + errors.join("\n"));
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser?.close();
  kill();
}
