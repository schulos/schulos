// Minimaler ZIP-Schreiber (Deflate über node:zlib) für Exporte – ohne Zusatzabhängigkeit.
// Kein ZIP64: Exporte bleiben weit unter 4 GB bzw. 65 535 Einträgen (wird geprüft).
import { promisify } from "node:util";
import { deflateRaw, deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Pfad im Archiv mit „/“ als Trenner */
  name: string;
  data: Uint8Array;
  modifiedAt?: Date;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Baut ein ZIP-Archiv. Namen werden als UTF-8 markiert (Umlaute in Dateinamen). */
export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > 0xffff) throw new Error("Zu viele Einträge für ein ZIP ohne ZIP64");
  const w = zipWriter();
  for (const e of entries) w.add(e, deflateRawSync(e.data));
  return w.finish();
}

const deflateRawAsync = promisify(deflateRaw);

/**
 * Wie createZip, aber komprimiert im Thread-Pool statt im Event-Loop (SEC-05): große Exporte blockieren sonst den
 * einzigen Node-Prozess für alle. Die Rohdaten eines Eintrags werden nach dem Komprimieren nicht mehr gehalten.
 */
export async function createZipAsync(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>): Promise<Uint8Array> {
  const w = zipWriter();
  for await (const e of entries) w.add(e, await deflateRawAsync(e.data));
  return w.finish();
}

function zipWriter() {
  const enc = new TextEncoder();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  return {
    add(e: ZipEntry, compressed: Buffer) {
      const name = e.name.replaceAll("\\", "/").replace(/^\/+/, "");
      if (!name || name.split("/").includes("..")) throw new Error(`Ungültiger Name im Archiv: ${e.name}`);
      if (seen.has(name)) throw new Error(`Doppelter Name im Archiv: ${name}`);
      if (seen.size >= 0xffff) throw new Error("Zu viele Einträge für ein ZIP ohne ZIP64");
      seen.add(name);
      const nameBytes = Buffer.from(enc.encode(name));
      const useDeflate = compressed.length < e.data.length;
      const body = useDeflate ? compressed : Buffer.from(e.data);
      const crc = crc32(e.data);
      const { time, date } = dosTime(e.modifiedAt ?? new Date());
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8
      local.writeUInt16LE(useDeflate ? 8 : 0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(e.data.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      local.writeUInt16LE(0, 28);
      locals.push(local, nameBytes, body);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(useDeflate ? 8 : 0, 10);
      central.writeUInt16LE(time, 12);
      central.writeUInt16LE(date, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(body.length, 20);
      central.writeUInt32LE(e.data.length, 24);
      central.writeUInt16LE(nameBytes.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, nameBytes);
      offset += 30 + nameBytes.length + body.length;
      if (offset > 0xffffffff) throw new Error("Archiv zu groß für ZIP ohne ZIP64");
    },
    finish(): Uint8Array {
      const centralSize = centrals.reduce((s, b) => s + b.length, 0);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(seen.size, 8);
      end.writeUInt16LE(seen.size, 10);
      end.writeUInt32LE(centralSize, 12);
      end.writeUInt32LE(offset, 16);
      return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
    },
  };
}

/** Liest ein mit createZip erzeugtes Archiv wieder (für Tests). */
export function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const buf = Buffer.from(zip);
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    out.set(name, new Uint8Array(method === 8 ? inflateRawSync(raw) : raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
