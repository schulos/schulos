// Bild-Baustein (P4-01): Bildtyp an den ersten Bytes erkennen, Metadaten (EXIF, XMP, Texte) entfernen und Maße lesen –
// reine Byte-Parser ohne Bildbibliothek (keine Skalierung hier; CSS skaliert). Verkleinern auf dem Server nur für Raumfotos
// (RS-04) in images-resize.ts.
// Genutzt von Profilbildern (nur JPEG/PNG), Schullogo (P4-03, dazu SVG über images-svg.ts) und später Mängelfotos (P4-12).
import { ValidationError } from "@/modules/verwaltung/users";

export type RasterMime = "image/jpeg" | "image/png" | "image/webp";
export type ImageMime = RasterMime | "image/svg+xml";

export interface ImageSize {
  width: number;
  height: number;
}

/** Bilddatei passt nicht zu ihrem Typ (abgeschnitten, Blöcke kaputt). */
export class ImageError extends Error {
  constructor(message = "Bilddatei ist beschädigt") {
    super(message);
    this.name = "ImageError";
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

/** Rein: Rasterbild-Typ an den ersten Bytes erkennen – JPEG, PNG, WebP. SVG ist Text und läuft über images-svg.ts. */
export function sniffImage(b: Uint8Array): RasterMime | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && PNG_SIGNATURE.every((x, i) => b[i] === x)) return "image/png";
  if (b.length > 16 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * Rein: Ausrichtung (EXIF-Tag 0x0112, 1–8) aus einem APP1-Segment (ab Marker FF E1); null, wenn keins oder nicht lesbar.
 * Handykameras speichern Hochformat oft quer und vermerken die Drehung nur hier (Code-Review Gate 4a M2).
 */
export function exifOrientation(seg: Uint8Array): number | null {
  if (seg.length < 18 || ascii(seg, 4, 10) !== "Exif\u0000\u0000") return null;
  const t = 10; // Beginn des TIFF-Kopfs
  const order = ascii(seg, t, t + 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const u16 = (i: number) => (i + 2 <= seg.length ? (le ? u16le(seg, i) : u16be(seg, i)) : -1);
  const u32 = (i: number) => (i + 4 <= seg.length ? (le ? u32le(seg, i) : u32be(seg, i)) : -1);
  if (u16(t + 2) !== 42) return null;
  const ifd = u32(t + 4);
  if (ifd < 8) return null;
  const n = u16(t + ifd);
  for (let e = 0; e < n && e < 512; e++) {
    const at = t + ifd + 2 + e * 12;
    if (at + 12 > seg.length) return null;
    if (u16(at) !== 0x0112) continue;
    const v = u16(at + 8);
    return v >= 1 && v <= 8 ? v : null;
  }
  return null;
}

/** Rein: kleinstes APP1-EXIF, das nur die Ausrichtung trägt (big-endian, IFD0 mit einem Eintrag) – sonst keine Metadaten. */
export function orientationSegment(orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation & 0xff, 0, 0, 0, 0, 0, 0];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // "Exif" und zwei Nullbytes
  const len = body.length + 2;
  return new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...body]);
}

/** Rein: Ausrichtung eines JPEG aus dem ersten EXIF-Segment vor den Bilddaten; 1, wenn keine Angabe. */
export function jpegOrientation(b: Uint8Array): number {
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const len = u16be(b, i + 2);
    if (marker === 0xe1) {
      const o = exifOrientation(b.subarray(i, i + 2 + len));
      if (o) return o;
    }
    i += 2 + len;
  }
  return 1;
}

/**
 * Rein: entfernt APP1…APP15 (EXIF, XMP, …) und Kommentare aus einem JPEG; JFIF und ICC-Farbprofil bleiben. Eine
 * EXIF-Ausrichtung ≠ 1 wird als minimales EXIF (nur dieses Tag) an der Stelle des alten Segments wieder eingesetzt.
 */
