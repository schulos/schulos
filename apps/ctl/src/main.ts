// schulosctl (B-31, INSTALLATION.md §5): Betrieb von SchulOS auf dem Host. Läuft direkt mit Node 24 (gebündelt zu
// dist/schulosctl.mjs, keine Abhängigkeiten) und steuert den Compose-Stack im Installationsordner über `docker compose`.
// Befehle im Container: App → `node cli.mjs …` (src/cli.ts), Backup-Agent → `node /opt/schulos-agent/agent.mjs …`.
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { AgentState } from "@schulos/server/agent-api";
import { exec, lastLine } from "@schulos/server/exec";
import { planUpdate, releaseNotesMarkdown, type Channel, type ReleaseManifest } from "@schulos/server/release";
import { assetDownloadUrl, CTL_FILE, CTL_RENEWED, dbRoleDeps, HOST_FILES, RELEASE_REPO, releaseKey, releasesFromDir, releasesFromGitHub, Stack, stackDeps, testRestore, type ReleaseAsset } from "./stack";
import { ensureDbRole } from "./db-role";
import { bundleImages, bundleInfo, checkImageArchive, loadedDigests } from "./bundle";
import { formatProtocolLine, lockFromBeforeBoot, readEnvValue, runUpdate, setEnvValues, type ProtocolEntry, type UpdateOutcome } from "./update";
import { buildStatus, nextRebootState, orderEffect, protocolTail, windowDecision, type Approval, type RebootPending } from "./system-sync";
import { prepareConsole } from "./konsole";
import { checkAfterBoot, nextCodename, runOsUpgrade } from "./os-upgrade";
import { MARKER as OS_MARKER, osDeps, rebootRequired } from "./os";
import {
  checkSchulprofilExport,
  isExternSite,
  previewDomain,
  previewTarget,
  VORSCHAU_COMPOSE,
  VORSCHAU_EXTERN_WARNING,
  VORSCHAU_PROFIL_EXTERN,
  VORSCHAU_SCHULPROFIL,
  VORSCHAU_SITE,
  vorschauSite,
} from "./vorschau";
import { parseOrder, parseOsRelease, SYSTEM_ORDER_FILE, SYSTEM_STATUS_FILE, type SystemOrder } from "@schulos/server/system";
import {
  dockerExposureProblem,
  formatStatus,
  parseArgs,
  parseComposePs,
  parseDf,
  redactLog,
  sanitizeEnv,
  USAGE,
  UsageError,
  type AppInfo,
  type Invocation,
} from "./core";
import { passphraseAtBoot, recoverySlots, tpm2DeviceFromCrypttab } from "./recovery";
import {
  EFI_SECURE_BOOT,
  formatGrubPassword,
  generateGrubPassword,
  grubPasswordProblem,
  grubPbkdf2,
  ISO_VOLUME,
  secureBootFromEfivar,
  TPM_EFI_CHANGED_FILE,
  TPM_ERROR_FILE,
  TPM_MARKER,
  TPM_PCRS,
  TPM_SCRIPT,
  TPM_STAND_FILE,
  tpm2PcrSets,
  tpmBindingProblems,
  tpmNeedsHuman,
  unlockMode,
  type TpmFacts,
} from "@schulos/server/boot-hardening";
import { hardeningPlan, TRANSITION_COMMAND, TRANSITION_FAILED } from "./haertung";
import {
  addressInNets,
  checkNet,
  netsFromRules,
  netsFromSshdConfig,
  SSH_NET_FILE,
  SSH_NET_UNIT,
  SSH_REQUIRES_DROPIN,
  SSHD_CONF_FILE,
  sshdConfig,
  sshNetRules,
  sshNetUnit,
  sshRequiresDropin,
  withSshdNets,
} from "@schulos/server/ssh-netz";
import { CLEAR_SCREEN, closableAsk, confirmRecoveryKey, extractRecoveryKey } from "@schulos/server/recovery-key";

declare const CTL_VERSION: string;
const VERSION = typeof CTL_VERSION === "string" ? CTL_VERSION : "dev";
const AGENT = ["node", "/opt/schulos-agent/agent.mjs"];
const STATE = "/srv/schulos/config/backup-agent-state.json";
const LOG_SERVICES = ["app", "caddy", "postgres", "backup-agent"];

class Compose {
  constructor(private readonly dir: string) {}
  private args(a: string[]) {
    return ["compose", "--project-directory", this.dir, ...a];
  }
  /** Ausgabe einsammeln */
  capture(a: string[]) {
    return exec("docker", this.args(a));
  }
  /** Ausgabe direkt durchreichen (lange Läufe) */
  stream(a: string[]): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn("docker", this.args(a), { stdio: "inherit" });
      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(code ?? 1));
    });
  }
}

async function appInfo(c: Compose): Promise<AppInfo | null> {
  const r = await c.capture(["exec", "-T", "app", "node", "cli.mjs", "info"]);
  try {
    return r.code === 0 ? (JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "") as AppInfo) : null;
  } catch {
    return null;
  }
}

async function backupState(c: Compose): Promise<AgentState | null> {
  const r = await c.capture(["exec", "-T", "backup-agent", "cat", STATE]);
  try {
    return r.code === 0 ? (JSON.parse(r.stdout) as AgentState) : null;
  } catch {
    return null;
  }
}

