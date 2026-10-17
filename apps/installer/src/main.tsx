// SchulOS-Installer (B-41): Fragen in der Text-Oberfläche oder unbeaufsichtigt aus schulos-install.yaml, dann den
// Installationsplan ablegen; mit --installieren bzw. --plan die Systemschritte (B-42) ausführen.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ReadStream, WriteStream } from "node:tty";
import { CLEAR_SCREEN } from "@schulos/server/recovery-key";
import { configLocation, CONSOLE_WAIT_NOTE, endingFor, summaryText } from "./abschluss";
import { finishAtConsole, type ConsoleIo } from "./abschluss-konsole";
import { setBootOrder } from "./system/boot-order";
import { checkOverwrite, OVERWRITE_EXIT, readIfExists, type Exec } from "./system/existing";
import { hashPassword } from "better-auth/crypto";
import { render } from "ink";
import { checkBackupServer } from "@schulos/server/pairing-client";
import { retryTransient } from "./retry";
import { readInstallYaml, resolve } from "./answers";
import { backupCheckFor } from "./flow";
import { generate, GRUB_PASSWORD_KEY, type InstallPlan } from "./generate";
import { parseArgs, parseStuecklisteArgs, USAGE, UsageError, writePlan } from "./cli";
import { buildStueckliste, parseDpkgQuery, parseImageInspect, parsePackages, sourceDate } from "./stueckliste";
import type { Answers, InstallContext } from "./questions";
import { MIN_DISK_BYTES } from "./questions";
import { detectContext } from "./system-info";
import { CONFIGURE_LOG, configureSteps, IMAGE_FILE, imageSteps, parseImageFile } from "./system/image";
import { runSteps, StepError, type RunOptions } from "./system/run";
import type { Role } from "./system/schulos-steps";
import { installSteps, packageLists, planLayout, type Step } from "./system/steps";
import { buildConsoleFonts, keepConsoleFont } from "./system/console-font";
import { App, UiProvider } from "./tui/App";
import { InstallView } from "./tui/Install";
import { ProgressStore, tailLog } from "./tui/progress";
import { sections } from "./tui/sections";

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** Version vom Medium (VERSION), sonst „dev“ */
function mediumVersion(medium: string): string {
  return existsSync(`${medium}/VERSION`) ? readFileSync(`${medium}/VERSION`, "utf8").trim() : "dev";
}

async function interactive(initial: Answers, ctx: InstallContext, fromFile: boolean, version: string): Promise<Answers | null> {
  return new Promise((done) => {
    const app = render(
      <App
        version={version}
        initial={initial}
        ctx={ctx}
        mode={fromFile ? "fehlende" : "alle"}
        // Abbild: das Netz aus den Antworten gilt erst nach der Einrichtung – geprüft wird beim Erststart (Kopplung)
        checkBackup={(backupUrl, code) => (ctx.image ? Promise.resolve({ serverName: "wird beim Erststart geprüft" }) : checkBackupServer({ backupUrl, code }))}
        onFinish={(a) => {
          app.unmount();
          done(a);
        }}
        onAbort={() => {
          app.unmount();
          done(null);
        }}
      />,
    );
  });
}

/** Stückliste schreiben (B-48, ISO-Bau) */
function stueckliste(argv: string[]) {
  const a = parseStuecklisteArgs(argv);
  const s = buildStueckliste({
    version: a.version,
    commit: a.commit,
    node: process.versions.node,
    debian: {
      quelle: a.quelle,
      zielsystem: parsePackages(readFileSync(a.pakete, "utf8")),
      ...(a.live ? { liveSystem: parseDpkgQuery(readFileSync(a.live, "utf8")) } : {}),
    },
    images: parseImageInspect(readFileSync(a.images, "utf8"), a.refs),
    erstellt: sourceDate(process.env.SOURCE_DATE_EPOCH),
  });
  writeFileSync(a.ausgabe, JSON.stringify(s, null, 2) + "\n");
  process.stdout.write(`Stückliste: ${a.ausgabe} (${s.debian.zielsystem.length} Pakete, ${s.images.length} Images)\n`);
}

