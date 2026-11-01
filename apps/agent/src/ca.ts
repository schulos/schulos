// CA-01: Schlüssel der eigenen Zertifizierungsstellen ins Backup und bei einer Wiederherstellung zurück.
//  · Caddy (Volume caddy_data): Wurzelzertifikat + -schlüssel der eigenen CA („tls internal“). Ohne sie erzeugt Caddy nach einer
//    Wiederherstellung eine neue Wurzel – alle Geräte, denen die alte vertraut, melden dann Zertifikatsfehler.
//  · step-ca (Volume step_ca, Profil „geraete“): die ganze Schul-CA für Gerätezertifikate (Schlüssel mit
//    SCHULOS_DEVICE_CA_PASSWORD verschlüsselt – das Passwort steht nur in der .env/im Notfallordner, nicht im Backup).
// Der Agent liest beide Volumes nur. Zurückgespielt wird über je einen Übergabeordner: Caddy bzw. step-ca übernehmen den Stand
// beim nächsten Start selbst (compose.yaml, caddy-start/step-ca-start) – mit ihrem eigenen Besitzer und Rechten 600.
// Die Schlüssel stehen nur im verschlüsselten restic-Repository, nie in Logs, Meldungen oder im Support-Bundle.
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentConfig } from "./config";
import { dumpFile, ResticError, restoreSnapshot, type ResticContext } from "./restic";

/** Ordner der eigenen CA in Caddys Datenordner (XDG_DATA_HOME=/data im Caddy-Image) */
export const CADDY_CA_SUBDIR = path.join("caddy", "pki", "authorities", "local");

export function caddyRootFiles(cfg: Pick<AgentConfig, "caddyDataDir">): { crt: string; key: string } {
  const dir = path.join(cfg.caddyDataDir, CADDY_CA_SUBDIR);
  return { crt: path.join(dir, "root.crt"), key: path.join(dir, "root.key") };
}

export const stepCaRoot = (cfg: Pick<AgentConfig, "stepCaDir">) => path.join(cfg.stepCaDir, "certs", "root_ca.crt");
const stepCaConfig = (dir: string) => path.join(dir, "config", "ca.json");

function access(file: string): "ok" | "fehlt" | "gesperrt" {
  try {
    accessSync(file, constants.R_OK);
    return "ok";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "fehlt" : "gesperrt";
  }
}

function readIfPossible(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Zusätzliche Pfade für `restic backup`: nur, was es gibt und was der Agent lesen darf – sonst bräche restic mit „Datei nicht
 * lesbar“ die ganze Sicherung ab. Fehlt etwas (step-ca nicht eingerichtet, Caddy mit Let's Encrypt), ist das kein Fehler.
 */
export function caBackupPaths(cfg: AgentConfig, log: (msg: string) => void): string[] {
  const out: string[] = [];
  const { crt, key } = caddyRootFiles(cfg);
  const caddy = [access(crt), access(key)];
  if (caddy.every((a) => a === "ok")) out.push(crt, key);
  else if (caddy.includes("gesperrt"))
    log("Wurzel der Caddy-CA nicht lesbar – nicht gesichert. Caddy neu starten (gibt dem Agenten Leserecht): docker compose restart caddy");
  if (access(stepCaConfig(cfg.stepCaDir)) === "ok") out.push(cfg.stepCaDir);
  return out;
}

export interface CaRestoreDetails {
  caddyCa: string;
  geraeteCa: string;
}

/**
 * Stand der CAs an Caddy bzw. step-ca übergeben. Nur wenn der Stand sie enthält und sie sich vom laufenden System unterscheiden
 * (sonst „unverändert“) – Caddy erneuert bei einer neuen Wurzel auch Zwischen- und Serverzertifikate.
 * Fehler hier brechen die Wiederherstellung nicht ab (Datenbank und Dateien sind schon zurück); sie stehen im Ergebnis.
 */
export async function stageCaRestore(cfg: AgentConfig, ctx: ResticContext, snapshotId: string, paths: string[]): Promise<CaRestoreDetails> {
  const attempt = async (fn: () => Promise<string>) => {
    try {
      return await fn();
    } catch (err) {
      return `nicht zurückgespielt: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
    }
  };
  return {
    caddyCa: await attempt(() => stageCaddy(cfg, ctx, snapshotId, paths)),
    geraeteCa: await attempt(() => stageStepCa(cfg, ctx, snapshotId, paths)),
  };
}

async function stageCaddy(cfg: AgentConfig, ctx: ResticContext, snapshotId: string, paths: string[]): Promise<string> {
  const { crt, key } = caddyRootFiles(cfg);
  if (!paths.includes(crt) || !paths.includes(key)) return "nicht im Stand";
  const target = cfg.caddyCaRestoreDir;
  if (!existsSync(target)) throw new ResticError(`Übergabeordner ${target} fehlt (compose.yaml aktualisieren)`);
  const root = await dumpFile(ctx, snapshotId, crt);
  if (!root.includes("BEGIN CERTIFICATE")) throw new ResticError("Wurzelzertifikat im Stand unlesbar");
  if (readIfPossible(crt) === root) return "unverändert";
  const rootKey = await dumpFile(ctx, snapshotId, key);
  if (!rootKey.includes("PRIVATE KEY")) throw new ResticError("Wurzelschlüssel im Stand unlesbar");
  // 0640: Caddy (root, Gruppe 1000) liest die Übergabe und löscht sie nach der Übernahme; der Schlüssel zuerst, das Zertifikat
  // zuletzt – Caddy übernimmt nur, wenn beide da sind
  writeAtomic(path.join(target, "root.key"), rootKey, 0o640);
  writeAtomic(path.join(target, "root.crt"), root, 0o640);
  return "bereitgelegt – Caddy übernimmt sie beim nächsten Start";
}

async function stageStepCa(cfg: AgentConfig, ctx: ResticContext, snapshotId: string, paths: string[]): Promise<string> {
  if (!paths.includes(cfg.stepCaDir)) return "nicht im Stand";
  const target = cfg.stepCaRestoreDir;
  if (!existsSync(target)) throw new ResticError(`Übergabeordner ${target} fehlt (compose.yaml aktualisieren)`);
  const root = await dumpFile(ctx, snapshotId, stepCaRoot(cfg));
  if (readIfPossible(stepCaRoot(cfg)) === root) return "unverändert";
  // erst vollständig zurückholen, dann umbenennen – step-ca übernimmt nur einen fertigen Stand (Ordner „stand“)
  const tmp = path.join(target, "neu");
  const done = path.join(target, "stand");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  await restoreSnapshot(ctx, snapshotId, tmp, [], { overwrite: "always", sub: cfg.stepCaDir });
  if (!existsSync(stepCaConfig(tmp))) throw new ResticError("Schul-CA im Stand unvollständig (config/ca.json fehlt)");
  rmSync(done, { recursive: true, force: true });
  renameSync(tmp, done);
  return "bereitgelegt – step-ca übernimmt sie beim nächsten Start";
}

function writeAtomic(file: string, text: string, mode: number) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, file);
}