async function statusReport(c: Compose, dir: string): Promise<{ ok: boolean; text: string }> {
  const ps = await c.capture(["ps", "--all", "--format", "json"]);
  if (ps.code !== 0) throw new Error(`docker compose ps fehlgeschlagen: ${ps.stderr.trim() || ps.code}`);
  const [app, backup, df] = await Promise.all([appInfo(c), backupState(c), exec("df", ["-P", "-B1", dir])]);
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : null);
  const exposure = dockerExposureProblem(read("/etc/docker/daemon.json"), readEnvValue(read(path.join(dir, ".env")) ?? "", "SCHULOS_PUBLIC_ACCESS"));
  const r = formatStatus({ services: parseComposePs(ps.stdout), app, backup, disk: df.code === 0 ? parseDf(df.stdout) : null, now: new Date(), exposure });
  return { ok: r.ok, text: r.lines.join("\n") };
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [j/N] `);
  rl.close();
  return /^(j|ja|y|yes)$/i.test(answer.trim());
}

async function demoReset(c: Compose, yes: boolean): Promise<number> {
  const info = await appInfo(c);
  if (info && info.instance !== "demo") throw new Error(`Das ist keine Demo-Instanz (${info.instance}) – abgebrochen.`);
  if (!yes && !(await confirm("Alle Änderungen der Demo-Instanz gehen verloren. Fortfahren?"))) {
    console.error("Abgebrochen (ohne Terminal: --yes).");
    return 1;
  }
  console.log("App wird gestoppt …");
  if ((await c.stream(["stop", "app"])) !== 0) return 1;
  try {
    // eigener Container mit derselben Konfiguration; die App prüft selbst nochmals, dass es eine Demo ist
    return await c.stream(["run", "--rm", "--no-deps", "app", "node", "cli.mjs", "demo-reset"]);
  } finally {
    console.log("App wird gestartet …");
    await c.stream(["start", "app"]);
  }
}

async function supportBundle(c: Compose, dir: string, out?: string): Promise<number> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `schulos-support-${stamp}`;
  const work = mkdtempSync(path.join(tmpdir(), "schulosctl-"));
  const root = path.join(work, name);
  mkdirSync(path.join(root, "logs"), { recursive: true });
  const put = (file: string, text: string) => writeFileSync(path.join(root, file), text.endsWith("\n") ? text : `${text}\n`);
  const run = async (cmd: string, args: string[]) => {
    const r = await exec(cmd, args);
    return `$ ${cmd} ${args.join(" ")}\n${r.stdout}${r.stderr}`;
  };
  try {
    put("LIESMICH.txt", `Diagnosepaket von schulosctl ${VERSION}, erstellt ${new Date().toISOString()}.\nLogs und Konfiguration sind geschwärzt (E-Mail, IP, Namen, Token, Geheimnisse). Vor dem Weitergeben trotzdem durchsehen.\n`);
    put("status.txt", await statusReport(c, dir).then((r) => r.text, (e: unknown) => String(e)));
    const info = await appInfo(c);
    put("app-info.json", JSON.stringify(info, null, 2));
    const state = await backupState(c);
    // Zustand ohne Kopplungsdaten (die stehen ohnehin nicht drin) – nur Zeiten, Ergebnis, Fehlertext
    put("backup-state.json", redactLog(JSON.stringify(state, null, 2)));
    put("compose-ps.txt", (await c.capture(["ps", "--all"])).stdout);
    put("images.txt", (await c.capture(["images"])).stdout);
    put("system.txt", [await run("docker", ["version"]), await run("uname", ["-a"]), await run("df", ["-h"]), await run("free", ["-m"]), await run("cat", ["/etc/os-release"])].join("\n"));
    for (const svc of LOG_SERVICES) {
      const r = await c.capture(["logs", "--no-color", "--timestamps", "--tail", "3000", svc]);
      put(path.join("logs", `${svc}.log`), redactLog(`${r.stdout}${r.stderr}`));
    }
    for (const f of [".env", "schulos.env", "backup.env"]) {
      const file = path.join(dir, f);
      if (existsSync(file)) put(`${f.replace(/^\./, "dot")}.txt`, sanitizeEnv(readFileSync(file, "utf8")));
    }
    const target = path.resolve(out ?? `${name}.tar.gz`);
    // Windows (nur Entwicklung): „D:…“ sonst als entfernter Rechner gelesen
    const tar = await tarIn(work, ["-czf", target, name]);
    if (tar.code !== 0) throw new Error(`tar fehlgeschlagen: ${tar.stderr.trim()}`);
    console.log(`Diagnosepaket: ${target}`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function run(inv: Invocation): Promise<number> {
  const { command: cmd, dir } = inv;
  if (cmd.name === "help") {
    console.log(USAGE);
    return 0;
  }
  if (cmd.name === "version") {
    console.log(`schulosctl ${VERSION}`);
    return 0;
  }
  if (cmd.name === "wiederherstellungsschluessel") return newRecoveryKey(cmd.yes);
  // SEC-09: ohne Stack (auch Backupserver mit kopierter schulosctl.mjs)
  if (cmd.name === "sicherheit-nachruesten") return hardenExisting(cmd.yes, cmd.passwordStdin);
  if (cmd.name === "tpm-neu-binden") return tpmRebind();
  if (cmd.name === "ssh-netze") return sshNetsCmd(cmd.nets, cmd.yes);
  if (!existsSync(path.join(dir, "compose.yaml"))) throw new Error(`Kein SchulOS-Stack in ${dir} (compose.yaml fehlt) – --dir angeben`);
  const c = new Compose(dir);
  switch (cmd.name) {
    case "status":
      return statusReport(c, dir).then((r) => {
        console.log(r.text);
        return r.ok ? 0 : 1;
      });
    case "backup-now":
      return c.stream(["exec", "-T", "backup-agent", ...AGENT, "sichern"]);
    case "reset-admin":
      // Passwort kommt einmal auf stdout – nicht in Logs umleiten
      return c.stream(["exec", "-T", "app", "node", "cli.mjs", "reset-admin", ...(cmd.username ? [cmd.username] : [])]);
    case "schulnetz-zuruecksetzen":
      // G4E-C02/Q-4E-42: Schulnetz-Bereiche der Anmeldung auf die Vorgabe (Ausweg, wenn sich jemand ausgesperrt hat)
      return c.stream(["exec", "-T", "app", "node", "cli.mjs", "schulnetz-zuruecksetzen"]).then((code) => {
        // G4E-O17: die App-Einstellung ändert die SSH-Freigabe des Servers nicht
        console.log("Hinweis: SSH (Firewall + sshd) bleibt unverändert – anzeigen bzw. ändern mit: sudo schulosctl ssh-netze [<netz>…]");
        return code;
      });
    case "demo-reset":
      return demoReset(c, cmd.yes);
    case "support-bundle":
      return supportBundle(c, dir, cmd.out);
    case "update":
      return update(dir, cmd);
    case "test-restore":
      return testRestoreCmd(dir);
    case "db-rolle":
      return dbRoleCmd(dir);
    case "system-sync":
      return systemSync(dir);
    case "wartungsfenster":
      return maintenanceWindow(dir);
    case "vorschau":
      return vorschau(dir, cmd.action, cmd.domain, cmd.extern === true, cmd.off === true);
    case "bundle":
      return bundle(dir, cmd);
    case "os-upgrade":
      return osUpgrade(dir, cmd.target, cmd.yes);
    case "os-upgrade-pruefen":
      return osUpgradeCheck(dir);
    case "os-rollback":
      return osRollback(dir, cmd.yes);
  }
}

/**
 * Neuer LUKS-Wiederherstellungsschlüssel (INST-01): per TPM2 entsperrt einen neuen eintragen, anzeigen bis Block 8 bestätigt
 * ist, erst dann die alten Wiederherstellungs-Schlüsselplätze löschen. Nur root an der Konsole – der Schlüssel geht nie in
 * ein Protokoll oder eine Umleitung.
 */
async function newRecoveryKey(yes: boolean): Promise<number> {
  if (process.getuid?.() !== 0) throw new Error("Nur als root (sudo schulosctl wiederherstellungsschluessel).");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Nur an der Konsole bzw. per SSH mit Terminal – der Schlüssel wird nur angezeigt.");
  const crypttab = existsSync("/etc/crypttab") ? readFileSync("/etc/crypttab", "utf8") : "";
  const dev = tpm2DeviceFromCrypttab(crypttab);
  if (!dev) throw new Error("Keine TPM2-Verschlüsselung in /etc/crypttab – bei Passphrase gibt es keinen Wiederherstellungsschlüssel.");
  const dump = async () => {
    const r = await exec("cryptsetup", ["luksDump", "--dump-json-metadata", dev]);
    if (r.code !== 0) throw new Error(`cryptsetup luksDump ${dev}: ${r.stderr.trim()}`);
    return recoverySlots(r.stdout);
  };
  const old = await dump();
  if (!yes) {
    console.log(`Neuer Wiederherstellungsschlüssel für ${dev}: per TPM2 entsperrt, neuer Schlüssel wird angezeigt und bestätigt,`);
    console.log(`danach ist der bisherige ungültig${old.length ? ` (Schlüsselplatz ${old.join(", ")})` : ""}.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = (await rl.question("Jetzt erzeugen? [ja/NEIN] ")).trim().toLowerCase() === "ja";
    rl.close();
    if (!ok) return 1;
  }
  const r = await exec("systemd-cryptenroll", ["--unlock-tpm2-device=auto", "--recovery-key", dev]);
  const key = extractRecoveryKey(r.stdout) ?? extractRecoveryKey(r.stderr);
  if (r.code !== 0 || !key) {
    // Fehlermeldung ohne Ausgabe des Schlüssels (falls doch einer drinstand)
    console.error(`Neuer Schlüssel nicht erzeugt (Exit ${r.code}) – der bisherige gilt weiter.`);
    return 1;
  }
  // VT: UTF-8 + Schrift (Umlaute); der Schlüssel steht nur als Text da (INST-05, kein QR-Code)
  prepareConsole();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Strg+C schließt sonst readline, und der Prozess endet ohne Bestätigung – der alte Schlüssel bliebe unbemerkt gültig
  rl.on("SIGINT", () => process.stdout.write("\n  Strg+C geht hier nicht – erst Block 8 des Schlüssels eintippen.\n"));
  try {
    await confirmRecoveryKey(key, {
      show: (lines) => process.stdout.write(CLEAR_SCREEN + lines.join("\n") + "\n"),
      // EOF (Terminal weg) gilt nie als Bestätigung (INST-05): Fehler, die alten Plätze bleiben – beide Schlüssel gelten weiter
      ask: closableAsk(rl, process.stdin),
    });
  } finally {
    rl.close();
  }
  process.stdout.write(CLEAR_SCREEN);
  // nur die Plätze von vorher – der neue ist nicht darunter
  const stale = old;
  if (stale.length) {
    const w = await exec("systemd-cryptenroll", ["--unlock-tpm2-device=auto", `--wipe-slot=${stale.join(",")}`, dev]);
    if (w.code !== 0) {
      console.error(`Alten Schlüssel nicht gelöscht (${w.stderr.trim()}) – neuer UND alter gelten. Von Hand: systemd-cryptenroll --wipe-slot=${stale.join(",")} ${dev}`);
      return 1;
    }
  }
  const now = await dump();
  console.log(`Neuer Wiederherstellungsschlüssel eingetragen (Schlüsselplatz ${now.join(", ")}), der alte ist gelöscht.`);
  return 0;
}

/** stdin ganz lesen (--passwort-stdin) */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const readSecureBoot = () => secureBootFromEfivar(existsSync(EFI_SECURE_BOOT) ? readFileSync(EFI_SECURE_BOOT) : null);

