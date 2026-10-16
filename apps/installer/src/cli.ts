// Aufruf und Ausgabe des Installers – rein bzw. nur Dateisystem, damit testbar ohne Terminal.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InstallPlan } from "./generate";

export const USAGE = `SchulOS-Installer

  schulos-installer [--antworten <datei>] [--unbeaufsichtigt [--ohne-bestaetigung]] [--ueberschreiben] [--ausgabe <ordner>] [--installieren]
                    [--testmodus [--vorschau-verstanden]]
  schulos-installer --plan <plan.json> [--ziel <ordner>] [--quelle <url>] [--medium <ordner>]
  schulos-installer --abbild <main|backup> [--ziel <ordner>] [--quelle <url>] [--medium <ordner>]
  schulos-installer --konfigurieren [--antworten <datei>] [--unbeaufsichtigt]

  --antworten <datei>   schulos-install.yaml mit vorab beantworteten Fragen; gefragt wird nur, was fehlt
  --unbeaufsichtigt     ohne Oberfläche: alles muss in der Antwortdatei stehen (Passwörter eingeschlossen); mit --installieren
                        nur im CI-Testmodus (INST-07)
  --testmodus           NUR CI (INST-07): start-installer.sh setzt ihn nur bei Kernel-Parameter schulos.testmodus (qemu-test.sh,
                        build-qcow2.sh) – erst damit installiert der Installer unbeaufsichtigt bzw. baut ein Abbild;
                        der Abschluss zeigt „TESTINSTALLATION“
  --vorschau-verstanden NUR CI (REPO-03): Vorschau-/Haftungshinweis gilt als bestätigt (Datei „vorschau-verstanden“ auf SCHULOSCFG);
                        interaktiv wird immer „VERSTANDEN“ verlangt
  --ohne-bestaetigung   NUR TEST/LABOR (QEMU-CI): unbeaufsichtigt ohne Bestätigung des Wiederherstellungsschlüssels enden
                        (Schlüssel nur als Zeile, seriell geschwärzt) – sonst wartet auch unbeaufsichtigt tty1 auf Block 8
  --ueberschreiben      ohne Oberfläche (unbeaufsichtigt, --plan) eine Platte mit fertiger SchulOS-Installation trotzdem löschen
                        (INST-06) – sonst Abbruch mit Code 5; interaktiv wird immer nach „ÜBERSCHREIBEN“ gefragt
  --ausgabe <ordner>    wohin der Installationsplan geschrieben wird (Vorgabe /run/schulos-installer)
  --installieren        nach den Fragen installieren: Zielplatte(n) LÖSCHEN, Debian + SchulOS einrichten (nur als root)
  --plan <plan.json>    ohne Fragen einen vorhandenen Plan installieren (wie --installieren)
  --ziel <ordner>       Einhängepunkt des neuen Systems (Vorgabe /target)
  --quelle <url>        Debian-Paketquelle für debootstrap (Vorgabe: Offline-Quelle der ISO)
  --medium <ordner>     SchulOS-Dateien (Node, Compose, schulosctl, Units, Images; Vorgabe: auf dem Startmedium)
  --abbild <rolle>      Abbild (qcow2) für Proxmox/QEMU vorbereiten: die einzige Platte der Bau-VM LÖSCHEN, Debian + SchulOS
                        der Rolle ohne Antworten und ohne Verschlüsselung installieren (iso/build-qcow2.sh)
  --konfigurieren       vorbereitetes Abbild beim ersten Start einrichten (Antworten wie oben, ohne Platte/Verschlüsselung)
  --stueckliste …       Stückliste beim ISO-Bau (B-48): --version v --commit sha --quelle url --pakete <Packages> --images
                        <inspect.json> --refs a,b,… [--live <dpkg-query.txt>] --ausgabe <datei>
  --konsolenschrift <von> <nach>
                        Konsolenschrift des Live-Systems erzeugen (ISO-Bau, INST-02): Terminus Bold aus console-setup
                        plus Halbblöcke für das Logo
  --paketliste          Debian-Pakete für die Offline-Quelle ausgeben (ISO-Bau): Zeile 1 debootstrap, Zeile 2 apt
`;

export const DEFAULT_MIRROR = "file:///run/live/medium/debian";
export const DEFAULT_MEDIUM = "/run/live/medium/schulos";

export interface Invocation {
  answersFile: string | null;
  unattended: boolean;
  outDir: string;
  install: boolean;
  planFile: string | null;
  target: string;
  mirror: string;
  medium: string;
  /** Abbild der Rolle bauen (B-46) */
  image: "main" | "backup" | null;
  /** vorbereitetes Abbild einrichten (B-46) */
  configure: boolean;
  /** NUR Test/Labor (INST-05): unbeaufsichtigt ohne Bestätigung von Block 8 enden */
  skipConfirmation: boolean;
  /** INST-06: ohne Oberfläche eine fertige SchulOS-Installation überschreiben dürfen */
  overwrite: boolean;
  /** INST-07: CI-Testmodus (Kernel-Parameter schulos.testmodus) – nur damit unbeaufsichtigt installieren bzw. Abbild bauen */
  testMode: boolean;
  /** REPO-03: Vorschau-/Haftungshinweis ohne Oberfläche bestätigt (nur im Testmodus) */
  previewAccepted: boolean;
}

export class UsageError extends Error {}