export function stripJpeg(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let orientationKept = false;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new ImageError();
    const marker = b[i + 1]!;
    if (marker === 0xda) {
      out.push(b.subarray(i)); // Start of Scan: Rest sind Bilddaten
      return concat(out);
    }
    if (marker === 0xff) {
      i++; // Füllbyte
      continue;
    }
    const len = u16be(b, i + 2);
    const seg = b.subarray(i, i + 2 + len);
    const isIcc = marker === 0xe2 && ascii(seg, 4, 15) === "ICC_PROFILE";
    const drop = (marker >= 0xe1 && marker <= 0xef && !isIcc) || marker === 0xfe;
    if (!drop) out.push(seg);
    else if (marker === 0xe1 && !orientationKept) {
      const o = exifOrientation(seg);
      if (o && o !== 1) {
        out.push(orientationSegment(o));
        orientationKept = true;
      }
    }
    i += 2 + len;
  }
  throw new ImageError();
}

/** Rein: entfernt Text-, Zeit- und EXIF-Blöcke aus einem PNG. */
export function stripPng(b: Uint8Array): Uint8Array {
  const DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = ascii(b, i + 4, i + 8);
    const end = i + 12 + len;
    if (end > b.length) break;
    if (!DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") return concat(out);
  }
  throw new ImageError();
}

/** Rein: entfernt EXIF- und XMP-Blöcke aus einem WebP (RIFF) und passt Kopf und VP8X-Kennzeichen an. */
export function stripWebp(b: Uint8Array): Uint8Array {
  if (sniffImage(b) !== "image/webp") throw new ImageError();
  const out: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, i + 4);
    const len = u32le(b, i + 4);
    const end = i + 8 + len + (len % 2); // Blöcke sind auf gerade Länge aufgefüllt
    if (i + 8 + len > b.length) throw new ImageError();
    if (type !== "EXIF" && type !== "XMP ") {
      const chunk = b.slice(i, Math.min(end, b.length));
      if (type === "VP8X" && len >= 10) chunk[8] = chunk[8]! & ~0x0c; // Kennzeichen „hat EXIF/XMP“ löschen
      out.push(chunk);
    }
    i = end;
  }
  if (i < b.length || !out.length) throw new ImageError();
  const body = concat(out);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 12));
  const size = body.length + 4;
  head[4] = size & 255;
  head[5] = (size >>> 8) & 255;
  head[6] = (size >>> 16) & 255;
  head[7] = (size >>> 24) & 255;
  return concat([head, body]);
}

/** Rein: Metadaten passend zum Typ entfernen. */
export function stripMetadata(b: Uint8Array, mime: RasterMime): Uint8Array {
  return mime === "image/jpeg" ? stripJpeg(b) : mime === "image/png" ? stripPng(b) : stripWebp(b);
}

/** Rein: Breite und Höhe eines Rasterbilds aus dem Kopf (PNG-IHDR, JPEG-SOF, WebP-VP8/VP8L/VP8X); null, wenn nicht lesbar. */
export function rasterSize(b: Uint8Array, mime: RasterMime): ImageSize | null {
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  if (mime === "image/png") {
    if (b.length < 24 || ascii(b, 12, 16) !== "IHDR") return null;
    return ok(u32be(b, 16), u32be(b, 20));
  }
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2; // Marker ohne Länge
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return i + 9 <= b.length ? ok(u16be(b, i + 7), u16be(b, i + 5)) : null;
      i += 2 + u16be(b, i + 2);
    }
    return null;
  }
  const type = ascii(b, 12, 16);
  const d = 20; // Beginn der Blockdaten
  if (b.length < d + (type === "VP8L" ? 5 : 10)) return null;
  if (type === "VP8X") return ok(u24le(b, d + 4) + 1, u24le(b, d + 7) + 1);
  if (type === "VP8L") {
    if (b[d] !== 0x2f) return null;
    const [b1, b2, b3, b4] = [b[d + 1]!, b[d + 2]!, b[d + 3]!, b[d + 4]!];
    return ok(1 + (((b2 & 0x3f) << 8) | b1), 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)));
  }
  if (type === "VP8 ") {
    if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) return null;
    return ok(u16le(b, d + 6) & 0x3fff, u16le(b, d + 8) & 0x3fff);
  }
  return null;
}