/** Bootmenü-Passwort nur am Terminal zeigen, bis Enter – danach vom Bildschirm löschen */
async function showGrubPassword(pw: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => process.stdout.write("\n  Strg+C geht hier nicht – erst abschreiben, dann Enter.\n"));
  try {
    await rl.question(
      `${CLEAR_SCREEN}\n  BOOTMENÜ-PASSWORT (GRUB, Benutzer schulos) – aufschreiben und zum Wiederherstellungsschlüssel legen:\n\n` +
        `      ${formatGrubPassword(pw)}\n\n  Am Bootmenü ohne Leerzeichen eintippen (dort gilt die US-Tastatur; das Passwort enthält nur Zeichen,\n` +
        "  die auf deutscher und US-Tastatur gleich liegen). Nötig für ältere Kernel, „Stand vor dem Versionswechsel“ und e/c.\n\n  Abgeschrieben? Enter ",
    );
  } finally {
    rl.close();
    process.stdout.write(CLEAR_SCREEN);
  }
}

/**
 * SEC-09: geführter Nachrüst-Schritt für bestehende Server – neues Bootmenü-Passwort (G4E-O04/O05: zufällig erzeugt und
 * angezeigt, eigenes nur geprüft über --passwort-stdin) und bei TPM2 ohne PIN die Bindung an PCR 7+8+9 (Skript, Dienst,
 * dpkg-Hook; Erstbindung per Markierung, schon gebunden per Übergangsschlüssel – G4E-O01). Nur root.
 */
async function hardenExisting(yes: boolean, passwordStdin: boolean): Promise<number> {
  if (process.getuid?.() !== 0) throw new Error("Nur als root (sudo schulosctl sicherheit-nachruesten).");
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  if (!passwordStdin && !tty)
    throw new Error("Nur an der Konsole bzw. per SSH mit Terminal – das neue Bootmenü-Passwort wird nur dort angezeigt (eigenes: --passwort-stdin).");
  if (!yes && !tty) throw new Error("Ohne Terminal nur mit --yes.");
  const mode = unlockMode(readCrypttab());
  const sb = readSecureBoot();
  const bound = mode === "tpm2" && existsSync(TPM_STAND_FILE);
  console.log("Sicherheit nachrüsten (SEC-09):");
  console.log("  1. Bootmenü-Passwort (GRUB, Benutzer schulos) – nötig zum Bearbeiten der Einträge und für alles außer dem Standardstart");
  if (mode === "tpm2")
    console.log(
      bound
        ? "  2. TPM2: schon an PCR 7+8+9 gebunden – Übergangsschlüssel für das neue Bootmenü, der nächste Start bindet neu"
        : `  2. TPM2 an PCR 7+8+9 binden – beim nächsten Neustart ohne Startmedium${sb === false ? " (Secure Boot ist aus!)" : ""}`,
    );
  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = (await rl.question("Weiter? [ja/NEIN] ")).trim().toLowerCase() === "ja";
    rl.close();
    if (!ok) return 1;
  }
  let pw: string;
  if (passwordStdin) {
    pw = (await readStdin()).replace(/\r?\n$/, "");
    const problem = grubPasswordProblem(pw);
    if (problem) throw new Error(`Bootmenü-Passwort: ${problem}`);
  } else pw = generateGrubPassword();
  const plan = hardeningPlan(grubPbkdf2(pw), mode, sb, existsSync("/opt/schulos-backup"), bound);
  for (const d of plan.dirs) mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const f of plan.files) {
    mkdirSync(path.dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content, { mode: f.mode });
    chmodSync(f.path, f.mode);
  }
  let code = 0;
  try {
    for (const c of plan.commands) {
      const r = await exec(c[0]!, c.slice(1));
      if (r.code === 0) continue;
      if (c === TRANSITION_COMMAND) {
        console.error(TRANSITION_FAILED);
        code = 1;
        break;
      }
      throw new Error(`${c.join(" ")}: ${r.stderr.trim()}`);
    }
  } finally {
    // update-grub kann schon gelaufen sein – das neue Passwort in jedem Fall zeigen
    if (!passwordStdin) await showGrubPassword(pw);
  }
  if (code === 0) for (const n of plan.notes) console.log(n);
  return code;
}

/** jüngste Änderungszeit unter einem Ordner (rekursiv) in ms */
function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

/**
 * G4E-O01: Rettungsweg, wenn kein TPM2-Platz mehr passt (Start nur noch mit dem Wiederherstellungsschlüssel): an die Werte DIESES
 * Starts binden – fragt den Wiederherstellungsschlüssel (bzw. eine Passphrase der Platte) ab, löscht alle anderen TPM2-Plätze und
 * merkt den Stand. Nur sinnvoll, wenn der laufende Start genau die heutigen Startdateien gemessen hat.
 */
