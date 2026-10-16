// Überschreibschutz (INST-06, Q-INST05-1): Trägt eine Zielplatte die Abschluss-Markierung `/grub/schulos-installiert` auf der
// Boot-Partition (GATE-4f C-03 – auch auf dem RAID-1-Spiegel), löscht der Installer sie nur mit ausdrücklicher Zustimmung:
// interaktiv per eingetipptem „ÜBERSCHREIBEN“, unbeaufsichtigt nur mit dem Schalter `ueberschreiben` (Datei auf SCHULOSCFG bzw.
// `schulos.ueberschreiben` in der Kernel-Zeile → `--ueberschreiben`). Sonst Abbruch mit Code OVERWRITE_EXIT – start-installer.sh
// startet dann nicht neu (kein Kreislauf „Medium + Stick stecken noch → Neuinstallation“).
// Geprüft wird nur lesend: Boot-Partition (bzw. die Daten eines Spiegel-Mitglieds über den Daten-Offset aus `mdadm --examine`)
// mit `ro,noload` einhängen – kein Zusammensetzen des Spiegels, kein Journal-Replay. Rein bis auf die übergebenen Befehle.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { CLEAR_SCREEN, closableAsk, InputClosedError } from "@schulos/server/recovery-key";
import { INSTALLED_MARKER, partition } from "./layout";

/** Exit-Code des Installers, wenn er eine fertige Installation nicht überschreiben darf (start-installer.sh: kein Neustart) */
export const OVERWRITE_EXIT = 5;
/** Wort, das interaktiv eingetippt werden muss */
export const OVERWRITE_WORD = "ÜBERSCHREIBEN";

export interface MarkerInfo {
  role?: string;
  version?: string;
  /** Tag der Installation (JJJJ-MM-TT) */
  date?: string;
}

export interface ExistingInstall extends MarkerInfo {
  disk: string;
}

/** Inhalt der Markierung: erste Zeile wie bisher (ältere Installationen haben nur sie), dann `schluessel=wert` */
export function markerContent(info: MarkerInfo): string {
  const lines = ["SchulOS ist installiert."];
  if (info.role) lines.push(`rolle=${info.role}`);
  if (info.version) lines.push(`version=${info.version}`);
  if (info.date) lines.push(`datum=${info.date}`);
  return `${lines.join("\n")}\n`;
}

export function parseMarker(text: string): MarkerInfo {
  const v: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([a-z]+)=(.*)$/.exec(line.trim());
    if (m) v[m[1]!] = m[2]!.trim().slice(0, 64);
  }
  return { ...(v.rolle ? { role: v.rolle } : {}), ...(v.version ? { version: v.version } : {}), ...(v.datum ? { date: v.datum } : {}) };
}

/** Daten-Offset eines mdadm-Mitglieds in Byte (Metadaten 1.1/1.2); 0 bei 0.90/1.0 (Superblock am Ende) */
export function raidDataOffset(examine: string): number {
  const m = /Data Offset\s*:\s*(\d+)\s*sectors/.exec(examine);
  return m ? Number(m[1]) * 512 : 0;
}

export type Exec = (argv: string[]) => { code: number; stdout: string; stderr: string };

export interface ProbeDeps {
  exec: Exec;
  /** leeres Verzeichnis zum Einhängen */
  mkdtemp: () => string;
  /** Datei lesen, null wenn nicht vorhanden */
  read: (file: string) => string | null;
  /** Verzeichnis wieder entfernen */
  rmdir: (dir: string) => void;
}

/** Eine Platte prüfen: Boot-Partition (Nr. 2) nur lesend einhängen und die Markierung lesen */
export function probeDisk(disk: string, deps: ProbeDeps): ExistingInstall | null {
  const part = partition(disk, 2);
  const type = deps.exec(["blkid", "-p", "-s", "TYPE", "-o", "value", part]);
  if (type.code !== 0) return null;
  let offset = 0;
  const t = type.stdout.trim();
  if (t === "linux_raid_member") offset = raidDataOffset(deps.exec(["mdadm", "--examine", part]).stdout);
  else if (t !== "ext4") return null;
  const dir = deps.mkdtemp();
  try {
    const opts = ["ro", "noload", "nodev", "nosuid", "noexec", ...(offset ? [`offset=${offset}`] : [])].join(",");
    if (deps.exec(["mount", "-t", "ext4", "-o", opts, part, dir]).code !== 0) return null;
    try {
      const text = deps.read(`${dir}/${INSTALLED_MARKER}`);
      return text === null ? null : { disk, ...parseMarker(text) };
    } finally {
      deps.exec(["umount", dir]);
    }
  } finally {
    deps.rmdir(dir);
  }
}

export function findExistingInstalls(disks: string[], deps: ProbeDeps): ExistingInstall[] {
  return disks.map((d) => probeDisk(d, deps)).filter((e): e is ExistingInstall => e !== null);
}

const ROLE_NAMES: Record<string, string> = { main: "Hauptsystem", backup: "Backupserver" };

