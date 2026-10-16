// restic gegen das Repository auf dem Backupserver (rest-server, append-only). Zugangsdaten nur über die Umgebung
// des Kindprozesses – nie in Argumenten (sonst stünden sie in `ps`).
import path from "node:path";
import { SNAPSHOT_ID } from "@schulos/server/agent-api";
import type { StoredPairing } from "@schulos/server/pairing-client";
import { lastLine, type Exec } from "@schulos/server/exec";

/** restic-Exitcode „Repository existiert nicht“ (ab restic 0.17). */
export const EXIT_NO_REPOSITORY = 10;

export interface ResticContext {
  exec: Exec;
  bin: string;
  pairing: StoredPairing | null;
  /** Repository direkt statt über die Kopplung (Offsite-Kopie: rclone-Ziel + Wiederherstellungsschlüssel) */
  repoEnv?: Record<string, string>;
  /** Datei mit der gepinnten CA (oder null bei öffentlichem Zertifikat) */
  caFile: string | null;
  /** Warten zwischen Versuchen (Tests: sofort) */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Direkt nach der Kopplung kennt der rest-server den neuen Zugang noch nicht: er liest seine .htpasswd nur etwa alle
 * 30 Sekunden neu (live gemessen). Beim ersten Zugriff wird ein 401 deshalb einige Male abgewartet.
 */
export const FIRST_ACCESS_RETRIES = 4;
export const FIRST_ACCESS_DELAY_MS = 15_000;

export class ResticError extends Error {}

/** Repository-Adresse mit Zugangsdaten, z. B. rest:https://i-ab12:geheim@backup.schule.de/restic/i-ab12/ */
export function repositoryUrl(p: Pick<StoredPairing, "repoUrl" | "restUser" | "restPassword">): string {
  const u = new URL(p.repoUrl);
  u.username = encodeURIComponent(p.restUser);
  u.password = encodeURIComponent(p.restPassword);
  return `rest:${u.toString()}`;
}

function env(ctx: ResticContext): Record<string, string> {
  if (ctx.repoEnv) return ctx.repoEnv;
  if (!ctx.pairing) throw new ResticError("Weder Kopplung noch Repository angegeben.");
  return { RESTIC_REPOSITORY: repositoryUrl(ctx.pairing), RESTIC_PASSWORD: ctx.pairing.repoPassword, ...(ctx.caFile ? { RESTIC_CACERT: ctx.caFile } : {}) };
}

/** Prüft das Repository; legt es beim ersten Lauf an und trägt den Wiederherstellungsschlüssel als zweiten Schlüssel ein. */
/** Erster Zugriff nach (Ersatz-)Kopplung: ein 401 einige Male abwarten, bis der rest-server den Zugang kennt. */
async function firstAccess(ctx: ResticContext, args: string[]) {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let r = await ctx.exec(ctx.bin, args, { env: env(ctx) });
  for (let i = 0; i < FIRST_ACCESS_RETRIES && r.code !== 0 && /\b401\b/.test(r.stderr); i++) {
    await sleep(FIRST_ACCESS_DELAY_MS);
    r = await ctx.exec(ctx.bin, args, { env: env(ctx) });
  }
  return r;
}

export async function ensureRepository(ctx: ResticContext, recoveryKeyFile: string | null): Promise<"vorhanden" | "angelegt"> {
  const check = await firstAccess(ctx, ["cat", "config", "--no-lock"]);
  if (check.code === 0) return "vorhanden";
  if (check.code !== EXIT_NO_REPOSITORY) throw new ResticError(`Repository nicht erreichbar: ${lastLine(check.stderr)}`);
  const init = await ctx.exec(ctx.bin, ["init"], { env: env(ctx) });
  if (init.code !== 0) throw new ResticError(`Repository anlegen fehlgeschlagen: ${lastLine(init.stderr)}`);
  if (recoveryKeyFile) {
    const add = await ctx.exec(ctx.bin, ["key", "add", "--new-password-file", recoveryKeyFile], { env: env(ctx) });
    if (add.code !== 0) throw new ResticError(`Wiederherstellungsschlüssel eintragen fehlgeschlagen: ${lastLine(add.stderr)}`);
  }
  return "angelegt";
}

export interface BackupSummary {
  snapshotId: string;
  bytesTotal: number;
  bytesAdded: number;
}

/** Zusammenfassung aus `restic backup --json` (letzte Zeile mit message_type "summary"). */
export function parseBackupSummary(stdout: string): BackupSummary | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (!line.includes('"summary"')) continue;
    try {
      const j = JSON.parse(line) as { message_type?: string; snapshot_id?: string; total_bytes_processed?: number; data_added?: number };
      if (j.message_type === "summary" && j.snapshot_id)
        return { snapshotId: j.snapshot_id, bytesTotal: j.total_bytes_processed ?? 0, bytesAdded: j.data_added ?? 0 };
    } catch {
      // keine JSON-Zeile
    }
  }
  return null;
}

