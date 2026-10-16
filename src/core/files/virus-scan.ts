// P4-72: Virenscan optional mit ClamAV (Compose-Profil „clamav“, GPL-2.0, eigener Container – SchulOS spricht nur das
// Netzprotokoll von clamd). Mit SCHULOS_CLAMAV=clamav:3310 prüft SchulOS hochgeladene Dateien, bevor sie gespeichert werden:
// Dateien, Aufgaben (Material und Abgaben), Gebäude-Fotos, Prüfprotokolle. Ohne die Einstellung passiert nichts.
// Ist ClamAV eingeschaltet, aber nicht erreichbar, wird **nicht** gespeichert (streng – Q-4E-57): die Schule hat den Scan
// bewusst eingeschaltet; die Meldung bittet um einen späteren Versuch, Verwaltung → System zeigt den Zustand.
import net from "node:net";
import { crc32 } from "node:zlib";

export interface ClamavTarget {
  host: string;
  port: number;
}

/** „clamav:3310“ bzw. „host“ (Port 3310); leer = aus. Unsinn → Error (Start der App meldet ihn). */
export function clamavTarget(
  env: Record<string, string | undefined> = process.env,
): ClamavTarget | null {
  const v = env.SCHULOS_CLAMAV?.trim();
  if (!v) return null;
  const m = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(v);
  const port = m?.[2] ? Number(m[2]) : 3310;
  if (!m || port < 1 || port > 65535)
    throw new Error(
      `SCHULOS_CLAMAV="${v}" – erwartet host:port, z. B. clamav:3310`,
    );
  return { host: m[1]!, port };
}

export interface ScanResult {
  clean: boolean;
  /** Name der Signatur bei Fund */
  signature: string | null;
}

export class VirusScanError extends Error {}

/** Antwort von clamd auf INSTREAM: „stream: OK“ · „stream: <Signatur> FOUND“ · „… ERROR“ */
export function parseClamdReply(reply: string): ScanResult {
  const r = reply.replace(/\0/g, "").trim();
  if (/^stream: OK$/.test(r)) return { clean: true, signature: null };
  const found = /^stream: (.+) FOUND$/.exec(r);
  if (found) return { clean: false, signature: found[1]! };
  if (/size limit exceeded/i.test(r))
    throw new VirusScanError(
      "Datei zu groß für den Virenscan (StreamMaxLength von clamd)",
    );
  throw new VirusScanError(
    `Virenscan: unerwartete Antwort von clamd (${r.slice(0, 120) || "leer"})`,
  );
}

/** Ein Befehl an clamd (z. B. zVERSION, zINSTREAM) – Antwort bis zum Nullbyte bzw. Verbindungsende */
function talk(
  target: ClamavTarget,
  write: (s: net.Socket) => void,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target.port, target.host);
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    socket.setTimeout(timeoutMs, () =>
      finish(
        new VirusScanError("Virenscan antwortet nicht (Zeitüberschreitung)"),
      ),
    );
    socket.on("connect", () => write(socket));
    socket.on("data", (d: Buffer) => {
      chunks.push(d);
      if (d.indexOf(0) !== -1) finish(null);
    });
    socket.on("end", () => finish(null));
    socket.on("error", (e) =>
      finish(new VirusScanError(`Virenscan nicht erreichbar (${e.message})`)),
    );
  });
}

const CHUNK = 64 * 1024;

/** Daten per INSTREAM prüfen (Länge je Block als 4 Byte Big Endian, Ende mit Länge 0) */
export async function scanBuffer(
  data: Uint8Array,
  target: ClamavTarget,
  timeoutMs = 60_000,
): Promise<ScanResult> {
  const reply = await talk(
    target,
    (s) => {
      s.write("zINSTREAM\0");
      for (let i = 0; i < data.length; i += CHUNK) {
        const part = data.subarray(i, Math.min(i + CHUNK, data.length));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        s.write(len);
        s.write(part);
      }
      s.write(Buffer.alloc(4));
    },
    timeoutMs,
  );
  return parseClamdReply(reply);
}

/** Zustand für Verwaltung → System: Version von clamd (inkl. Stand der Signaturen) bzw. Fehler */
export async function clamavVersion(
  target: ClamavTarget,
  timeoutMs = 5000,
): Promise<string> {
  const r = (await talk(target, (s) => s.write("zVERSION\0"), timeoutMs))
    .replace(/\0/g, "")
    .trim();
  if (!r) throw new VirusScanError("Virenscan: keine Antwort auf VERSION");
  return r;
}

/**
 * Vor dem Speichern eines Uploads: ohne SCHULOS_CLAMAV nichts; sonst prüfen. Fund → VirusScanError mit verständlicher
 * Meldung (ohne die Datei zu speichern); nicht erreichbar → ebenfalls VirusScanError (streng).
 */
export async function assertNoVirus(
  data: Uint8Array,
  name: string,
  env: Record<string, string | undefined> = process.env,
  scan = scanBuffer,
): Promise<void> {
  const target = clamavTarget(env);
  if (!target || data.byteLength === 0) return;
  let r: ScanResult;
  try {
    r = await scan(data, target);
  } catch (err) {
    throw new VirusScanError(
      `„${name}“ wurde nicht gespeichert: ${err instanceof Error ? err.message : String(err)} – bitte später erneut versuchen.`,
    );
  }
  if (!r.clean)
    throw new VirusScanError(
      `„${name}“ enthält Schadsoftware (${r.signature}) und wurde nicht gespeichert.`,
    );
}

/**
 * G4E-O09: kleines passwortgeschütztes ZIP (ZipCrypto-Kennzeichen, ein Eintrag „rechnung.txt“) – der übliche Weg, Schadsoftware am
 * Scanner vorbeizuschicken (Passwort steht im Mailtext). Mit den strengen Einstellungen (compose.yaml, configs clamd-schulos) muss
 * clamd das als Fund melden (Heuristics.Encrypted.Zip). Nur für Tests und `node cli.mjs virenscan-pruefen`.
 */
export function encryptedZipSample(): Uint8Array {
  const name = Buffer.from("rechnung.txt");
  const plain = Buffer.from("SchulOS – harmloser Inhalt\n");
  // 12 Byte Verschlüsselungskopf + „verschlüsselte“ Daten (Inhalt egal – geprüft wird das Kennzeichen)
  const body = Buffer.concat([Buffer.alloc(12, 0x5a), Buffer.from(plain.map((b) => b ^ 0x5a))]);
  const crc = crc32(plain);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // Version
  local.writeUInt16LE(0x0001, 6); // Bit 0: verschlüsselt
  local.writeUInt16LE(0, 8); // gespeichert
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x21, 12); // 1980-01-01
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(plain.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0001, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(plain.length, 24);
  central.writeUInt16LE(name.length, 28);
  // Rest (Extra, Kommentar, Platte, Attribute, Versatz 0) bleibt 0
  const cdOffset = local.length + name.length + body.length;
  const cdSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdOffset, 16);
  return new Uint8Array(Buffer.concat([local, name, body, central, name, end]));
}

/** EICAR-Testdatei (harmloser Standard zum Prüfen von Virenscannern) – nur für Tests und `node cli.mjs virenscan-pruefen` */
// in Teilen zusammengesetzt: so erkennt kein Virenscanner die Quelldatei selbst als Testvirus
export const EICAR = [
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$",
  "EICAR-STANDARD-",
  "ANTIVIRUS-TEST-FILE!$H+H*",
].join("");