/** Rein: Maße eines SVG aus `width`/`height` (ohne Prozent/em) bzw. `viewBox` des Wurzelelements; null, wenn keine Angabe. */
export function svgSize(text: string): ImageSize | null {
  const root = /<svg\b([^>]*)>/i.exec(text)?.[1];
  if (root === undefined) return null;
  const attr = (name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(root);
  const value = (name: string) => {
    const m = attr(name);
    return m ? (m[1] ?? m[2] ?? "").trim() : null;
  };
  const len = (v: string | null) => {
    const m = v ? /^(\d+(?:\.\d+)?)\s*(px)?$/i.exec(v) : null;
    return m ? Math.round(Number(m[1])) : null;
  };
  const viewBox = value("viewBox")
    ?.split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const vb = viewBox && viewBox.length === 4 && viewBox[2]! > 0 && viewBox[3]! > 0 ? { width: viewBox[2]!, height: viewBox[3]! } : null;
  const w = len(value("width"));
  const h = len(value("height"));
  if (w && h) return { width: w, height: h };
  if (vb) {
    // nur eine Angabe vorhanden: die andere aus dem Seitenverhältnis der viewBox
    if (w) return { width: w, height: Math.max(1, Math.round((w * vb.height) / vb.width)) };
    if (h) return { width: Math.max(1, Math.round((h * vb.width) / vb.height)), height: h };
    return { width: Math.max(1, Math.round(vb.width)), height: Math.max(1, Math.round(vb.height)) };
  }
  return null;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Höchste Kantenlänge und Pixelzahl – darüber bringt schon das Anzeigen den Browser an Grenzen (Dekompressionsbombe). */
export const MAX_IMAGE_EDGE = 12_000;
export const MAX_IMAGE_PIXELS = 40_000_000;

/** Regeln für einen Bild-Upload; Fehlertexte in Alltagssprache, `field` ist das Formularfeld der Meldung. */
export interface ImageRules {
  field: string;
  maxBytes: number;
  types: readonly RasterMime[];
  empty: string;
  tooBig: string;
  wrongType: string;
}

/** Rein: prüft ein hochgeladenes Rasterbild (Größe, Pixelmaße, Typ an den Bytes) und entfernt seine Metadaten (Ausrichtung bleibt). */
export function cleanImage(bytes: Uint8Array, rules: ImageRules): { data: Uint8Array; mime: RasterMime; size: ImageSize | null } {
  if (!bytes.length) throw new ValidationError({ [rules.field]: rules.empty });
  if (bytes.length > rules.maxBytes) throw new ValidationError({ [rules.field]: rules.tooBig });
  const mime = sniffImage(bytes);
  if (!mime || !rules.types.includes(mime)) throw new ValidationError({ [rules.field]: rules.wrongType });
  try {
    const data = stripMetadata(bytes, mime);
    const raw = rasterSize(data, mime);
    if (raw && (raw.width > MAX_IMAGE_EDGE || raw.height > MAX_IMAGE_EDGE || raw.width * raw.height > MAX_IMAGE_PIXELS))
      throw new ValidationError({ [rules.field]: `Bild hat zu viele Pixel (höchstens ${MAX_IMAGE_EDGE} Pixel Kantenlänge bzw. 40 Megapixel)` });
    // gedrehte Aufnahmen (EXIF-Ausrichtung 5–8): angezeigt werden Breite und Höhe vertauscht
    const size = raw && mime === "image/jpeg" && jpegOrientation(data) >= 5 ? { width: raw.height, height: raw.width } : raw;
    return { data, mime, size };
  } catch (err) {
    if (err instanceof ImageError) throw new ValidationError({ [rules.field]: err.message });
    throw err;
  }
}