export async function backup(ctx: ResticContext, paths: string[], tags: string[], host: string): Promise<BackupSummary> {
  // --retry-lock: räumt der Backupserver gerade auf (Prune, exklusive Sperre), wartet die Sicherung statt zu scheitern
  const args = ["backup", "--json", "--retry-lock", "30m", "--host", host, ...tags.flatMap((t) => ["--tag", t]), "--exclude", "*.tmp", "--", ...paths];
  const r = await ctx.exec(ctx.bin, args, { env: env(ctx) });
  // Exitcode 3: Snapshot angelegt, einzelne Dateien nicht lesbar – zählt als Fehler, damit es auffällt
  if (r.code !== 0) throw new ResticError(`restic backup fehlgeschlagen (${r.code}): ${lastLine(r.stderr)}`);
  const summary = parseBackupSummary(r.stdout);
  if (!summary) throw new ResticError("restic backup: keine Zusammenfassung erhalten");
  return summary;
}

/** Teile eines Stands zurückholen (mit --verify). `overwrite`: never = nur Fehlendes, always = genau der Stand. */
export async function restoreSnapshot(
  ctx: ResticContext,
  snapshotId: string,
  target: string,
  include: string[],
  opts: { overwrite: "never" | "always"; deleteExtra?: boolean; sub?: string },
): Promise<void> {
  // SEC-06: die ID kommt (bei Aufträgen) vom Backupserver – nur eine echte ID, und nach „--“, damit restic sie nie als Option liest
  if (!SNAPSHOT_ID.test(snapshotId)) throw new ResticError("Ungültige Snapshot-ID – Wiederherstellung abgebrochen.");
  if (opts.sub !== undefined && (!path.isAbsolute(opts.sub) || CONTROL_CHARS.test(opts.sub))) throw new ResticError("Ungültiger Ordner im Stand – Wiederherstellung abgebrochen.");
  const args = ["restore", "--target", target, "--verify", "--overwrite", opts.overwrite, ...include.flatMap((i) => ["--include", i])];
  if (opts.deleteExtra) args.push("--delete");
  // `<id>:<ordner>` (GATE-4e): nur den Inhalt des Ordners nach `target` – ohne die übergeordneten Ordner (/srv, /srv/schulos).
  // Deren Rechte/Zeiten darf der Agent seit SEC-13 (nicht root) nicht setzen; restic meldete das als Fehler und brach die
  // Wiederherstellung ab („There were 2 errors“, QEMU-Schritt 6).
  args.push("--", opts.sub ? `${snapshotId}:${opts.sub}` : snapshotId);
  const r = await ctx.exec(ctx.bin, args, { env: env(ctx) });
  if (r.code !== 0) throw new ResticError(`Zurückholen fehlgeschlagen: ${resticErrors(r.stderr)}`);
}

/** Steuerzeichen (Zeilenumbruch, NUL …) haben in einem Ordnernamen für restic nichts zu suchen */
const CONTROL_CHARS = /[\x00-\x1f]/;

/** Fehlerzeilen von restic (z. B. „ignoring error for /srv: …“) statt nur der letzten Zeile „There were N errors“ */
export function resticErrors(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errs = lines.filter((l) => /error|fatal|permission|denied/i.test(l) && !/^There were \d+ errors?$/i.test(l));
  const last = lines.at(-1) ?? "";
  return [...errs.slice(0, 3), ...(errs.includes(last) ? [] : [last])].join(" · ").slice(0, 600) || "unbekannter Fehler";
}

/** Eine Datei aus einem Stand lesen (`restic dump`) – ohne irgendetwas unter / anzulegen */
export async function dumpFile(ctx: ResticContext, snapshotId: string, file: string): Promise<string> {
  if (!SNAPSHOT_ID.test(snapshotId)) throw new ResticError("Ungültige Snapshot-ID – Wiederherstellung abgebrochen.");
  const r = await ctx.exec(ctx.bin, ["dump", "--", snapshotId, file], { env: env(ctx) });
  if (r.code !== 0) throw new ResticError(`${file} aus dem Stand lesen fehlgeschlagen: ${resticErrors(r.stderr)}`);
  return r.stdout;
}

/** Neuester Stand im Repository (über den rest-server; Lesen ist auch im append-only-Modus erlaubt). */
export async function latestSnapshot(ctx: ResticContext): Promise<{ id: string; shortId: string; time: string } | null> {
  const r = await firstAccess(ctx, ["snapshots", "latest", "--json", "--no-lock"]);
  if (r.code !== 0) throw new ResticError(`Stände nicht lesbar: ${lastLine(r.stderr)}`);
  const list = JSON.parse(r.stdout || "[]") as { id: string; short_id: string; time: string }[];
  const s = list.at(-1);
  return s ? { id: s.id, shortId: s.short_id, time: s.time } : null;
}