/** „/dev/vda: Hauptsystem, Version v0.3.1, installiert am 2026-10-12“ – fehlende Angaben (ältere Markierung) entfallen */
export function describeExisting(e: ExistingInstall): string {
  const parts = [e.role ? (ROLE_NAMES[e.role] ?? e.role) : null, e.version ? `Version ${e.version}` : null, e.date ? `installiert am ${e.date}` : null].filter(Boolean);
  return `${e.disk}: ${parts.length ? parts.join(", ") : "Rolle/Version/Datum nicht lesbar"}`;
}

export type OverwriteDecision = "weiter" | "fragen" | "abbruch";

/** Interaktiv wird immer gefragt (der Schalter ersetzt die Rückfrage nicht); ohne Oberfläche nur mit `ueberschreiben` weiter. */
export function overwriteDecision(found: ExistingInstall[], o: { interactive: boolean; overwrite: boolean }): OverwriteDecision {
  if (!found.length) return "weiter";
  if (o.interactive) return "fragen";
  return o.overwrite ? "weiter" : "abbruch";
}

/** Eingabe „ÜBERSCHREIBEN“ (Groß-/Kleinschreibung egal, „UE“ statt „Ü“ geht auch) */
export function overwriteConfirmed(input: string): boolean {
  const a = input.trim().toUpperCase();
  return a === OVERWRITE_WORD || a === "UEBERSCHREIBEN";
}

/** Meldung für den unbeaufsichtigten Abbruch (stdout → tty1 und seriell) */
export function refusalText(found: ExistingInstall[]): string {
  return [
    "",
    "ABBRUCH: Auf der Zielplatte ist bereits SchulOS installiert – es wurde nichts verändert.",
    ...found.map((e) => `  ${describeExisting(e)}`),
    "",
    "Startet der Rechner nach einer Installation wieder vom Medium: Konfigurations-Stick (SCHULOSCFG) abziehen und neu starten –",
    "dann startet das installierte SchulOS von der Festplatte (das Installationsmedium kann eingelegt bleiben).",
    "Wirklich neu installieren (Daten auf der Platte gehen verloren): Datei „ueberschreiben“ auf den SCHULOSCFG-Stick legen",
    "(bzw. schulos.ueberschreiben in die Kernel-Zeile) oder interaktiv installieren.",
    "",
  ].join("\n");
}

export interface OverwriteIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** Interaktive Rückfrage; true nur bei eingetipptem Wort. EOF/Strg+C = nein. */
export async function askOverwrite(found: ExistingInstall[], io: OverwriteIo): Promise<boolean> {
  const out = io.output;
  out.write(CLEAR_SCREEN);
  out.write(
    [
      "",
      "  Auf dieser Platte ist bereits SchulOS installiert:",
      ...found.map((e) => `    ${describeExisting(e)}`),
      "",
      "  Eine Neuinstallation LÖSCHT die Platte mit allen Daten (auch Sicherungen, die nur dort liegen).",
      "  Wollten Sie nur das installierte SchulOS starten? Dann Konfigurations-Stick (SCHULOSCFG, falls vorhanden)",
      "  abziehen und neu starten – das Startmenü des Mediums startet dann die Festplatte.",
      "",
      "",
    ].join("\n"),
  );
  const rl = createInterface({ input: io.input, output: out });
  const ask = closableAsk(rl, io.input);
  let interrupted = false;
  rl.on("SIGINT", () => {
    interrupted = true;
    rl.close();
  });
  try {
    const a = await ask(`  Wirklich überschreiben? Zum Bestätigen „${OVERWRITE_WORD}“ eintippen (sonst Enter = abbrechen): `);
    return !interrupted && overwriteConfirmed(a);
  } catch (e) {
    if (e instanceof InputClosedError) return false;
    throw e;
  } finally {
    rl.close();
  }
}

/**
 * Ganzer Ablauf vor dem Löschen der Platten: prüfen, ggf. fragen. `ok: false` → Installer endet mit OVERWRITE_EXIT und `message`,
 * es wurde nichts verändert. `notice`: Zeile fürs Protokoll, wenn per Schalter überschrieben wird.
 */
export async function checkOverwrite(
  disks: string[],
  o: { interactive: boolean; overwrite: boolean },
  deps: ProbeDeps & { io: OverwriteIo },
): Promise<{ ok: true; found: ExistingInstall[]; notice: string | null } | { ok: false; message: string }> {
  const found = findExistingInstalls(disks, deps);
  const decision = overwriteDecision(found, o);
  if (decision === "weiter")
    return { ok: true, found, notice: found.length ? `Vorhandene SchulOS-Installation wird überschrieben (Schalter „ueberschreiben“): ${found.map((e) => e.disk).join(", ")}` : null };
  if (decision === "fragen")
    return (await askOverwrite(found, deps.io)) ? { ok: true, found, notice: null } : { ok: false, message: "\nAbgebrochen – die vorhandene Installation bleibt unverändert." };
  return { ok: false, message: refusalText(found) };
}

/** Echte Befehle (Live-System, root) */
export function readIfExists(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