async function tpmRebind(): Promise<number> {
  if (process.getuid?.() !== 0) throw new Error("Nur als root (sudo schulosctl tpm-neu-binden).");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Nur an der Konsole bzw. per SSH mit Terminal – der Wiederherstellungsschlüssel wird abgefragt.");
  const crypttab = readCrypttab();
  if (unlockMode(crypttab) !== "tpm2") throw new Error("Nur bei TPM2 ohne PIN (crypttab) – mit PIN bzw. Passphrase gibt es nichts neu zu binden.");
  const dev = tpm2DeviceFromCrypttab(crypttab)!;
  if (readSecureBoot() !== true) throw new Error("Secure Boot ist aus – erst im UEFI einschalten, neu starten, dann erneut.");
  if ((await exec("blkid", ["-t", `LABEL=${ISO_VOLUME}`, "-o", "device"])).stdout.trim())
    throw new Error("Das Startmedium steckt – es misst andere Werte. Medium entfernen, ohne Medium neu starten, dann erneut.");
  const bootMs = Date.now() - uptime() * 1000;
  if (newestMtime("/boot") > bootMs + 60_000)
    throw new Error("Startdateien unter /boot haben sich seit diesem Start geändert (Update?) – erst neu starten (ggf. mit dem Wiederherstellungsschlüssel), dann erneut.");
  console.log(`Platte ${dev} an PCR ${TPM_PCRS} binden (Werte dieses Starts). Gleich wird der Wiederherstellungsschlüssel abgefragt.`);
  const code = await new Promise<number>((resolve) => {
    const child = spawn("systemd-cryptenroll", ["--tpm2-device=auto", `--tpm2-pcrs=${TPM_PCRS}`, "--wipe-slot=tpm2", dev], { stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (c) => resolve(c ?? 1));
  });
  if (code !== 0) {
    console.error(`systemd-cryptenroll endete mit ${code} – nichts geändert.`);
    return 1;
  }
  const g = await exec(TPM_SCRIPT, ["gebunden"]);
  if (g.code !== 0) console.error(`Gebunden, aber Stand nicht gemerkt (${g.stderr.trim()}) – sudo ${TPM_SCRIPT} gebunden`);
  console.log(`TPM2 an PCR ${TPM_PCRS} gebunden – der nächste Start entsperrt ohne Eingabe.`);
  return g.code === 0 ? 0 : 1;
}

/**
 * G4E-O17: SSH-Netze auf dem Host ändern (Firewall-Regel + sshd) bzw. anzeigen – Verwaltung → System → Anmeldung ändert nur die
 * App. Netze streng geprüft (G4E-O06: Host-Bits → Fehler mit Vorschlag), Regel vorher mit `nft -c` und sshd mit `sshd -t` geprüft.
 */
async function sshNetsCmd(nets: string[], yes: boolean): Promise<number> {
  if (!nets.length) {
    const rules = existsSync(SSH_NET_FILE) ? netsFromRules(readFileSync(SSH_NET_FILE, "utf8")) : [];
    const sshd = existsSync(SSHD_CONF_FILE) ? netsFromSshdConfig(readFileSync(SSHD_CONF_FILE, "utf8")) : null;
    console.log(rules.length ? `Firewall: SSH nur aus ${rules.join(", ")}` : "Firewall: keine SchulOS-Regel (SSH von überall bzw. aus)");
    console.log(sshd ? `sshd: Wartungskonto nur aus ${sshd.join(", ")}` : "sshd: ohne Einschränkung der Netze");
    return 0;
  }
  if (process.getuid?.() !== 0) throw new Error("Nur als root (sudo schulosctl ssh-netze …).");
  const checked = nets.map(checkNet);
  const bad = checked.filter((c) => !c.ok);
  if (bad.length) throw new Error(bad.map((c) => (c.ok ? "" : c.error)).join("\n"));
  const list = checked.map((c) => (c.ok ? c.net : ""));
  if (list.some((n) => n === "0.0.0.0/0" || n === "::/0"))
    throw new Error("SSH von überall gibt es über diesen Befehl nicht – dafür den Dienst schulos-ssh-netz von Hand abschalten (INSTALLATION.md §5).");
  const client = process.env.SSH_CLIENT?.split(" ")[0];
  if (client && !addressInNets(client, list) && !yes)
    throw new Error(`Diese SSH-Sitzung (${client}) läge danach außerhalb der Netze und bräche ab. Mit --yes trotzdem (Konsole bereithalten).`);
  mkdirSync(path.dirname(SSH_NET_FILE), { recursive: true });
  const next = `${SSH_NET_FILE}.neu`;
  writeFileSync(next, sshNetRules(list), { mode: 0o644 });
  const chk = await exec("nft", ["-c", "-f", next]);
  if (chk.code !== 0) {
    rmSync(next, { force: true });
    throw new Error(`Firewall-Regel ungültig (nft -c): ${chk.stderr.trim()}`);
  }
  const prevSshd = existsSync(SSHD_CONF_FILE) ? readFileSync(SSHD_CONF_FILE, "utf8") : null;
  mkdirSync(path.dirname(SSHD_CONF_FILE), { recursive: true });
  writeFileSync(SSHD_CONF_FILE, prevSshd ? withSshdNets(prevSshd, list) : sshdConfig(list, false), { mode: 0o644 });
  const t = await exec("sshd", ["-t"]);
  if (t.code !== 0) {
    if (prevSshd !== null) writeFileSync(SSHD_CONF_FILE, prevSshd, { mode: 0o644 });
    rmSync(next, { force: true });
    throw new Error(`sshd lehnt die Einstellung ab (sshd -t): ${t.stderr.trim()} – nichts geändert.`);
  }
  const prevRules = existsSync(SSH_NET_FILE) ? readFileSync(SSH_NET_FILE, "utf8") : null;
  renameSync(next, SSH_NET_FILE);
  // ältere Installationen: Dienst und die Bindung von ssh.service an die Regel (fail closed) nachziehen
  mkdirSync(path.dirname(SSH_REQUIRES_DROPIN), { recursive: true });
  writeFileSync(SSH_NET_UNIT, sshNetUnit(), { mode: 0o644 });
  writeFileSync(SSH_REQUIRES_DROPIN, sshRequiresDropin(), { mode: 0o644 });
  // GATE-4e (QEMU-Befund): NICHT `systemctl restart schulos-ssh-netz` – wegen Requires= startete das sshd mit neu (kurz kein
  // Port 22, im schlimmsten Fall bliebe SSH aus). Stattdessen die Regel direkt laden (`nft -f` ersetzt die Tabelle in einem
  // Schritt), den Dienst nur starten, falls er noch nicht läuft, und sshd neu einlesen lassen (reload, laufende Sitzungen bleiben).
  const steps: { what: string; run: () => ReturnType<typeof exec> }[] = [
    { what: "systemctl daemon-reload", run: () => exec("systemctl", ["daemon-reload"]) },
    { what: "systemctl enable schulos-ssh-netz.service", run: () => exec("systemctl", ["enable", "schulos-ssh-netz.service"]) },
    { what: `nft -f ${SSH_NET_FILE}`, run: () => exec("nft", ["-f", SSH_NET_FILE]) },
    { what: "systemctl start schulos-ssh-netz.service", run: () => exec("systemctl", ["start", "schulos-ssh-netz.service"]) },
    { what: "systemctl try-reload-or-restart ssh.service", run: () => exec("systemctl", ["try-reload-or-restart", "ssh.service"]) },
  ];
  let failed: string | null = null;
  for (const s of steps) {
    const r = await s.run();
    if (r.code !== 0) {
      failed = `${s.what}: ${r.stderr.trim()}`;
      break;
    }
  }
  // sshd muss danach wieder lauschen (falls SSH eingeschaltet ist) – sonst zurück auf den alten Stand
  if (!failed && (await exec("systemctl", ["is-enabled", "ssh.service"])).stdout.trim() === "enabled" && !(await sshListening()))
    failed = "sshd lauscht danach nicht auf Port 22";
  if (failed) {
    if (prevRules !== null) {
      writeFileSync(SSH_NET_FILE, prevRules, { mode: 0o644 });
      await exec("nft", ["-f", SSH_NET_FILE]);
    }
    if (prevSshd !== null) writeFileSync(SSHD_CONF_FILE, prevSshd, { mode: 0o644 });
    await exec("systemctl", ["restart", "ssh.service"]);
    throw new Error(`${failed} – alter Stand wiederhergestellt (Regel, sshd). Konsole bereithalten, Zustand prüfen: systemctl status ssh schulos-ssh-netz`);
  }
  console.log(`SSH nur noch aus ${list.join(", ")} (Firewall und sshd). Die App (Verwaltung → System → Anmeldung) ist davon unabhängig.`);
  return 0;
}

/** Lauscht sshd (Port 22)? Bis zu 10 s warten (reload startet sshd neu, der Port ist kurz weg) */
async function sshListening(): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const r = await exec("ss", ["-Hltn", "sport = :22"]);
    if (r.code === 0 && r.stdout.trim()) return true;
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

/** G4E-O03: was der Host über die TPM2-Bindung weiß (Verwaltung → System, Alarm) */
async function readTpmFacts(): Promise<TpmFacts> {
  const crypttab = readCrypttab();
  const mode = unlockMode(crypttab);
  const mtime = (f: string) => (existsSync(f) ? statSync(f).mtime.toISOString() : null);
  let pcrSets: string[] | null = null;
  const dev = tpm2DeviceFromCrypttab(crypttab);
  if (mode === "tpm2" && dev) {
    const r = await exec("cryptsetup", ["luksDump", "--dump-json-metadata", dev]);
    try {
      if (r.code === 0) pcrSets = tpm2PcrSets(r.stdout);
    } catch {
      pcrSets = null;
    }
  }
  return {
    mode,
    secureBoot: readSecureBoot(),
    markerSince: mtime(TPM_MARKER),
    bootedAt: new Date(Date.now() - uptime() * 1000).toISOString(),
    error: existsSync(TPM_ERROR_FILE) ? readFileSync(TPM_ERROR_FILE, "utf8").trim() || "unbekannter Fehler" : null,
    efiChanged: existsSync(TPM_EFI_CHANGED_FILE),
    pcrSets,
  };
}

function osContext(dir: string) {
  const { s, log, healthTimeoutMs, updates, deps } = updateContext(dir);
  return { d: osDeps(s, { log, healthTimeoutMs, backup: deps.backup, lockFile: lockPath(updates) }), updates };
}

/** Debian-Versionswechsel, geführt (B-43, §5a.1) – bewusst von Hand ausgelöst, nie im Wartungsfenster. */
async function osUpgrade(dir: string, target: string | undefined, yes: boolean): Promise<number> {
  const { d, updates } = osContext(dir);
  const from = await d.codename();
  const to = target ?? nextCodename(from);
  if (!yes) {
    console.log(`Debian-Versionswechsel ${from} → ${to ?? "?"}: Sicherung, Test-Restore, Schnappschuss, Umstellung (~30 min), Neustart.`);
    console.log("SchulOS ist dabei nicht erreichbar. Geht etwas schief, kommt nach dem Neustart automatisch der Stand von vorher zurück.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = (await rl.question("Jetzt starten? [ja/NEIN] ")).trim().toLowerCase() === "ja";
    rl.close();
    if (!ok) return 1;
  }
  const r = await withLock(updates, () => runOsUpgrade(d, target ? { target } : {}));
  if (r.status === "blockiert") console.error(r.reason);
  if (r.status === "fehlgeschlagen") console.error(`Umstellung fehlgeschlagen (${r.error}) – Schnappschuss zurückgespielt, Neustart.`);
  return r.status === "neustart" ? 0 : 1;
}

async function osUpgradeCheck(dir: string): Promise<number> {
  const r = await checkAfterBoot(osContext(dir).d);
  console.log(`Versionswechsel: ${r}`);
  return r === "zurueck" || r === "zurueck-gemeldet" ? 1 : 0;
}

async function osRollback(dir: string, yes: boolean): Promise<number> {
  const { d } = osContext(dir);
  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = (await rl.question("Zurück auf den Stand vor dem letzten Debian-Versionswechsel und neu starten? [ja/NEIN] ")).trim().toLowerCase() === "ja";
    rl.close();
    if (!ok) return 1;
  }
  await d.restore();
  d.log({ at: new Date().toISOString(), step: "os-rueckweg", ok: true, detail: "von Hand zurück auf den Schnappschuss, Neustart" });
  d.marker.clear();
  await d.reboot();
  return 0;
}

/** Gemeinsamer Rahmen für update, test-restore und system-sync: Protokoll, Kanal, Schritte gegen den Stack. */
function updateContext(dir: string, source?: string) {
  const s = new Stack(dir);
  const updates = path.join(dir, "updates");
  mkdirSync(updates, { recursive: true });
  const protocol = path.join(updates, "protokoll.jsonl");
  const log = (e: ProtocolEntry) => {
    appendFileSync(protocol, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    console.log(formatProtocolLine(e));
  };
  // SCHULOS_HEALTH_TIMEOUT (Sekunden, Vorgabe 300): wie lange auf eine gesunde App gewartet wird
  const healthTimeoutMs = Number(process.env.SCHULOS_HEALTH_TIMEOUT || 300) * 1000;
  // SCHULOS_UPDATE_SOURCE: Ordner mit Releases statt GitHub (ohne Internet, Offline-Bundle)
  // nach `bundle import` steht die Offline-Quelle in .env
  const deps = stackDeps(s, { source: source ?? process.env.SCHULOS_UPDATE_SOURCE ?? readEnvValue(s.env(), "SCHULOS_UPDATE_SOURCE"), log, healthTimeoutMs });
  const channel = () => ((readEnvValue(s.env(), "SCHULOS_CHANNEL") as Channel | undefined) || "stabil") as Channel;
  return { s, updates, protocol, log, deps, channel, healthTimeoutMs };
}

const lockPath = (updates: string) => path.join(updates, "update.lock");

const readCrypttab = () => (existsSync("/etc/crypttab") ? readFileSync("/etc/crypttab", "utf8") : "");
/** Q5-18/G4E-O02: braucht der nächste Start einen Menschen (Passphrase, PIN – oder nach einem shim-/GRUB-Update ggf. den Wiederherstellungsschlüssel)? */
const humanAtBoot = (tpm: TpmFacts) => passphraseAtBoot(readCrypttab()) || tpmNeedsHuman(tpm);
const REBOOT_PASSPHRASE = "Neustart nötig – Passphrase erforderlich (Verwaltung → System: „Jetzt neu starten“, danach Passphrase an der Konsole eingeben)";

/**
 * Q5-18: Neustart ausstehend, aber die Platte braucht eine Passphrase → kein automatischer Neustart. Zustand in
 * updates/neustart-noetig.json (seit wann), beim ersten Erkennen einmal ins Protokoll; ohne Bedarf wird er gelöscht.
 */
function trackReboot(updates: string, log: (e: ProtocolEntry) => void, needsHuman: boolean): RebootPending | null {
  const file = path.join(updates, "neustart-noetig.json");
  let prev: RebootPending | null = null;
  try {
    const raw = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<RebootPending>) : null;
    prev = raw && typeof raw.since === "string" && !Number.isNaN(Date.parse(raw.since)) ? { since: raw.since } : null;
  } catch {
    prev = null;
  }
  const { state, fresh } = nextRebootState(prev, { required: rebootRequired(), passphrase: needsHuman, now: new Date() });
  if (!state) {
    rmSync(file, { force: true });
  } else if (fresh) {
    writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    log({ at: state.since, step: "neustart", ok: false, detail: REBOOT_PASSPHRASE });
  }
  return state;
}

/** Sichern und neu starten (Wartungsfenster bzw. „Jetzt neu starten“); unter der Update-Sperre, nie mitten in ein Update. */
async function backupAndReboot(updates: string, deps: ReturnType<typeof updateContext>["deps"], log: (e: ProtocolEntry) => void, why: string): Promise<boolean> {
  try {
    await withLock(updates, async () => {
      await deps.backup().catch((e: unknown) => {
        throw new Error(`Sicherung fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
      });
      log({ at: new Date().toISOString(), step: "neustart", ok: true, detail: `Sicherung fertig, ${why}` });
      await exec("systemctl", ["reboot"]);
    });
    return true;
  } catch (e) {
    // Sicherung fehlgeschlagen oder Sperre belegt (es läuft gerade ein Update) → später
    log({ at: new Date().toISOString(), step: "neustart", ok: false, detail: `verschoben – ${e instanceof Error ? e.message : String(e)}` });
    return false;
  }
}

/** nie zwei Updates gleichzeitig (Timer + Hand) */
async function withLock<T>(updates: string, fn: () => Promise<T>): Promise<T> {
  const lock = lockPath(updates);
  // vor dem letzten Start angelegt (Neustart unter der Sperre, Rückweg auf einen Schnappschuss) → kann niemand mehr halten
  if (existsSync(lock) && lockFromBeforeBoot(statSync(lock).mtimeMs, Date.now(), uptime())) rmSync(lock, { force: true });
  try {
    writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx" });
  } catch {
    throw new Error(`Es läuft schon ein Update (${lock}) – falls nicht: Datei löschen`);
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function reportOutcome(outcome: UpdateOutcome, channel: Channel, protocol: string): number {
  switch (outcome.status) {
    case "aktuell":
      console.log(`SchulOS ${outcome.version} ist aktuell (Kanal ${channel}).`);
      return 0;
    case "fertig":
      console.log(`Update fertig: ${outcome.from} → ${outcome.version}. Protokoll: ${protocol}`);
      return 0;
    case "blockiert":
      console.error(outcome.reason);
      return 1;
    case "freigabe-noetig":
      console.log(`Funktions-Update ${outcome.version} → ${outcome.steps.join(" → ")} (${outcome.kind}) braucht eine Freigabe.`);
      return 1;
    case "fehlgeschlagen":
      console.error(
        `Update fehlgeschlagen (${outcome.failedAt}): ${outcome.error}. Läuft: ${outcome.version}` +
          (outcome.failedAt === "update" ? (outcome.rolledBack ? " – zurückgerollt." : " – RÜCKWEG MISSLUNGEN, Dump liegt in updates/.") : " – nichts geändert."),
      );
      return 1;
  }
}

async function update(dir: string, cmd: Extract<Invocation["command"], { name: "update" }>): Promise<number> {
  const { updates, protocol, deps, log, channel: configured } = updateContext(dir, cmd.source);
  const channel = cmd.channel ?? configured();

  if (cmd.check) {
    const current = await deps.currentVersion();
    const plan = planUpdate(current, await deps.releases(), channel);
    if (plan.status === "aktuell") console.log(`SchulOS ${current} ist aktuell (Kanal ${channel}).`);
    else if (plan.status === "blockiert") console.log(plan.reason);
    else {
      console.log(`Kanal ${channel}: ${[current, ...plan.steps.map((m) => m.version)].join(" → ")} (${plan.kind}${plan.securityRelevant ? ", sicherheitsrelevant" : ""})\n`);
      for (const m of plan.steps) console.log(releaseNotesMarkdown(m).split("\nKanal:")[0]);
    }
    return plan.status === "verfügbar" ? 10 : 0;
  }

  const code = await withLock(updates, async () => {
    let outcome = await runUpdate(deps, { channel, approved: cmd.yes, skipBackup: cmd.skipBackup });
    if (outcome.status === "freigabe-noetig") {
      reportOutcome(outcome, channel, protocol);
      if (!(await confirm("Jetzt freigeben und installieren?"))) {
        console.log("Nicht freigegeben – nichts geändert (ohne Terminal: --yes).");
        return 1;
      }
      outcome = await runUpdate(deps, { channel, approved: true, skipBackup: cmd.skipBackup });
    }
    return reportOutcome(outcome, channel, protocol);
  });
  await afterSelfUpdate(dir, updates, log);
  return code;
}

/**
 * GATE-031 (C-01): Hat `update` schulosctl selbst ersetzt, startet jetzt (nach der Update-Sperre) das neue schulosctl seine
 * einmaligen Umstellungen – derzeit `db-rolle` (SEC-07). Ein Fehler steht im Protokoll; der nächste `update` holt es nach,
 * weil das neue schulosctl die Umstellung vor jedem Plan prüft.
 */
async function afterSelfUpdate(dir: string, updates: string, log: (e: ProtocolEntry) => void): Promise<void> {
  const marker = path.join(updates, CTL_RENEWED);
  if (!existsSync(marker)) return;
  rmSync(marker, { force: true });
  const ctl = path.join(dir, CTL_FILE);
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [ctl, "--dir", dir, "db-rolle"], { stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (c) => resolve(c ?? 1));
  });
  if (code !== 0) log({ at: new Date().toISOString(), step: "db-rolle", ok: false, detail: `neues schulosctl: db-rolle mit Exit ${code} – beim nächsten Update erneut` });
}

const APP_CONFIG = "/srv/schulos/config";

/**
 * Abgleich mit Verwaltung → System (B-33, systemd-Timer): Auftrag der App abholen und ausführen, danach den Status
 * in den Konfigurationsordner der App schreiben. Ohne laufende App passiert nichts (sie zeigt dann ohnehin nichts an).
 */
async function systemSync(dir: string): Promise<number> {
  const { s, updates, protocol, log, deps, channel: configured } = updateContext(dir);
  const approvalFile = path.join(updates, "freigabe.json");
  let current = await deps.currentVersion();
  let channel = configured();

  let releases: ReleaseManifest[] | null = null;
  let error: string | undefined;
  try {
    releases = await deps.releases();
  } catch (e) {
    error = `Updates nicht abrufbar: ${e instanceof Error ? e.message : String(e)}`;
  }
  const plan = () => (releases ? planUpdate(current, releases, channel) : null);
  const tpm = await readTpmFacts();
  const reboot = trackReboot(updates, log, humanAtBoot(tpm));

  const raw = await s.compose(["exec", "-T", "app", "cat", `${APP_CONFIG}/${SYSTEM_ORDER_FILE}`]);
  if (raw.code === 0 && raw.stdout.trim()) {
    await s.compose(["exec", "-T", "app", "rm", "-f", `${APP_CONFIG}/${SYSTEM_ORDER_FILE}`]);
    let order: SystemOrder | null = null;
    try {
      order = parseOrder(JSON.parse(raw.stdout));
    } catch (e) {
      log({ at: new Date().toISOString(), step: "auftrag", ok: false, detail: `ungültiger Auftrag verworfen: ${e instanceof Error ? e.message : String(e)}` });
    }
    if (order) {
      const effect = orderEffect(order, plan(), reboot !== null);
      log({ at: new Date().toISOString(), step: "auftrag", ok: effect.kind !== "verworfen", detail: effect.entry, data: { von: order.by } });
      if (effect.kind === "kanal") {
        writeFileSync(s.envFile(), setEnvValues(s.env(), { SCHULOS_CHANNEL: effect.channel }), { mode: 0o600 });
        channel = effect.channel;
      } else if (effect.kind === "wartungsfenster") {
        writeFileSync(approvalFile, `${JSON.stringify(effect.approval)}\n`, { mode: 0o600 });
      } else if (effect.kind === "jetzt") {
        await withLock(updates, async () => reportOutcome(await runUpdate(deps, { channel, approved: true }), channel, protocol));
        await afterSelfUpdate(dir, updates, log);
        current = await deps.currentVersion();
      } else if (effect.kind === "neustart") {
        // Q5-18: von Hand ausgelöst – Sicherung, dann Neustart; die Passphrase gibt jemand an der Konsole ein
        if (await backupAndReboot(updates, deps, log, "Neustart von Hand (Verwaltung → System)")) return 0;
      }
    }
  }

  const approved = existsSync(approvalFile) ? (JSON.parse(readFileSync(approvalFile, "utf8")) as Approval) : null;
  const os = existsSync("/etc/os-release") ? parseOsRelease(readFileSync("/etc/os-release", "utf8")) : null;
  const df = await exec("df", ["-P", "-B1", dir]);
  const status = buildStatus({
    now: new Date(),
    current,
    channel,
    plan: plan(),
    approved,
    protocol: protocolTail(existsSync(protocol) ? readFileSync(protocol, "utf8") : ""),
    os,
    disk: df.code === 0 ? parseDf(df.stdout) : null,
    reboot,
    tpm: tpm.mode === "tpm2" ? { problems: tpmBindingProblems(tpm) } : null,
    error,
  });
  const file = `${APP_CONFIG}/${SYSTEM_STATUS_FILE}`;
  const w = await s.composeInput(["exec", "-T", "app", "sh", "-c", `cat > ${file}.tmp && mv -f ${file}.tmp ${file}`], JSON.stringify(status, null, 2));
  if (w.code !== 0) throw new Error(`Status nicht geschrieben: ${w.stderr.trim()}`);
  console.log(`Status für Verwaltung → System geschrieben (${current}, Kanal ${channel}, Update: ${status.update?.status ?? "unbekannt"})`);
  return 0;
}

try {
  process.exitCode = await run(parseArgs(process.argv.slice(2), process.env));
} catch (e) {
  console.error(e instanceof UsageError ? `${e.message}\n\n${USAGE}` : `Fehler: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = e instanceof UsageError ? 2 : 1;
}

/** SEC-07 von Hand: App-Datenbankrolle prüfen bzw. umstellen (update macht es vor jedem Lauf selbst), unter der Update-Sperre. */
async function dbRoleCmd(dir: string): Promise<number> {
  const { s, updates, log, healthTimeoutMs } = updateContext(dir);
  const r = await withLock(updates, () => ensureDbRole(dbRoleDeps(s, healthTimeoutMs)));
  if (r.changed) log({ at: new Date().toISOString(), step: "db-rolle", ok: true, detail: r.detail });
  else console.log(`Datenbankrolle: ${r.detail} – nichts zu tun.`);
  return 0;
}

/** Test-Restore mit App-Start – Ergebnis und Löschnachweis ins Update-Protokoll (Verwaltung → System zeigt es, B-33). */
async function testRestoreCmd(dir: string): Promise<number> {
  const { s, updates, log, healthTimeoutMs } = updateContext(dir);
  // GATE-031 (C-06): unter der Update-Sperre – sonst kann `update`/`db-rolle` mitten im Lauf die Wartungsrolle umstellen
  const r = await withLock(updates, () => testRestore(s, healthTimeoutMs));
  log({ at: new Date().toISOString(), step: "test-restore", ok: r.ok, detail: r.error, data: r.details });
  const deleted = r.deleted.database && r.deleted.container;
  log({
    at: r.deleted.at,
    step: "loeschnachweis",
    ok: deleted,
    detail: deleted ? "Prüfdatenbank und Prüf-Container entfernt" : "nicht vollständig entfernt – von Hand prüfen",
    data: r.deleted,
  });
  if (r.ok) console.log(`Test-Restore mit App-Start erfolgreich: ${JSON.stringify(r.details)}`);
  return r.ok && deleted ? 0 : 1;
}

/**
 * Wartungsfenster (B-34, systemd-Timer schulos-wartung.timer, Vorgabe 02:30): Patches automatisch, Funktions-Updates
 * nur mit Freigabe aus Verwaltung → System; danach den Status für die Verwaltung auffrischen.
 */
async function maintenanceWindow(dir: string): Promise<number> {
  const { updates, protocol, deps, channel, log } = updateContext(dir);
  const approvalFile = path.join(updates, "freigabe.json");
  const approval = existsSync(approvalFile) ? (JSON.parse(readFileSync(approvalFile, "utf8")) as Approval) : null;
  const current = await deps.currentVersion();
  let plan = null;
  try {
    plan = planUpdate(current, await deps.releases(), channel());
  } catch (e) {
    console.error(`Updates nicht abrufbar: ${e instanceof Error ? e.message : String(e)}`);
  }
  const decision = windowDecision(plan, approval);
  console.log(`Wartungsfenster: ${decision.reason}`);
  let code = 0;
  if (decision.run) {
    const outcome = await withLock(updates, () => runUpdate(deps, { channel: channel(), approved: decision.approved }));
    code = reportOutcome(outcome, channel(), protocol);
    if (outcome.status === "fertig") rmSync(approvalFile, { force: true });
    await afterSelfUpdate(dir, updates, log);
  }
  await systemSync(dir).catch((e: unknown) => console.error(`Status nicht aufgefrischt: ${e instanceof Error ? e.message : String(e)}`));
  // Debian braucht einen Neustart (Kernel/libc aus unattended-upgrades): im Fenster, vorher gesichert (§5a.1)
  // Nie mitten in einen Debian-Versionswechsel oder ein Update hinein: Markierung prüfen und die Update-Sperre halten
  if (rebootRequired() && existsSync(OS_MARKER)) {
    log({ at: new Date().toISOString(), step: "neustart", ok: false, detail: "verschoben – Debian-Versionswechsel im Gang (schulosctl os-upgrade)" });
  } else if (rebootRequired() && humanAtBoot(await readTpmFacts())) {
    // Q5-18: ohne TPM2 hinge der Server nachts an der Passphrase – nicht neu starten, sondern melden (Verwaltung → System,
    // Alarm-Mail); protokolliert wird einmal beim Erkennen (trackReboot), nicht jede Nacht
    const pending = trackReboot(updates, log, true);
    console.log(`Wartungsfenster: ${REBOOT_PASSPHRASE.split(" (")[0]} – kein automatischer Neustart${pending ? ` (steht aus seit ${pending.since})` : ""}`);
  } else if (rebootRequired()) {
    // Sicherung fehlgeschlagen oder Sperre belegt → nächstes Fenster
    if (!(await backupAndReboot(updates, deps, log, "Neustart für Debian-Updates"))) code = 1;
  }
  return code;
}

/**
 * Vorschau-Instanz (B-35): an (Image der nächsten Version, Subdomain im Haupt-Caddy) · aus (Projekt samt Demo-Daten
 * weg, Subdomain raus) · aktualisieren (auf die neueste Version im Kanal beta) · reset (Demo-Daten neu) ·
 * nacht (systemd-Timer: aktualisieren + reset, nur wenn eingeschaltet).
 */
async function vorschau(dir: string, action: "an" | "aus" | "aktualisieren" | "reset" | "nacht" | "profil", domain?: string, extern = false, off = false): Promise<number> {
  const main = new Stack(dir);
  const preview = new Stack(dir, [VORSCHAU_COMPOSE]);
  const running = async () => (await preview.compose(["ps", "-q", "app"])).stdout.trim() !== "";
  const reloadCaddy = async () => {
    const r = await main.compose(["exec", "-T", "caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]);
    if (r.code !== 0) throw new Error(`Caddy neu laden: ${r.stderr.trim().split("\n").at(-1)}`);
  };
  const resetData = async () => {
    console.log("Vorschau: Demo-Daten zurücksetzen …");
    await preview.composeStream(["stop", "app"]);
    try {
      if ((await preview.composeStream(["run", "--rm", "--no-deps", "app", "node", "cli.mjs", "demo-reset"])) !== 0) throw new Error("Demo-Reset fehlgeschlagen");
    } finally {
      // erst fertig, wenn die Vorschau wieder antwortet
      await preview.composeStream(["up", "-d", "--wait", "--wait-timeout", "300", "app"]);
    }
  };
  /**
   * P4-77/Q-4E-28: Schulprofil des Hauptsystems (ohne Personen) in den Konfigurationsordner der Vorschau legen bzw. entfernen,
   * dann zurücksetzen – demo-reset spielt es danach (und jede Nacht) wieder ein.
   */
  const profile = async (remove: boolean) => {
    if (remove) {
      const r = await preview.compose(["run", "--rm", "--no-deps", "-T", "app", "rm", "-f", VORSCHAU_SCHULPROFIL]);
      if (r.code !== 0) throw new Error(`Schulprofil entfernen: ${lastLine(r.stderr)}`);
      console.log("Vorschau: Schulprofil entfernt – wieder die reine Demo-Schule.");
    } else {
      const ex = await main.compose(["exec", "-T", "app", "node", "cli.mjs", "schulprofil-export"]);
      if (ex.code !== 0) throw new Error(`Schulprofil exportieren: ${lastLine(ex.stderr) || `Exit ${ex.code}`}`);
      const json = checkSchulprofilExport(ex.stdout);
      const w = await preview.composeInput(["run", "--rm", "--no-deps", "-T", "app", "sh", "-c", `cat > ${VORSCHAU_SCHULPROFIL}`], json);
      if (w.code !== 0) throw new Error(`Schulprofil in die Vorschau legen: ${lastLine(w.stderr)}`);
      console.log("Vorschau: Schulprofil der Schule übernommen (Logo, Module, Rechte, Einstellungen – keine Personen).");
    }
    await resetData();
  };
  /** neueste Version aus beta, sonst das Image des Hauptsystems */
  const pickImage = async (): Promise<{ image: string; version: string }> => {
    const { deps } = updateContext(dir);
    const current = await deps.currentVersion();
    let target: ReleaseManifest | null = null;
    try {
      target = previewTarget(current, await deps.releases());
    } catch (e) {
      console.error(`Updates nicht abrufbar – Vorschau zeigt die laufende Version: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (target) return { image: target.images.app, version: target.version };
    const id = (await main.must(["ps", "-q", "app"], "App-Container")).trim();
    return { image: (await exec("docker", ["inspect", "-f", "{{.Config.Image}}", id])).stdout.trim(), version: current };
  };
  const start = async () => {
    const { image, version } = await pickImage();
    const env = main.env();
    const project = await main.project();
    writeFileSync(
      main.envFile(),
      setEnvValues(env, {
        SCHULOS_VORSCHAU_IMAGE: image,
        SCHULOS_VORSCHAU_DOMAIN: previewDomain(readEnvValue(env, "SCHULOS_DOMAIN"), domain ?? readEnvValue(env, "SCHULOS_VORSCHAU_DOMAIN")),
        SCHULOS_EDGE_NETWORK: `${project}_edge`,
      }),
      { mode: 0o600 },
    );
    // Release-Image per Digest laden; ein lokales Image (wie das Hauptsystem) gibt es schon
    if (image.includes("@sha256:")) await preview.composeStream(["pull", "--quiet", "app"]);
    if ((await preview.composeStream(["up", "-d", "--wait", "--wait-timeout", "300"])) !== 0) throw new Error("Vorschau startet nicht");
    return version;
  };

  /** G4E-O16: liegt ein Schulprofil in der Vorschau? (Volume der Vorschau, auch wenn sie gerade aus ist) */
  const profileActive = async () => (await preview.compose(["run", "--rm", "--no-deps", "-T", "app", "test", "-f", VORSCHAU_SCHULPROFIL])).code === 0;
  /** G4E-O16: ist die laufende Site „auch von außen“? */
  const siteExtern = async () => {
    const r = await main.compose(["exec", "-T", "caddy", "cat", VORSCHAU_SITE]);
    return r.code === 0 && isExternSite(r.stdout);
  };

  switch (action) {
    case "an": {
      if (extern && (await profileActive())) throw new Error(VORSCHAU_PROFIL_EXTERN);
      const version = await start();
      const d = readEnvValue(main.env(), "SCHULOS_VORSCHAU_DOMAIN")!;
      const site = vorschauSite(d, { extern });
      const w = await main.composeInput(["exec", "-T", "caddy", "sh", "-c", `cat > ${VORSCHAU_SITE}`], site);
      if (w.code !== 0) throw new Error(`Caddy-Site schreiben: ${w.stderr.trim()}`);
      await reloadCaddy();
      console.log(`Vorschau läuft: SchulOS ${version} unter https://${d}${readEnvValue(main.env(), "SCHULOS_PUBLIC_PORT") ?? ""} (Demo-Logins)`);
      console.log(extern ? VORSCHAU_EXTERN_WARNING : "Nur aus dem Schulnetz erreichbar (von außen nur mit: schulosctl vorschau an --extern).");
      // Q-4E-28: am Terminal nach der Übernahme des Schulprofils fragen (sonst später: schulosctl vorschau profil) –
      // G4E-O16: nicht bei --extern (echte Schulmarke öffentlich mit Demo-Logins)
      if (extern) console.log("Schulprofil wird mit --extern nicht angeboten (echte Schulmarke + bekannte Demo-Passwörter im Internet).");
      else if (process.stdin.isTTY && process.stdout.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ok = (await rl.question("Schulprofil der Schule (Logo, Module, Rechte, Einstellungen – keine Personen) übernehmen? [ja/NEIN] ")).trim().toLowerCase() === "ja";
        rl.close();
        if (ok) await profile(false);
      } else console.log("Schulprofil übernehmen: schulosctl vorschau profil");
      return 0;
    }
    case "profil":
      if (!(await running())) throw new Error("Vorschau ist aus – erst: schulosctl vorschau an");
      if (!off && (await siteExtern())) throw new Error(VORSCHAU_PROFIL_EXTERN);
      await profile(off);
      return 0;
    case "aus":
      await main.compose(["exec", "-T", "caddy", "rm", "-f", VORSCHAU_SITE]);
      await reloadCaddy().catch((e: unknown) => console.error(String(e)));
      await preview.composeStream(["down", "-v"]);
      console.log("Vorschau abgeschaltet (Demo-Daten gelöscht).");
      return 0;
    case "aktualisieren":
      console.log(`Vorschau zeigt SchulOS ${await start()}`);
      return 0;
    case "reset":
      await resetData();
      return 0;
    case "nacht":
      if (!(await running())) {
        console.log("Vorschau ist aus – nichts zu tun.");
        return 0;
      }
      console.log(`Vorschau zeigt SchulOS ${await start()}`);
      await resetData();
      return 0;
  }
}


/**
 * Offline-Bundle (B-36): `create` auf einem Rechner mit Internet (Releases + Images in eine .tar),
 * `import` auf dem Server ohne Internet (Signaturen prüfen, Images laden und nur passende benennen).
 */
async function bundle(dir: string, cmd: Extract<Invocation["command"], { name: "bundle" }>): Promise<number> {
  const key = releaseKey();
  if (cmd.action === "create") {
    const all = cmd.source ? releasesFromDir(cmd.source, key) : await releasesFromGitHub(key);
    const manifests = cmd.versions.map((v) => {
      const m = all.find((r) => r.version === v.replace(/^v/, ""));
      if (!m) throw new Error(`Release ${v} nicht gefunden (vorhanden: ${all.map((r) => r.version).join(", ") || "keine"})`);
      return m;
    });
    const work = mkdtempSync(path.join(tmpdir(), "schulos-bundle-"));
    const root = path.join(work, "schulos-bundle");
    try {
      for (const m of manifests) {
        const src = cmd.source ? findReleaseDir(cmd.source, m.version) : null;
        const d = path.join(root, "releases", `v${m.version}`);
        mkdirSync(d, { recursive: true });
        if (src) {
          copyFileSync(path.join(src, "release.json"), path.join(d, "release.json"));
          copyFileSync(path.join(src, "release.json.sig"), path.join(d, "release.json.sig"));
          // GATE-031 (C-01): Host-Dateien mitnehmen, falls das Release welche hat (geprüft wird beim Update)
          for (const f of HOST_FILES) if (existsSync(path.join(src, f))) copyFileSync(path.join(src, f), path.join(d, f));
        } else {
          await downloadRelease(m.version, d);
        }
      }
      const images = bundleImages(manifests);
      for (const img of images) {
        console.log(`Image laden: ${img.ref}`);
        const r = await exec("docker", ["pull", "--quiet", img.ref]);
        if (r.code !== 0) throw new Error(`${img.ref}: ${r.stderr.trim()}`);
      }
      console.log(`Images sichern (${images.length}) …`);
      const save = await exec("docker", ["save", "-o", path.join(root, "images.tar"), ...images.map((i) => i.ref)]);
      if (save.code !== 0) throw new Error(`docker save: ${save.stderr.trim()}`);
      writeFileSync(path.join(root, "bundle.json"), JSON.stringify(bundleInfo(manifests), null, 2));
      writeFileSync(
        path.join(root, "LIESMICH.txt"),
        `SchulOS Offline-Update ${manifests.map((m) => m.version).join(", ")}\nAuf dem Server: schulosctl bundle import <diese Datei>, danach schulosctl update.\n`,
      );
      const out = path.resolve(cmd.out ?? `schulos-bundle-${manifests.map((m) => m.version).join("_")}.tar`);
      const tar = await tarIn(work, ["-cf", out, "schulos-bundle"]);
      if (tar.code !== 0) throw new Error(`tar: ${tar.stderr.trim()}`);
      console.log(`Offline-Bundle: ${out}`);
      return 0;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // import
  if (!cmd.file) throw new UsageError("schulosctl bundle import <datei>");
  const work = mkdtempSync(path.join(tmpdir(), "schulos-bundle-"));
  try {
    const tar = await tarIn(work, ["-xf", path.resolve(cmd.file)]);
    if (tar.code !== 0) throw new Error(`Bundle nicht lesbar: ${tar.stderr.trim()}`);
    const root = path.join(work, "schulos-bundle");
    // 1. Signaturen – vor allem anderen; ein ungültiges Manifest bricht den ganzen Import ab
    const manifests = releasesFromDir(path.join(root, "releases"), key);
    if (!manifests.length) throw new Error("Keine Releases im Bundle");
    // 2. Archiv vor dem Laden prüfen (SEC-06): nur signierte Digests, keine fremden Namen – `docker load` vergibt sonst
    //    Namen aus dem Archiv selbst. Danach laden; benannt wird nur per Digest.
    const imagesTar = path.join(root, "images.tar");
    const member = async (name: string) => {
      const r = await exec("tar", ["-xOf", imagesTar, name]);
      return r.code === 0 ? r.stdout : null;
    };
    const problems = checkImageArchive(
      { index: await member("index.json"), manifest: await member("manifest.json"), repositories: await member("repositories") },
      bundleImages(manifests),
    );
    if (problems.length) throw new Error(`images.tar passt nicht zu den signierten Releases (${problems.slice(0, 3).join("; ")}) – Import abgebrochen`);
    const load = await exec("docker", ["load", "-i", imagesTar]);
    if (load.code !== 0) throw new Error(`docker load: ${load.stderr.trim()}`);
    const loaded = loadedDigests(load.stdout);
    for (const img of bundleImages(manifests)) {
      if (!loaded.has(img.digest)) throw new Error(`${img.ref} fehlt im Bundle oder hat einen anderen Digest – Import abgebrochen`);
      const t = await exec("docker", ["tag", img.digest, img.tag]);
      if (t.code !== 0) throw new Error(`docker tag ${img.tag}: ${t.stderr.trim()}`);
      const check = await exec("docker", ["image", "inspect", "--format", "{{.Id}}", img.ref]);
      if (check.code !== 0) throw new Error(`${img.ref} offline nicht auflösbar (Docker braucht den containerd-Image-Speicher)`);
    }
    // 3. Releases als Quelle ablegen
    // Quelle für update/wartungsfenster/system-sync nach dem Import
    const target = path.resolve(dir, "updates", "offline");
    for (const m of manifests) {
      const d = path.join(target, `v${m.version}`);
      mkdirSync(d, { recursive: true });
      copyFileSync(path.join(root, "releases", `v${m.version}`, "release.json"), path.join(d, "release.json"));
      copyFileSync(path.join(root, "releases", `v${m.version}`, "release.json.sig"), path.join(d, "release.json.sig"));
      for (const f of HOST_FILES) {
        const from = path.join(root, "releases", `v${m.version}`, f);
        if (existsSync(from)) copyFileSync(from, path.join(d, f));
      }
    }
    const s = new Stack(dir);
    writeFileSync(s.envFile(), setEnvValues(s.env(), { SCHULOS_UPDATE_SOURCE: target }), { mode: 0o600 });
    console.log(`Importiert: ${manifests.map((m) => m.version).join(", ")} (Signaturen und ${bundleImages(manifests).length} Images geprüft).`);
    console.log("Weiter mit: schulosctl update --check");
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function findReleaseDir(source: string, version: string): string | null {
  for (const d of [path.join(source, `v${version}`), source]) {
    const f = path.join(d, "release.json");
    if (existsSync(f) && (JSON.parse(readFileSync(f, "utf8")) as { version?: string }).version === version) return d;
  }
  return null;
}

/** release.json + .sig eines GitHub-Releases herunterladen (Bytes unverändert – sie sind signiert). */
async function downloadRelease(version: string, into: string): Promise<void> {
  const token = process.env.SCHULOS_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = { "user-agent": "schulosctl", accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/tags/v${version}`, { headers });
  if (!res.ok) throw new Error(`Release v${version}: ${res.status}`);
  const rel = (await res.json()) as { assets: ReleaseAsset[] };
  // GATE-031 (C-01): Host-Dateien optional (ältere Releases haben keine)
  for (const name of ["release.json", "release.json.sig", ...HOST_FILES]) {
    const a = rel.assets.find((x) => x.name === name);
    if (!a && (HOST_FILES as readonly string[]).includes(name)) continue;
    if (!a) throw new Error(`v${version}: ${name} fehlt`);
    const r = await fetch(assetDownloadUrl(a, token), { headers: { ...headers, accept: "application/octet-stream" } });
    if (!r.ok) throw new Error(`v${version}: ${name} ${r.status}`);
    writeFileSync(path.join(into, name), new Uint8Array(await r.arrayBuffer()));
  }
}

/**
 * tar im Arbeitsordner starten statt `-C` (Git-Bash-tar unter Windows versteht dort keine Laufwerkspfade);
 * --force-local: „D:…“ im Archivnamen ist kein entfernter Rechner (nur Windows/Entwicklung).
 */
function tarIn(cwd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("tar", [...(process.platform === "win32" ? ["--force-local"] : []), ...args], { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (e) => resolve({ code: 127, stderr: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}