async function main() {
  if (process.argv[2] === "--konsolenschrift") {
    // ISO-Bau (Hook im Live-System): --konsolenschrift <console-setup-Schriften> <ziel>
    const [from, to] = process.argv.slice(3);
    if (!from || !to) fail(`--konsolenschrift <quellordner> <zielordner>\n\n${USAGE}`, 64);
    for (const f of buildConsoleFonts(from, to)) process.stdout.write(`${f}\n`);
    return;
  }
  if (process.argv[2] === "--stueckliste") {
    try {
      return stueckliste(process.argv.slice(2));
    } catch (e) {
      fail(`${(e as Error).message}\n\n${USAGE}`, e instanceof UsageError ? 64 : 1);
    }
  }
  let inv;
  try {
    inv = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) fail(`${e.message}\n\n${USAGE}`, 64);
    throw e;
  }
  if (inv === "help") return void process.stdout.write(USAGE);
  if (inv === "paketliste") {
    const l = packageLists();
    return void process.stdout.write(`${l.debootstrap.join(" ")}\n${l.apt.join(" ")}\n`);
  }
  if ((inv.install || inv.image || inv.configure) && (process.platform !== "linux" || process.getuid?.() !== 0))
    fail("--installieren/--plan/--abbild/--konfigurieren nur als root unter Linux.", 64);
  if (!inv.unattended && !inv.image) keepConsoleFont();
  if (inv.planFile) return install(JSON.parse(readFileSync(inv.planFile, "utf8")) as InstallPlan, inv);
  if (inv.image) return buildImage(inv.image, inv);

  let ctx: InstallContext;
  if (inv.configure) {
    const image = existsSync(IMAGE_FILE) ? parseImageFile(readFileSync(IMAGE_FILE, "utf8")) : null;
    if (!image) fail(`${IMAGE_FILE} fehlt – --konfigurieren nur in einem vorbereiteten SchulOS-Abbild.`, 64);
    ctx = { image: image.role };
  } else ctx = detectContext();
  let initial: Answers = {};
  if (inv.answersFile) {
    const r = readInstallYaml(readFileSync(inv.answersFile, "utf8"));
    if (r.errors.length) fail(`${inv.answersFile}:\n${r.errors.map((e) => `  ${e.id || "Datei"}: ${e.message}`).join("\n")}`, 2);
    initial = r.answers;
  }

  let answers: Answers | null;
  if (inv.unattended) {
    const r = resolve(initial, ctx);
    for (const w of r.warnings) process.stderr.write(`Hinweis ${w.id}: ${w.message}\n`);
    if (!r.complete)
      fail(`Antworten unvollständig:\n${[...r.missing.map((m) => `  ${m}: fehlt`), ...r.errors.map((e) => `  ${e.id}: ${e.message}`)].join("\n")}`, 2);
    const check = ctx.image ? null : backupCheckFor(r.answers, ctx);
    if (check) {
      try {
        // direkt nach dem Start des Live-Systems sind DHCP/DNS evtl. noch nicht so weit – bis zu 2 min wiederholen
        const s = await retryTransient(() => checkBackupServer({ backupUrl: check.url, code: check.code }), {
          tries: 24,
          delayMs: 5000,
          onRetry: (err, next) => process.stdout.write(`${err.message} – Versuch ${next}/24 in 5 s\n`),
        });
        process.stdout.write(`Backupserver „${s.serverName}“ erreichbar, Kopplungscode gültig.\n`);
      } catch (e) {
        fail(`Backupserver: ${(e as Error).message}`, 3);
      }
    }
    answers = r.answers;
  } else {
    answers = await interactive(initial, ctx, inv.answersFile !== null, mediumVersion(inv.medium));
  }
  if (!answers) fail("Abgebrochen – nichts verändert.", 1);

  const plan = await generate(answers, { hashPassword }, ctx);
  const file = writePlan(plan, inv.outDir);
  process.stdout.write(`Installationsplan: ${file}\n`);
  if (inv.install) await install(plan, inv, { answers, ctx });
  else if (inv.configure) await configure(plan);
  else if (plan.pairingCode) process.stdout.write(`Kopplungscode für das Hauptsystem (24 h gültig): ${plan.pairingCode}\n`);
}

/** interaktiv: Fortschritt als Bildschirm (INST-02) statt Zeilen */
interface Tui {
  version: string;
  /** für die Schrittleiste; null bei --plan */
  answers: Answers | null;
  ctx: InstallContext;
}

