// GATE-031 (C-01): Host-Dateien aus dem signierten Release übernehmen. Bis v0.3.1 tauschte `schulosctl update` nur die
// Images – schulosctl selbst und compose.yaml blieben für immer auf dem Stand der Installation, Umstellungen wie SEC-07
// (App-Datenbankrolle ohne Superuser) kamen so nie an. Ab Releases mit `files` im Manifest:
//   - compose.yaml: während des Updates vor `pull`/`up` ersetzt (Prüfsumme aus dem signierten Manifest, `docker compose
//     config` muss die neue Datei mit der .env akzeptieren), alte Fassung als compose.yaml.vorher-<version>; der Rückweg
//     legt sie zurück.
//   - schulosctl.mjs: nach einem gelungenen Schritt ersetzt (neue Datei muss `version` beantworten), alte Fassung als
//     schulosctl.mjs.vorher; danach startet das neue schulosctl seine einmaligen Umstellungen (`db-rolle`).
// Ohne `files` im Manifest (ältere Releases) bleibt alles wie bisher.
import { sha256Hex, verifyHostFile, type HostFile, type ReleaseManifest } from "@schulos/server/release";

export interface HostFileDeps {
  /** Inhalt bzw. null, wenn es die Datei nicht gibt */
  read(file: string): Uint8Array | null;
  write(file: string, data: Uint8Array, mode: number): void;
  /** atomar ersetzen */
  rename(from: string, to: string): void;
  remove(file: string): void;
  /** Datei des Releases (Anhang bzw. aus dem Offline-Ordner); null = nicht beschaffbar */
  fetch(m: ReleaseManifest, name: HostFile): Promise<Uint8Array | null>;
}

export interface StagedCompose {
  note: string;
  /** alte Fassung zurücklegen (Rückweg bzw. Abbruch vor dem Start) */
  restore(): void;
}

/** Datei aus dem Release holen und gegen das signierte Manifest prüfen. */
async function fetchVerified(d: HostFileDeps, m: ReleaseManifest, name: HostFile): Promise<Uint8Array> {
  const data = await d.fetch(m, name);
  if (!data) throw new Error(`${name} aus Release ${m.version} nicht abrufbar`);
  verifyHostFile(m, name, data);
  return data;
}

/**
 * compose.yaml des Releases einsetzen. `known`: Prüfsummen aller compose.yaml bekannter Releases – passt die vorhandene
 * Datei zu keiner, war sie von Hand geändert (Hinweis im Protokoll, Sicherung bleibt liegen). `validate` prüft die neue
 * Datei (null = in Ordnung, sonst Fehlertext); schlägt sie fehl, bleibt die alte.
 */
export async function stageCompose(
  d: HostFileDeps,
  o: { file: string; m: ReleaseManifest; from: string; known: ReadonlySet<string>; validate: () => Promise<string | null> },
): Promise<StagedCompose | null> {
  const want = o.m.files?.["compose.yaml"];
  if (!want) return null;
  const current = d.read(o.file);
  if (current && sha256Hex(current) === want) return null;
  const data = await fetchVerified(d, o.m, "compose.yaml");
  const backup = `${o.file}.vorher-${o.from}`;
  if (current) d.write(backup, current, 0o640);
  const tmp = `${o.file}.neu`;
  d.write(tmp, data, 0o640);
  d.rename(tmp, o.file);
  const restore = () => {
    if (current) d.write(o.file, current, 0o640);
  };
  const problem = await o.validate();
  if (problem) {
    restore();
    throw new Error(`compose.yaml aus Release ${o.m.version} passt nicht zur .env: ${problem}`);
  }
  const modified = current && !o.known.has(sha256Hex(current));
  return {
    note: `compose.yaml aus ${o.m.version} übernommen${current ? ` (vorige Fassung: ${backup.split(/[\\/]/).at(-1)}${modified ? ", war von Hand geändert – Änderungen prüfen" : ""})` : ""}`,
    restore,
  };
}

/**
 * Name der Probedatei für das neue schulosctl (GATE-031 R-01): Node bestimmt das Modulformat über die Endung – eine
 * ESM-Datei `schulosctl.mjs.neu` bricht mit ERR_UNKNOWN_FILE_EXTENSION ab, der Probestart scheiterte so immer.
 * Deshalb `.neu` vor die Endung: `schulosctl.neu.mjs`.
 */
export function ctlProbeFile(file: string): string {
  const ext = /\.(mjs|cjs|js)$/.exec(file)?.[0] ?? ".mjs";
  return `${file.slice(0, file.length - (file.endsWith(ext) ? ext.length : 0))}.neu${ext}`;
}

/**
 * schulosctl.mjs des Releases einsetzen (nach einem gelungenen Schritt). `smoke` startet die neue Datei probeweise
 * (`version`); erst dann wird getauscht. Rückgabe: Protokolltext bzw. null (nichts zu tun).
 */
export async function replaceCtl(d: HostFileDeps, o: { file: string; m: ReleaseManifest; smoke: (file: string) => Promise<boolean> }): Promise<string | null> {
  const want = o.m.files?.["schulosctl.mjs"];
  if (!want) return null;
  const current = d.read(o.file);
  // nur auf installierten Servern (Entwicklung/CI: schulosctl liegt nicht im Installationsordner)
  if (!current) return null;
  if (sha256Hex(current) === want) return null;
  const data = await fetchVerified(d, o.m, "schulosctl.mjs");
  const tmp = ctlProbeFile(o.file);
  d.write(tmp, data, 0o755);
  if (!(await o.smoke(tmp))) {
    d.remove(tmp);
    throw new Error(`schulosctl aus Release ${o.m.version} startet nicht – alte Fassung bleibt`);
  }
  d.write(`${o.file}.vorher`, current, 0o755);
  d.rename(tmp, o.file);
  return `schulosctl aus ${o.m.version} übernommen (vorige Fassung: schulosctl.mjs.vorher)`;
}
