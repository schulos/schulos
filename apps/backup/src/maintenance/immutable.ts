// SEC-11 (Ransomware): unveränderliche Kopie der Offsite-Kopie. Die bestehende Offsite-Kopie (B-37, offsite.ts) schreibt und
// räumt auf – wer den Backupserver übernimmt, könnte sie löschen. Unveränderlich macht sie erst das Ziel selbst: Schnappschüsse,
// die nur der Anbieter anlegt und löscht (z. B. Hetzner Storage Box: automatische Schnappschüsse, per SFTP nur lesbar unter
// `.zfs/snapshot`). Kein zweiter Kopiermechanismus – SchulOS prüft nur täglich, ob der neueste Schnappschuss frisch ist und die
// Offsite-Kopie dieser Instanz enthält („letzte unveränderliche Kopie“), meldet das an das Hauptsystem (Plan) und alarmiert.
//   SCHULOS_OFFSITE_SNAPSHOTS=<rclone-remote>:<pfad der Schnappschüsse>   z. B. offsite:.zfs/snapshot
//   SCHULOS_OFFSITE_SNAPSHOT_MAX_HOURS=48                                  älter → Prüfung fehlgeschlagen (Alarm)
import { lastLine } from "@schulos/server/exec";
import { IMMUTABLE_MAX_HOURS } from "@schulos/server/agent-api";
import { listSnapshots, ResticFailed, type LocalRestic } from "@/restic/local";
import type { OffsiteConfig } from "./offsite";

export interface SnapshotConfig {
  /** rclone-Pfad, unter dem je Schnappschuss ein Ordner liegt */
  root: string;
  maxHours: number;
}