async function executeTui(steps: Step[], cleanup: Step[], log: string, tui: Tui) {
  const store = new ProgressStore();
  process.stdout.write(CLEAR_SCREEN);
  const app = render(
    <UiProvider version={tui.version}>
      <InstallView store={store} log={log} readLog={(n) => tailLog(log, n)} steps={tui.answers ? sections(tui.answers, tui.ctx, "install") : null} />
    </UiProvider>,
  );
  try {
    const r = await runSteps(steps, cleanup, { log, onStep: (i, n, step) => store.set({ index: i, total: n, title: step.title }) });
    app.unmount();
    return r;
  } catch (e) {
    if (!(e instanceof StepError)) {
      app.unmount();
      throw e;
    }
    // Abbruch-Bildschirm stehen lassen; start-installer.sh schreibt darunter „Installer beendet …“ und fragt nach Neustart
    store.set({ error: { message: e.message } });
    await new Promise((r) => setTimeout(r, 100));
    app.unmount();
    process.exit(4);
  }
}

async function execute(steps: Step[], cleanup: Step[], log: string, what: string) {
  process.stdout.write(`${what} läuft – Protokoll: ${log}\n`);
  const o: RunOptions = { log, onStep: (i, n, step) => process.stdout.write(`[${String(i + 1).padStart(3)}/${n}] ${step.title}\n`) };
  try {
    return await runSteps(steps, cleanup, o);
  } catch (e) {
    if (e instanceof StepError) fail(`\n${what} abgebrochen – ${e.message}\nDetails: ${log}`, 4);
    throw e;
  }
}

/** Abbild der Rolle bauen (B-46) – in der Bau-VM auf ihre einzige Platte */
async function buildImage(role: Role, inv: { target: string; mirror: string; outDir: string; medium: string }) {
  if (!existsSync(inv.medium)) fail(`SchulOS-Dateien fehlen: ${inv.medium} (--medium)`, 64);
  const disks = (detectContext().disks ?? []).filter((d) => d.sizeBytes >= MIN_DISK_BYTES);
  if (disks.length !== 1) fail(`Abbild: genau eine beschreibbare Platte ab 32 GB erwartet, gefunden: ${disks.map((d) => d.path).join(", ") || "keine"}`, 64);
  const version = mediumVersion(inv.medium);
  const { steps, cleanup } = imageSteps(role, {
    target: inv.target,
    mirror: inv.mirror,
    keyFile: `${inv.outDir}/startschluessel`,
    dist: inv.medium,
    disk: disks[0]!.path,
    installer: process.argv[1]!,
    version,
  });
  await execute(steps, cleanup, `${inv.outDir}/installation.log`, `Abbild (${role}, ${version}) auf ${disks[0]!.path}`);
  process.stdout.write("\nAbbild fertig.\n");
}

/** Vorbereitetes Abbild einrichten (B-46): laufendes System, danach startet der Erststart-Dienst */
async function configure(plan: InstallPlan) {
  await execute(configureSteps(plan), [], CONFIGURE_LOG, "Einrichtung");
  process.stdout.write("\nEingerichtet – SchulOS startet jetzt (Erststart).\n");
  if (plan.pairingCode) process.stdout.write("Den Kopplungscode für das Hauptsystem zeigt die Konsole (tty1).\n");
}

/** Systemschritte ausführen (B-42); Fortschritt als Zeilen, am Ende Schlüssel und Kopplungscode. */
async function install(
  plan: InstallPlan,
  inv: { target: string; mirror: string; outDir: string; medium: string; unattended: boolean; skipConfirmation: boolean; overwrite: boolean; testMode: boolean },
  from: { answers: Answers; ctx: InstallContext } | null = null,
) {
  if (!existsSync(inv.medium)) fail(`SchulOS-Dateien fehlen: ${inv.medium} (--medium)`, 64);
  // interaktiv (Konsole): Fortschritt als Bildschirm, Abschluss ohne Zeitlimit; unbeaufsichtigt/CI wie bisher als Zeilen
  // (serielle Schwärzung in start-installer.sh)
  const interactiveTty = !inv.unattended && !!process.stdin.isTTY && !!process.stdout.isTTY;
  const version = mediumVersion(inv.medium);
  await guardOverwrite(plan, interactiveTty, inv.overwrite);
  const marker = { version, date: new Date().toISOString().slice(0, 10) };
  const { steps, cleanup } = installSteps(plan, { target: inv.target, mirror: inv.mirror, keyFile: `${inv.outDir}/startschluessel`, dist: inv.medium, marker });
  const log = `${inv.outDir}/installation.log`;
  const r = interactiveTty
    ? await executeTui(steps, cleanup, log, { version, answers: from?.answers ?? null, ctx: from?.ctx ?? {} })
    : await execute(steps, cleanup, log, "Installation");
  const ending = endingFor({ interactiveTty, unattended: inv.unattended, skipConfirmation: inv.skipConfirmation });
  if (ending === "bildschirm") return finishInteractive(plan, r.recoveryKey, inv.outDir, version, { input: process.stdin, output: process.stdout }, inv.testMode);
  if (ending === "konsole") {
    // Hinweis auch seriell (ohne Geheimnis): wer per Serial-over-LAN zusieht, weiß, dass tty1 wartet. Nur der QEMU-Test
    // (Datei „seriell-geheimnisse“) bekommt den Schlüssel zusätzlich über stdout, um Block 8 per Tastatur einzugeben (GATE-4f C-12).
    if (process.env.SCHULOS_SERIELL_GEHEIMNISSE === "1") process.stdout.write(summaryText(r.recoveryKey, plan.pairingCode ?? null, inv.testMode, grubPasswordOf(plan)));
    process.stdout.write(`
${CONSOLE_WAIT_NOTE}
`);
    return finishInteractive(plan, r.recoveryKey, inv.outDir, version, openConsole(), inv.testMode);
  }
  process.stdout.write(summaryText(r.recoveryKey, plan.pairingCode ?? null, inv.testMode, grubPasswordOf(plan)));
}

