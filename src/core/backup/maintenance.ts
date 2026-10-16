// Wartungsmodus während einer Wiederherstellung (B-27): der Backup-Agent legt maintenance.json in den Konfigurationsordner,
// die App beantwortet dann alle Anfragen außer dem Healthcheck mit 503. Phase „neustart“: die App beendet sich, Docker startet sie
// neu (restart: unless-stopped), beim Start laufen die Migrationen auf der eingespielten Datenbank.
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { MAINTENANCE_FILE, type MaintenanceState } from "@schulos/server/agent-api";

export function configDirOf(env: Record<string, string | undefined> = process.env): string {
  return env.SCHULOS_CONFIG_DIR ?? path.join(process.cwd(), ".data", "config");
}

export function readMaintenance(dir = configDirOf()): MaintenanceState | null {
  const file = path.join(dir, MAINTENANCE_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as MaintenanceState;
  } catch {
    return { since: new Date().toISOString(), reason: "Wartung", phase: "wartung" };
  }
}

/** Einfache Wartungsseite (ohne Skripte, ohne externe Ressourcen – passt zur CSP). */
export function maintenancePage(m: MaintenanceState): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="20"><title>Wartung · SchulOS</title></head>
<body style="font-family:system-ui,sans-serif;background:#f4f5f7;color:#14181f;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="max-width:32rem;padding:2rem;background:#fff;border:1px solid #e3e6eb;border-radius:16px">
<h1 style="margin:0 0 .5rem;font-size:1.5rem">SchulOS wird gerade gewartet</h1>
<p>${esc(m.reason)}. Das dauert meist nur wenige Minuten – diese Seite lädt sich von selbst neu.</p>
</main></body></html>`;
}

const globalForWatch = globalThis as unknown as { __schulosMaintenanceWatch?: NodeJS.Timeout };

/** Wächter: Phase „neustart“ → Datei entfernen und Prozess beenden (Docker startet neu). */
export function watchMaintenance(dir = configDirOf(), exit: (code: number) => void = (c) => process.exit(c)): void {
  if (globalForWatch.__schulosMaintenanceWatch) return;
  globalForWatch.__schulosMaintenanceWatch = setInterval(() => {
    const m = readMaintenance(dir);
    if (m?.phase !== "neustart") return;
    rmSync(path.join(dir, MAINTENANCE_FILE), { force: true });
    console.log(`[schulos] ${m.reason} – Neustart, damit die Migrationen auf der eingespielten Datenbank laufen`);
    exit(0);
  }, 3000);
  globalForWatch.__schulosMaintenanceWatch.unref();
}
