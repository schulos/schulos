// restic auf dem Backupserver – direkt auf dem Repository-Ordner des rest-servers (nicht über den append-only-Zugang).
// Nur hier wird gelöscht (Prune). Das Repository-Passwort kommt verschlüsselt aus der DB, nur über die Umgebung an restic.
import path from "node:path";
import { exec as realExec, lastLine, type Exec } from "@schulos/server/exec";
import type { Retention } from "@schulos/server/backup-retention";

export interface LocalRestic {
  exec: Exec;
  bin: string;
  restDir: string;
  /** rclone für die Offsite-Kopie (B-37) */
  rclone?: string;
}

export function localRestic(): LocalRestic {
  return {
    exec: realExec,
    bin: process.env.RESTIC_BIN ?? "restic",
    restDir: process.env.SCHULOS_REST_DIR ?? path.join(process.cwd(), ".data", "rest"),
    rclone: process.env.RCLONE_BIN ?? "rclone",
  };
}

export class ResticFailed extends Error {}

/** repository: anderes Ziel als das lokale Repository (Offsite-Kopie, z. B. rclone:offsite:schulos/i-ab12) */
function env(ctx: LocalRestic, restUser: string, password: string, repository?: string) {
  return { RESTIC_REPOSITORY: repository ?? path.join(ctx.restDir, restUser), RESTIC_PASSWORD: password };
}

export interface SnapshotInfo {
  id: string;
  shortId: string;
  time: Date;
  host: string;
  tags: string[];
  /** Größe der gesicherten Daten (restic ≥ 0.17 speichert eine Zusammenfassung im Snapshot) */
  bytes: number | null;
}

/** Aus `restic snapshots --json` (neueste zuerst). */
export function parseSnapshots(stdout: string): SnapshotInfo[] {
  const list = JSON.parse(stdout || "[]") as {
    id: string;
    short_id: string;
    time: string;
    hostname: string;
    tags?: string[];
    summary?: { total_bytes_processed?: number };
  }[];
  return list
    .map((s) => ({ id: s.id, shortId: s.short_id, time: new Date(s.time), host: s.hostname, tags: s.tags ?? [], bytes: s.summary?.total_bytes_processed ?? null }))
    .sort((a, b) => b.time.getTime() - a.time.getTime());
}

export async function listSnapshots(ctx: LocalRestic, restUser: string, password: string, repository?: string): Promise<SnapshotInfo[]> {
  const r = await ctx.exec(ctx.bin, ["snapshots", "--json", "--no-lock"], { env: env(ctx, restUser, password, repository) });
  if (r.code === 10) return []; // noch kein Repository (Agent hat noch nicht gesichert)
  if (r.code === 127) throw new ResticFailed("restic ist auf diesem Server nicht installiert.");
  if (r.code !== 0) throw new ResticFailed(`Snapshots nicht lesbar: ${lastLine(r.stderr)}`);
  return parseSnapshots(r.stdout);
}

/** Aus `restic forget --json`: je Gruppe keep/remove. */
export function parseForget(stdout: string): { kept: number; removed: number } {
  const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith("["));
  if (!line) return { kept: 0, removed: 0 };
  const groups = JSON.parse(line) as { keep?: unknown[]; remove?: unknown[] | null }[];
  return groups.reduce((acc, g) => ({ kept: acc.kept + (g.keep?.length ?? 0), removed: acc.removed + (g.remove?.length ?? 0) }), { kept: 0, removed: 0 });
}

/** Aufräumen nach der Aufbewahrung: forget + prune. Wartet bis zu 10 min auf eine laufende Sicherung (Sperre). */
export async function forgetAndPrune(ctx: LocalRestic, restUser: string, password: string, r: Retention, repository?: string): Promise<{ kept: number; removed: number }> {
  const args = ["forget", "--json", "--prune", "--retry-lock", "10m", "--keep-daily", String(r.daily)];
  if (r.weekly) args.push("--keep-weekly", String(r.weekly));
  if (r.monthly) args.push("--keep-monthly", String(r.monthly));
  const res = await ctx.exec(ctx.bin, args, { env: env(ctx, restUser, password, repository) });
  if (res.code === 10) return { kept: 0, removed: 0 };
  if (res.code === 127) throw new ResticFailed("restic ist auf diesem Server nicht installiert.");
  if (res.code !== 0) throw new ResticFailed(`Aufräumen fehlgeschlagen: ${lastLine(res.stderr)}`);
  return parseForget(res.stdout);
}

/** Unversehrtheit: Struktur + Stichprobe der Daten (Vorgabe 5 %, wöchentlich wechselnd – über Wochen wird alles gelesen). */
export async function check(ctx: LocalRestic, restUser: string, password: string, subset = "5%"): Promise<{ readSubset: string }> {
  const r = await ctx.exec(ctx.bin, ["check", "--retry-lock", "10m", `--read-data-subset=${subset}`], { env: env(ctx, restUser, password) });
  if (r.code === 127) throw new ResticFailed("restic ist auf diesem Server nicht installiert.");
  if (r.code === 10) throw new ResticFailed("Noch kein Repository – der Agent hat noch nicht gesichert.");
  if (r.code !== 0) throw new ResticFailed(`Prüfung fehlgeschlagen: ${lastLine(r.stderr || r.stdout)}`);
  return { readSubset: subset };
}

/** Pfad des Datenbank-Dumps im Snapshot (so legt ihn der Agent ab). */
export const DUMP_PATH = "/tmp/schulos-agent/datenbank/schulos.dump";

/** Nur den Datenbank-Dump des neuesten Stands zurückholen (mit --verify: Inhalt gegen den Snapshot geprüft). */
export async function restoreDump(ctx: LocalRestic, restUser: string, password: string, target: string): Promise<{ snapshot: string; file: string }> {
  // erst den neuesten Stand bestimmen – so steht im Protokoll, welcher Stand geprüft wurde
  const [latest] = await listSnapshots(ctx, restUser, password);
  if (!latest) throw new ResticFailed("Noch keine Sicherung vorhanden.");
  const r = await ctx.exec(ctx.bin, ["restore", latest.id, "--target", target, "--include", DUMP_PATH, "--verify"], { env: env(ctx, restUser, password) });
  if (r.code === 127) throw new ResticFailed("restic ist auf diesem Server nicht installiert.");
  if (r.code !== 0) throw new ResticFailed(`Zurückholen fehlgeschlagen: ${lastLine(r.stderr)}`);
  return { snapshot: latest.shortId, file: path.join(target, DUMP_PATH) };
}
