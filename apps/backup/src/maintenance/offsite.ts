// Offsite-Kopie (B-37, INSTALLATION.md §4): jede Instanz täglich vom Backupserver auf ein zweites Ziel außer Haus –
// SFTP (z. B. Storage Box), S3 und alles, was rclone kann. Ziel: SCHULOS_OFFSITE=<rclone-remote>:<pfad>, der Remote selbst
// über rclone-Umgebungsvariablen (RCLONE_CONFIG_<NAME>_TYPE …) in backup.env.
//
// Das Offsite-Repository bekommt `config` und `keys/` 1:1 aus dem Repository des Backupservers: gleicher Hauptschlüssel,
// also öffnen es Repository-Passwort **und** Wiederherstellungsschlüssel der Schule – genau der Fall „beide Server
// verloren, nur die Offsite-Kopie ist übrig“. Danach `restic copy` (nur neue Stände, Inhalte geprüft) und Aufräumen mit
// derselben Aufbewahrung wie die Instanz. Gelöscht wird offsite nur über diese Aufbewahrung, nie durch einen Abgleich.
import path from "node:path";
import { lastLine } from "@schulos/server/exec";
import { forgetAndPrune, listSnapshots, ResticFailed, type LocalRestic } from "@/restic/local";
import type { Retention } from "@schulos/server/backup-retention";

export interface OffsiteConfig {
  /** rclone-Ziel ohne Instanz, z. B. „storagebox:schulos“ */
  base: string;
}

const TARGET = /^[A-Za-z0-9_-]+:[^\s'"`$\\]*$/;

/** Offsite-Ziel aus SCHULOS_OFFSITE (rclone-Remote:Pfad); ohne Angabe gibt es keine Offsite-Kopie. */
export function offsiteConfig(env: Record<string, string | undefined> = process.env): OffsiteConfig | null {
  const v = env.SCHULOS_OFFSITE?.trim();
  if (!v) return null;
  if (!TARGET.test(v)) throw new Error(`SCHULOS_OFFSITE="${v}" ist kein rclone-Ziel der Form remote:pfad`);
  return { base: v.replace(/\/+$/, "") };
}

export function offsiteTarget(cfg: OffsiteConfig, restUser: string): string {
  return `${cfg.base}/${restUser}`;
}

export interface OffsiteResult {
  /** neuester Stand im Offsite-Repository */
  stand: string | null;
  staende: number;
  kopiert: number;
  entfernt: number;
}

/** Offsite-Kopie einer Instanz. Wirft ResticFailed mit verständlicher Meldung. */
export async function offsiteCopy(ctx: LocalRestic, cfg: OffsiteConfig, restUser: string, password: string, retention: Retention): Promise<OffsiteResult> {
  const rclone = ctx.rclone ?? "rclone";
  const src = path.join(ctx.restDir, restUser);
  const dest = offsiteTarget(cfg, restUser);
  const repo = `rclone:${dest}`;

  const before = await listSnapshots(ctx, restUser, password);
  if (!before.length) throw new ResticFailed("Noch keine Sicherung – nichts zu kopieren.");

  // 1. Hauptschlüssel und Repository-Kennung (neue Schlüssel, z. B. nach einer Ersatz-Kopplung, kommen dazu)
  for (const [from, to] of [
    [path.join(src, "config"), dest],
    [path.join(src, "keys"), `${dest}/keys`],
  ] as const) {
    const r = await ctx.exec(rclone, ["copy", from, to]);
    if (r.code === 127) throw new ResticFailed("rclone ist auf diesem Server nicht installiert.");
    if (r.code !== 0) throw new ResticFailed(`Offsite-Ziel nicht erreichbar: ${lastLine(r.stderr)}`);
  }
  const offsiteBefore = await listSnapshots(ctx, restUser, password, repo);

  // 2. neue Stände kopieren
  const copy = await ctx.exec(ctx.bin, ["copy", "--retry-lock", "10m", "--from-repo", src], {
    env: { RESTIC_REPOSITORY: repo, RESTIC_PASSWORD: password, RESTIC_FROM_PASSWORD: password },
  });
  if (copy.code !== 0) throw new ResticFailed(`Offsite-Kopie fehlgeschlagen: ${lastLine(copy.stderr)}`);

  // 3. gleiche Aufbewahrung wie auf dem Backupserver
  const pruned = await forgetAndPrune(ctx, restUser, password, retention, repo);
  const after = await listSnapshots(ctx, restUser, password, repo);
  const known = new Set(offsiteBefore.map((s) => s.id));
  return {
    stand: after[0]?.shortId ?? null,
    staende: after.length,
    kopiert: after.filter((s) => !known.has(s.id)).length,
    entfernt: pruned.removed,
  };
}
