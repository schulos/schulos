// Konsolenschrift des Live-Systems (INST-02). Die Schriften von console-setup (Uni2/Lat15, auch Terminus) haben Rahmenlinien,
// █ ░ ▒ ▶ ◀ √ usw., aber keine Halbblöcke ▀ ▄ ▌ ▐ und kein ▓ – damit wäre das Logo der
// Oberfläche unleserlich (der QR-Code des Wiederherstellungsschlüssels ist mit INST-05 entfallen). Beim ISO-Bau (Hook) entsteht daraus „schulos-<B>x<H>.psf“: Terminus Bold
// mit diesen Zeichen statt einiger seltener kyrillischer Buchstaben; ► und ◄ zeigen auf ▶ und ◀ (wie in CP437). Beim Start der
// Oberfläche wählt `pickConsoleFont` die größte Größe, mit der die Konsole noch mindestens 100×30 (sonst 80×25) Zeichen hat.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const PSF2_MAGIC = 0x864ab572;
const HAS_TABLE = 1;

export interface Psf2 {
  width: number;
  height: number;
  /** Bitmaps, je Zeile ceil(width/8) Bytes, höchstes Bit links */
  glyphs: Buffer[];
  /** je Glyphe: einzelne Codepoints und (roh) Folgen ab dem ersten 0xFE */
  table: { codepoints: number[]; sequences: Buffer }[];
}

/** PSF1 (8 Pixel breit, 256/512 Glyphen, Tabelle in UCS-2) → dieselbe Form wie PSF2 */
function parsePsf1(buf: Buffer): Psf2 {
  const mode = buf[2]!;
  const height = buf[3]!;
  const count = mode & 1 ? 512 : 256;
  if (!(mode & 2)) throw new Error("Schrift ohne Unicode-Tabelle");
  const glyphs: Buffer[] = [];
  for (let i = 0; i < count; i++) glyphs.push(Buffer.from(buf.subarray(4 + i * height, 4 + (i + 1) * height)));
  const table: Psf2["table"] = [];
  let pos = 4 + count * height;
  for (let i = 0; i < count; i++) {
    const codepoints: number[] = [];
    const seqs: number[][] = [];
    let cur: number[] | null = null;
    for (;;) {
      const u = buf.readUInt16LE(pos);
      pos += 2;
      if (u === 0xffff) break;
      if (u === 0xfffe) seqs.push((cur = []));
      else (cur ?? codepoints).push(u);
    }
    const sequences = Buffer.concat(seqs.map((s) => Buffer.concat([Buffer.from([0xfe]), Buffer.from(String.fromCodePoint(...s), "utf8")])));
    table.push({ codepoints, sequences });
  }
  return { width: 8, height, glyphs, table };
}

/** PSF2 oder PSF1 lesen (console-setup liefert 8 Pixel breite Größen als PSF1) */
export function parsePsf2(buf: Buffer): Psf2 {
  if (buf[0] === 0x36 && buf[1] === 0x04) return parsePsf1(buf);
  if (buf.readUInt32LE(0) !== PSF2_MAGIC) throw new Error("keine PSF-Schrift");
  const headerSize = buf.readUInt32LE(8);
  const flags = buf.readUInt32LE(12);
  const count = buf.readUInt32LE(16);
  const bytes = buf.readUInt32LE(20);
  const height = buf.readUInt32LE(24);
  const width = buf.readUInt32LE(28);
  if (!(flags & HAS_TABLE)) throw new Error("Schrift ohne Unicode-Tabelle");
  const glyphs: Buffer[] = [];
  for (let i = 0; i < count; i++) glyphs.push(Buffer.from(buf.subarray(headerSize + i * bytes, headerSize + (i + 1) * bytes)));
  const table: Psf2["table"] = [];
  let pos = headerSize + count * bytes;
  for (let i = 0; i < count; i++) {
    const end = buf.indexOf(0xff, pos);
    if (end < 0) throw new Error("Unicode-Tabelle unvollständig");
    const entry = buf.subarray(pos, end);
    const seq = entry.indexOf(0xfe);
    const singles = seq < 0 ? entry : entry.subarray(0, seq);
    table.push({ codepoints: [...singles.toString("utf8")].map((c) => c.codePointAt(0)!), sequences: Buffer.from(seq < 0 ? [] : entry.subarray(seq)) });
    pos = end + 1;
  }
  return { width, height, glyphs, table };
}