const exec: Exec = (argv) => {
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? r.error?.message ?? "" };
};

/**
 * Überschreibschutz (INST-06): Zielplatten mit fertiger SchulOS-Installation (Markierung, nur lesend geprüft) löscht der Installer
 * nur nach eingetipptem „ÜBERSCHREIBEN“ bzw. ohne Oberfläche mit --ueberschreiben – sonst Ende mit OVERWRITE_EXIT, nichts verändert.
 */
async function guardOverwrite(plan: InstallPlan, interactiveTty: boolean, overwrite: boolean) {
  const r = await checkOverwrite(
    planLayout(plan).disks,
    { interactive: interactiveTty, overwrite },
    {
      exec,
      mkdtemp: () => mkdtempSync("/run/schulos-pruefung-"),
      read: readIfExists,
      rmdir: (dir) => rmdirSync(dir),
      io: { input: process.stdin, output: process.stdout },
    },
  );
  if (!r.ok) fail(r.message, OVERWRITE_EXIT);
  if (r.notice) process.stdout.write(`${r.notice}\n`);
}

/**
 * Unbeaufsichtigt (INST-05): Terminal des Dienstes (tty1) direkt öffnen – stdout läuft in start-installer.sh über die serielle
 * Schnittstelle, der Schlüssel gehört nur auf den Bildschirm. Ohne Terminal: null (dann wartet der Installer, statt zu bestätigen).
 */
function openConsole(): ConsoleIo | null {
  try {
    const fd = openSync("/dev/tty", "r+");
    return { input: new ReadStream(fd), output: new WriteStream(fd) };
  } catch {
    return null;
  }
}

/** G4E-O04/O05: Bootmenü-Passwort aus dem Plan (ältere Pläne ohne: null) */
const grubPasswordOf = (plan: InstallPlan): string | null => {
  const v = plan.system[GRUB_PASSWORD_KEY];
  return typeof v === "string" && v ? v : null;
};

/** Abschluss an der Konsole (INST-01/INST-05) – Ablauf in abschluss-konsole.ts, hier nur die echte Startreihenfolge. */
async function finishInteractive(plan: InstallPlan, recoveryKey: string | null, outDir: string, version: string, io: ConsoleIo | null, testMode = false) {
  await finishAtConsole(recoveryKey, plan.pairingCode ?? null, outDir, version, io, {
    testMode,
    grubPassword: grubPasswordOf(plan),
    // INST-06: start-installer.sh meldet, wo SCHULOSCFG liegt; ein eigener Stick wird vor dem Hinweis „JETZT abziehen“ ausgehängt
    configLocation: configLocation(process.env),
    releaseStick: () => void exec(["umount", "--lazy", "/run/schulos-cfg"]),
    bootOrder: () =>
      existsSync("/sys/firmware/efi/efivars")
        ? setBootOrder(planLayout(plan), (argv) => {
            const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
            return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? r.error?.message ?? "" };
          })
        : { ok: false, reason: "kein UEFI bzw. kein Zugriff auf die UEFI-Variablen" },
  });
}

main().catch((e: unknown) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e), 1));
