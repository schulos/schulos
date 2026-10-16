// G4E-O18: Backup-Agent und Backup-App schreiben Datenbank-Dumps bzw. entpackte Test-Restores nach /tmp – seit SEC-13 ein Volume
// (agent_tmp, backup_tmp) statt Speicher. Nach einem Absturz oder Abbruch blieben dort Personendaten außerhalb jeder Löschfrist.
// Deshalb räumen beide regelmäßig auf: alles direkt unter /tmp, das älter als 24 h ist (ein laufender Dump oder Test-Restore –
// auch aus einem parallelen `docker compose run` – ist jünger und bleibt), außer dem restic-Zwischenspeicher `.cache`.
// Nur mit SCHULOS_TMP_AUFRAEUMEN=1 (compose.yaml/compose.backup.yaml) – nie auf einem Entwicklungsrechner.
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export const TMP_MAX_AGE_MS = 24 * 3600_000;

/** Entfernt alte Einträge; liefert ihre Namen (für das Protokoll). Fehler einzelner Einträge werden übersprungen. */
export function cleanTmpDir(
  dir = "/tmp",
  opts: { now?: number; maxAgeMs?: number; keep?: readonly string[]; env?: Record<string, string | undefined> } = {},
): string[] {
  const env = opts.env ?? process.env;
  if (env.SCHULOS_TMP_AUFRAEUMEN !== "1") return [];
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? TMP_MAX_AGE_MS;
  const keep = new Set(opts.keep ?? [".cache"]);
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    const p = path.join(dir, name);
    try {
      if (now - statSync(p).mtimeMs < maxAge) continue;
      rmSync(p, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // gerade gelöscht bzw. keine Rechte – beim nächsten Mal
    }
  }
  return removed;
}