export function serializePsf2(f: Psf2): Buffer {
  const bytes = f.glyphs[0]!.length;
  const header = Buffer.alloc(32);
  [PSF2_MAGIC, 0, 32, HAS_TABLE, f.glyphs.length, bytes, f.height, f.width].forEach((v, i) => header.writeUInt32LE(v, i * 4));
  const table = f.table.map((t) => Buffer.concat([Buffer.from(String.fromCodePoint(...t.codepoints), "utf8"), t.sequences, Buffer.from([0xff])]));
  return Buffer.concat([header, ...f.glyphs, ...table]);
}

/** Bitmap aus einer Funktion (Spalte, Zeile) → gesetzt */
function bitmap(f: Psf2, on: (x: number, y: number) => boolean): Buffer {
  const row = Math.ceil(f.width / 8);
  const out = Buffer.alloc(row * f.height);
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) if (on(x, y)) out[y * row + (x >> 3)]! |= 0x80 >> (x & 7);
  return out;
}

const glyphOf = (f: Psf2, cp: number) => f.table.findIndex((t) => t.codepoints.includes(cp));
const bit = (f: Psf2, g: Buffer, x: number, y: number) => (g[y * Math.ceil(f.width / 8) + (x >> 3)]! & (0x80 >> (x & 7))) !== 0;

/** Zeichen, die die Schrift danach zusätzlich kann */
export const ADDED = { "▀": 0x2580, "▄": 0x2584, "▌": 0x258c, "▐": 0x2590, "▓": 0x2593 } as const;
/** zusätzliche Codepoints auf vorhandenen Glyphen: ► → ▶, ◄ → ◀ */
export const ALIASES: [number, number][] = [
  [0x25ba, 0x25b6],
  [0x25c4, 0x25c0],
];
// Plätze für ADDED: Glyphen, die nur seltene kyrillische Buchstaben tragen (serbisch/makedonisch: Ђ Љ Њ Ћ Џ …, nicht das
// russische Grundalphabet), danach nur griechische – alle 512 Plätze sind belegt, die Oberfläche braucht beides nie
const DONOR_RANGES: [number, number][][] = [
  [
    [0x0400, 0x040f],
    [0x0450, 0x045f],
  ],
  [[0x0370, 0x03ff]],
];
const donorsOf = (f: Psf2) =>
  DONOR_RANGES.flatMap((ranges) =>
    f.table
      .map((t, i) => (t.codepoints.length > 0 && t.sequences.length === 0 && t.codepoints.every((c) => ranges.some(([a, b]) => c >= a && c <= b)) ? i : -1))
      .filter((i) => i >= 0),
  );

export function patchConsoleFont(input: Psf2): Psf2 {
  const f: Psf2 = { ...input, glyphs: input.glyphs.map((g) => Buffer.from(g)), table: input.table.map((t) => ({ ...t, codepoints: [...t.codepoints] })) };
  const half = Math.floor(f.height / 2);
  const mid = Math.floor(f.width / 2);
  const light = glyphOf(f, 0x2591);
  const draw: Record<keyof typeof ADDED, (x: number, y: number) => boolean> = {
    "▀": (_x, y) => y < half,
    "▄": (_x, y) => y >= half,
    "▌": (x) => x < mid,
    "▐": (x) => x >= mid,
    // ▓ = Umkehrung von ░ (sonst ein dichtes Raster)
    "▓": (x, y) => (light >= 0 ? !bit(f, f.glyphs[light]!, x, y) : (x + 2 * y) % 4 !== 0),
  };
  const donors = donorsOf(f);
  for (const [ch, cp] of Object.entries(ADDED) as [keyof typeof ADDED, number][]) {
    if (glyphOf(f, cp) >= 0) continue;
    const i = donors.shift();
    if (i === undefined) throw new Error("kein freier Platz in der Schrift");
    f.glyphs[i] = bitmap(f, draw[ch]);
    f.table[i] = { codepoints: [cp], sequences: Buffer.alloc(0) };
  }
  for (const [alias, target] of ALIASES) {
    const i = glyphOf(f, target);
    if (i >= 0 && glyphOf(f, alias) < 0) f.table[i]!.codepoints.push(alias);
  }
  return f;
}