export interface StuecklisteArgs {
  version: string;
  commit: string;
  quelle: string;
  pakete: string;
  images: string;
  refs: string[];
  live: string | null;
  ausgabe: string;
}

/** `--stueckliste --version … --commit …` (ISO-Bau, iso/build.sh) */
export function parseStuecklisteArgs(argv: string[]): StuecklisteArgs {
  const v: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--stueckliste") continue;
    const val = argv[++i];
    if (!k.startsWith("--") || val === undefined || val.startsWith("--")) throw new UsageError(`${k} braucht einen Wert`);
    v[k.slice(2)] = val;
  }
  for (const k of ["version", "commit", "quelle", "pakete", "images", "refs", "ausgabe"]) if (!v[k]) throw new UsageError(`--stueckliste braucht --${k}`);
  return { version: v.version!, commit: v.commit!, quelle: v.quelle!, pakete: v.pakete!, images: v.images!, refs: v.refs!.split(",").filter(Boolean), live: v.live ?? null, ausgabe: v.ausgabe! };
}

export function parseArgs(argv: string[]): Invocation | "help" | "paketliste" {
  const inv: Invocation = { answersFile: null, unattended: false, outDir: "/run/schulos-installer", install: false, planFile: null, target: "/target", mirror: DEFAULT_MIRROR, medium: DEFAULT_MEDIUM, image: null, configure: false, skipConfirmation: false, overwrite: false, testMode: false, previewAccepted: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new UsageError(`${a} braucht einen Wert`);
      return v;
    };
    if (a === "--help" || a === "-h") return "help";
    else if (a === "--paketliste") return "paketliste";
    else if (a === "--antworten") inv.answersFile = value();
    else if (a === "--unbeaufsichtigt") inv.unattended = true;
    else if (a === "--ohne-bestaetigung") inv.skipConfirmation = true;
    else if (a === "--ueberschreiben") inv.overwrite = true;
    else if (a === "--testmodus") inv.testMode = true;
    else if (a === "--vorschau-verstanden") inv.previewAccepted = true;
    else if (a === "--ausgabe") inv.outDir = value();
    else if (a === "--installieren") inv.install = true;
    else if (a === "--plan") {
      inv.planFile = value();
      inv.install = true;
    }
    else if (a === "--ziel") inv.target = value();
    else if (a === "--quelle") inv.mirror = value();
    else if (a === "--medium") inv.medium = value();
    else if (a === "--abbild") {
      const role = value();
      if (role !== "main" && role !== "backup") throw new UsageError("--abbild main oder --abbild backup");
      inv.image = role;
    } else if (a === "--konfigurieren") inv.configure = true;
    else throw new UsageError(`Unbekannte Angabe ${a}`);
  }
  if (inv.skipConfirmation && !inv.unattended) throw new UsageError("--ohne-bestaetigung nur zusammen mit --unbeaufsichtigt (Test/Labor)");
  // INST-07: Platten löschen ohne Mensch davor nur im CI-Testmodus (ein Stick allein reicht nie)
  if (inv.unattended && inv.install && !inv.testMode)
    throw new UsageError("Unbeaufsichtigt installieren nur im CI-Testmodus (Kernel-Parameter schulos.testmodus) – sonst die Oberfläche nutzen");
  if (inv.skipConfirmation && !inv.testMode) throw new UsageError("--ohne-bestaetigung nur im CI-Testmodus (--testmodus)");
  if (inv.image && !inv.testMode) throw new UsageError("--abbild nur im CI-Testmodus (Kernel-Parameter schulos.testmodus, iso/build-qcow2.sh)");
  if (inv.previewAccepted && !inv.testMode) throw new UsageError("--vorschau-verstanden nur im CI-Testmodus – interaktiv „VERSTANDEN“ eintippen");
  // REPO-03: ohne Oberfläche gilt der Vorschau-/Haftungshinweis nur mit der Datei „vorschau-verstanden“ als bestätigt
  if (inv.unattended && inv.install && !inv.previewAccepted)
    throw new UsageError("Vorschau-Hinweis nicht bestätigt – unbeaufsichtigt nur mit --vorschau-verstanden (Datei „vorschau-verstanden“ auf SCHULOSCFG)");
  if (inv.unattended && !inv.answersFile) throw new UsageError("--unbeaufsichtigt braucht --antworten <datei>");
  if (inv.planFile && inv.answersFile) throw new UsageError("--plan und --antworten schließen sich aus");
  if (inv.overwrite && (inv.image || inv.configure)) throw new UsageError("--ueberschreiben nur beim Installieren (--abbild/--konfigurieren löschen keine fertige Installation)");
  if (inv.image && (inv.answersFile || inv.planFile || inv.install || inv.configure)) throw new UsageError("--abbild braucht keine Antworten und installiert selbst");
  if (inv.configure && (inv.planFile || inv.install)) throw new UsageError("--konfigurieren richtet das laufende System ein – ohne --installieren/--plan");
  return inv;
}

/**
 * Installationsplan für die Systemschritte (B-42) ablegen: `plan.json` (enthält den Kopplungscode, daher 0600) und die
 * erzeugten Dateien unter `root/<zielpfad>` mit ihren Rechten.
 */
export function writePlan(plan: InstallPlan, outDir: string): string {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  for (const f of plan.files) {
    const target = path.join(outDir, "root", f.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, f.content, { mode: f.mode });
    chmodSync(target, f.mode);
  }
  const file = path.join(outDir, "plan.json");
  writeFileSync(file, JSON.stringify(plan, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