const TARGET = /^[A-Za-z0-9_-]+:[^\s'"`$\\]*$/;

export function snapshotConfig(
  env: Record<string, string | undefined> = process.env,
): SnapshotConfig | null {
  const v = env.SCHULOS_OFFSITE_SNAPSHOTS?.trim();
  if (!v) return null;
  if (!TARGET.test(v))
    throw new Error(
      `SCHULOS_OFFSITE_SNAPSHOTS="${v}" ist kein rclone-Pfad der Form remote:pfad`,
    );
  const h = Number(
    env.SCHULOS_OFFSITE_SNAPSHOT_MAX_HOURS ?? IMMUTABLE_MAX_HOURS,
  );
  return {
    root: v.replace(/\/+$/, ""),
    maxHours: Number.isFinite(h) && h >= 1 ? h : IMMUTABLE_MAX_HOURS,
  };
}

interface Entry {
  Name: string;
  ModTime?: string;
  IsDir?: boolean;
}

/** Zeitpunkt eines Schnappschusses: Datum im Namen (2026-10-14T01-00-00, 2026-10-14_0100 …), sonst Änderungszeit des Ordners */
export function snapshotTime(e: Entry): Date | null {
  const m =
    /(\d{4})-(\d{2})-(\d{2})[T_ -]?(\d{2})?[-:]?(\d{2})?[-:]?(\d{2})?/.exec(
      e.Name,
    );
  if (m) {
    const d = new Date(
      Date.UTC(
        +m[1]!,
        +m[2]! - 1,
        +m[3]!,
        +(m[4] ?? 0),
        +(m[5] ?? 0),
        +(m[6] ?? 0),
      ),
    );
    if (!Number.isNaN(d.getTime())) return d;
  }
  const t = e.ModTime ? new Date(e.ModTime) : null;
  return t && !Number.isNaN(t.getTime()) ? t : null;
}

export interface ImmutableResult {
  /** Zeitpunkt des neuesten Schnappschusses, der die Offsite-Kopie dieser Instanz enthält (ISO) */
  letzteKopie: string;
  schnappschuss: string;
  alterStunden: number;
  /** G4E-O07: inhaltliche Stichprobe (nur mit Repository-Passwort) */
  staende?: number;
  neuesterStand?: string | null;
  packs?: number;
  packBytes?: number;
}

/** G4E-O07: ab diesem Schwund der Pack-Daten gegenüber der letzten guten Prüfung → Alarm (Ransomware löscht/ersetzt Packs) */
export const PACK_SHRINK_ALARM = 0.5;

/**
 * G4E-O07: Inhalt der Kopie im Schnappschuss prüfen statt nur „Datei config da“ – die Sicherungsstände müssen sich mit dem
 * Repository-Passwort entschlüsseln lassen (`restic snapshots --no-lock` direkt im nur lesbaren Schnappschuss; verschlüsselte oder
 * ersetzte Dateien fallen auf), mindestens ein Stand muss da sein, und die Pack-Daten dürfen gegenüber der letzten guten Prüfung
 * nicht stark geschrumpft sein. Grenze: ob jedes einzelne Pack noch lesbar ist, prüft das nicht (das bräuchte einen vollen
 * `restic check --read-data` auf dem Ziel) – INSTALLATION.md §4.3a.
 */
export async function verifyImmutableCopy(
  ctx: LocalRestic,
  dir: string,
  password: string,
  previousBytes: number | null,
): Promise<Pick<ImmutableResult, "staende" | "neuesterStand" | "packs" | "packBytes">> {
  let snaps;
  try {
    snaps = await listSnapshots(ctx, "", password, `rclone:${dir}`);
  } catch (err) {
    throw new ResticFailed(
      `Kopie im Schnappschuss nicht lesbar – verschlüsselt, ersetzt oder beschädigt? (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!snaps.length) throw new ResticFailed("Kopie im Schnappschuss enthält keinen Sicherungsstand – gelöscht?");
  const rclone = ctx.rclone ?? "rclone";
  const r = await ctx.exec(rclone, ["size", "--json", `${dir}/data`]);
  if (r.code !== 0) throw new ResticFailed(`Pack-Daten im Schnappschuss nicht lesbar: ${lastLine(r.stderr)}`);
  let size: { count?: unknown; bytes?: unknown };
  try {
    size = JSON.parse(r.stdout) as typeof size;
  } catch {
    throw new ResticFailed("Pack-Daten im Schnappschuss: unerwartete Antwort von rclone");
  }
  const packs = Number(size.count);
  const packBytes = Number(size.bytes);
  if (!Number.isFinite(packs) || !Number.isFinite(packBytes) || packs < 1)
    throw new ResticFailed("Kopie im Schnappschuss ohne Pack-Daten – gelöscht?");
  if (previousBytes && packBytes < previousBytes * PACK_SHRINK_ALARM)
    throw new ResticFailed(
      `Pack-Daten im Schnappschuss stark geschrumpft (${Math.round(packBytes / 1e6)} MB statt zuletzt ${Math.round(previousBytes / 1e6)} MB) – gelöscht oder ersetzt? Offsite-Ziel und Anbieter-Schnappschüsse prüfen`,
    );
  return { staende: snaps.length, neuesterStand: snaps[0]?.time.toISOString() ?? null, packs, packBytes };
}

/** Pfad der Offsite-Kopie innerhalb des Ziels: „storagebox:schulos“ → „schulos“ */
function relative(base: string): string {
  return base.slice(base.indexOf(":") + 1).replace(/^\/+|\/+$/g, "");
}

/**
 * Neuester Schnappschuss, der die Offsite-Kopie der Instanz (Datei `config` des Repositorys) enthält. Wirft ResticFailed, wenn
 * es keinen gibt; `alterStunden` > maxHours wertet der Aufrufer als Fehler (Ergebnis bleibt sichtbar).
 */
export async function checkImmutable(
  ctx: LocalRestic,
  offsite: OffsiteConfig,
  snaps: SnapshotConfig,
  restUser: string,
  now = new Date(),
  /** G4E-O07: mit Repository-Passwort zusätzlich den Inhalt prüfen */
  verify?: { password: string; previousBytes: number | null },
): Promise<ImmutableResult> {
  const rclone = ctx.rclone ?? "rclone";
  const r = await ctx.exec(rclone, ["lsjson", "--dirs-only", snaps.root]);
  if (r.code === 127)
    throw new ResticFailed("rclone ist auf diesem Server nicht installiert.");
  if (r.code !== 0)
    throw new ResticFailed(
      `Schnappschüsse des Offsite-Ziels nicht lesbar: ${lastLine(r.stderr)}`,
    );
  let list: Entry[];
  try {
    list = JSON.parse(r.stdout) as Entry[];
  } catch {
    throw new ResticFailed(
      "Schnappschüsse des Offsite-Ziels: unerwartete Antwort von rclone",
    );
  }
  const dated = list
    .filter(
      (e) =>
        e &&
        typeof e.Name === "string" &&
        e.IsDir !== false &&
        !e.Name.includes("/"),
    )
    .map((e) => ({ name: e.Name, at: snapshotTime(e) }))
    .filter(
      (e): e is { name: string; at: Date } =>
        e.at !== null && e.at.getTime() <= now.getTime() + 3600_000,
    )
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  if (!dated.length)
    throw new ResticFailed(
      `Keine Schnappschüsse unter ${snaps.root} – beim Anbieter automatische Schnappschüsse einschalten`,
    );
  const rel = relative(offsite.base);
  // die neuesten zuerst; der erste, der die Kopie dieser Instanz enthält, zählt
  for (const s of dated.slice(0, 5)) {
    const dir = [snaps.root, s.name, rel, restUser].filter(Boolean).join("/");
    const f = await ctx.exec(rclone, ["lsf", "--files-only", dir]);
    if (f.code === 0 && f.stdout.split(/\r?\n/).includes("config"))
      return {
        letzteKopie: s.at.toISOString(),
        schnappschuss: s.name,
        alterStunden: Math.round((now.getTime() - s.at.getTime()) / 3600_000),
        ...(verify ? await verifyImmutableCopy(ctx, dir, verify.password, verify.previousBytes) : {}),
      };
  }
  throw new ResticFailed(
    `Kein Schnappschuss enthält die Offsite-Kopie dieser Instanz (${rel}/${restUser}) – liegt die Offsite-Kopie im geschützten Bereich?`,
  );
}