/** Terminus-Bold-Größen von console-setup: Dateiname → Breite × Höhe */
export const TERMINUS_SIZES: { file: string; width: number; height: number }[] = [
  { file: "Uni2-TerminusBold16.psf.gz", width: 8, height: 16 },
  { file: "Uni2-TerminusBold20x10.psf.gz", width: 10, height: 20 },
  { file: "Uni2-TerminusBold22x11.psf.gz", width: 11, height: 22 },
  { file: "Uni2-TerminusBold24x12.psf.gz", width: 12, height: 24 },
  { file: "Uni2-TerminusBold28x14.psf.gz", width: 14, height: 28 },
  { file: "Uni2-TerminusBold32x16.psf.gz", width: 16, height: 32 },
];

export const fontName = (width: number, height: number) => `schulos-${width}x${height}.psf`;

/** ISO-Bau: alle Größen aus `fromDir` (console-setup) als SchulOS-Schrift nach `toDir` (unkomprimiert, reproduzierbar) */
export function buildConsoleFonts(fromDir: string, toDir: string): string[] {
  mkdirSync(toDir, { recursive: true });
  return TERMINUS_SIZES.map((s) => {
    const src = path.join(fromDir, s.file);
    if (!existsSync(src)) throw new Error(`Konsolenschrift fehlt: ${src}`);
    const f = patchConsoleFont(parsePsf2(gunzipSync(readFileSync(src))));
    const out = path.join(toDir, fontName(f.width, f.height));
    writeFileSync(out, serializePsf2(f));
    return out;
  });
}

/**
 * Größte Schrift, mit der der Bildschirm (Pixel) mindestens 100×30 Zeichen fasst – sonst die größte mit 80×25, sonst die
 * kleinste. null ohne Angaben.
 */
export function pickConsoleFont(px: { width: number; height: number } | null): { width: number; height: number } | null {
  if (!px || px.width <= 0 || px.height <= 0) return null;
  const sizes = [...TERMINUS_SIZES].sort((a, b) => b.height - a.height);
  const fits = (cols: number, rows: number) => sizes.find((s) => Math.floor(px.width / s.width) >= cols && Math.floor(px.height / s.height) >= rows);
  const s = fits(100, 30) ?? fits(80, 25) ?? sizes.at(-1)!;
  return { width: s.width, height: s.height };
}

/** /sys/class/graphics/fb0/virtual_size: „1280,800“ */
export function parseFbSize(text: string): { width: number; height: number } | null {
  const m = /^(\d+),(\d+)/.exec(text.trim());
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** Ablage der SchulOS-Schrift im Live-System (Hook 9000-schulos) und im installierten System (INST-03) */
export const CONSOLE_FONT_DIR = "/usr/local/share/schulos/konsolenschrift";

/** Linux-Konsole (VT) auf UTF-8 schalten und die passende SchulOS-Schrift laden; false ohne Schrift/setfont (dann Standardschrift) */
export function loadConsoleFont(fontDir: string = CONSOLE_FONT_DIR): boolean {
  if (process.env.TERM !== "linux" || !process.stdout.isTTY) return false;
  process.stdout.write("\x1b%G");
  if (!existsSync(fontDir)) return false;
  let px = null;
  try {
    px = parseFbSize(readFileSync("/sys/class/graphics/fb0/virtual_size", "utf8"));
  } catch {
    // ohne Framebuffer (VGA-Textmodus) bleibt es bei 8×16
  }
  const f = pickConsoleFont(px) ?? { width: 8, height: 16 };
  const file = path.join(fontDir, fontName(f.width, f.height));
  return existsSync(file) && spawnSync("setfont", [file], { stdio: "inherit" }).status === 0;
}

/**
 * INST-11: SchulOS-Schrift laden und alle `everyMs` neu laden. setupcon (console-setup.service bzw. die udev-Regel bei
 * „vtcon add“, z. B. wenn der Grafiktreiber von Hyper-V spät übernimmt) ersetzt sie sonst nach unserem Start durch Terminus ohne
 * ▀ ▄ √ ► – Logo und Marken erscheinen dann als ♦ (Befund Hyper-V 0.5.4). Wie konsole.sh im installierten System (INST-05).
 * Ohne Schrift bzw. außerhalb der Linux-Konsole: nichts (Rückgabe: Abbrechen).
 */
export function keepConsoleFont(fontDir: string = CONSOLE_FONT_DIR, everyMs = 15_000, load: (dir: string) => boolean = loadConsoleFont): () => void {
  if (!load(fontDir)) return () => {};
  const timer = setInterval(() => load(fontDir), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
