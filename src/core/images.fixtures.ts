// Kleine, von Hand gebaute Bilddateien für Tests (Bild-Baustein, Profilbild, Schullogo) – keine fremden Grafiken.

export const bytes = (...xs: (number | string)[]) => new Uint8Array(xs.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));
export const ascii = (b: Uint8Array) => String.fromCharCode(...b);

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

/** Minimales JPEG: SOI, APP0 (JFIF), APP1 (EXIF), COM, SOS + Daten, EOI */
export const JPEG = bytes(
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x07, "JFIF", 0x00,
  0xff, 0xe1, 0x00, 0x08, "Exif", "GP",
  0xff, 0xfe, 0x00, 0x05, "hi!",
  0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9,
);

/** JPEG mit EXIF vor dem Bildkopf (SOF0, 64 × 48) */
export const JPEG_64x48 = bytes(
  0xff, 0xd8,
  0xff, 0xe1, 0x00, 0x08, "Exif", "GP",
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x30, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9,
);

export function pngChunk(type: string, data: number[] = []): (number | string)[] {
  return [...be32(data.length), type, ...data, 0, 0, 0, 0];
}

/** PNG mit verkürztem Kopf, Text- und EXIF-Block */
export const PNG = bytes(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...pngChunk("IHDR", [0, 0, 0, 1]),
  ...pngChunk("tEXt", [65, 66]),
  ...pngChunk("eXIf", [1]),
  ...pngChunk("IDAT", [7]),
  ...pngChunk("IEND"),
);

/** PNG mit vollständigem Kopf (Breite × Höhe) */
export function pngOf(width: number, height: number): Uint8Array {
  return bytes(
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk("IHDR", [...be32(width), ...be32(height), 8, 6, 0, 0, 0]),
    ...pngChunk("tEXt", [...[..."Author"].map((c) => c.charCodeAt(0)), 0, 65]),
    ...pngChunk("IDAT", [7]),
    ...pngChunk("IEND"),
  );
}

function riff(chunks: (number | string)[][]): Uint8Array {
  const body = bytes("WEBP", ...chunks.flat());
  return bytes("RIFF", ...le32(body.length), ...body);
}
function webpChunk(type: string, data: number[]): (number | string)[] {
  return [type, ...le32(data.length), ...data, ...(data.length % 2 ? [0] : [])];
}

/** WebP verlustbehaftet (VP8), 300 × 100 */
export const WEBP_VP8 = riff([webpChunk("VP8 ", [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(300), ...le16(100), 0, 0])]);
/** WebP verlustfrei (VP8L), 20 × 10 */
export const WEBP_VP8L = riff([webpChunk("VP8L", [0x2f, ...vp8lSize(20, 10), 0, 0])]);
/** WebP erweitert (VP8X mit EXIF- und XMP-Kennzeichen), 640 × 480, mit EXIF- und XMP-Block */
export const WEBP_VP8X = riff([
  webpChunk("VP8X", [0x0c, 0, 0, 0, ...le24(639), ...le24(479)]),
  webpChunk("VP8L", [0x2f, ...vp8lSize(640, 480), 0, 0]),
  webpChunk("EXIF", [..."GPS-Ort".split("").map((c) => c.charCodeAt(0))]),
  webpChunk("XMP ", [..."<x:xmpmeta/>".split("").map((c) => c.charCodeAt(0))]),
]);

function le16(n: number) {
  return [n & 255, (n >>> 8) & 255];
}
function vp8lSize(width: number, height: number): number[] {
  const w = width - 1;
  const h = height - 1;
  const bits = w | (h << 14); // 14 Bit Breite, 14 Bit Höhe, Rest 0
  return [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255];
}

/** EXIF-Block (little-endian wie viele Handys) mit Ausrichtung und einem weiteren Eintrag (GPS-Verweis) */
function exifApp1(orientation: number): (number | string)[] {
  const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
  const tiff = [
    "II", ...le16(42), ...le32(8),
    ...le16(2), // zwei Einträge
    ...le16(0x0112), ...le16(3), ...le32(1), ...le16(orientation), 0, 0, // Ausrichtung
    ...le16(0x8825), ...le16(4), ...le32(1), ...le32(0x1234), // GPS-IFD-Verweis (Inhalt egal, darf nicht bleiben)
    ...le32(0),
    "GPS 51.9N 7.6E",
  ];
  const body = ["Exif", 0, 0, ...tiff];
  const len = bytes(...body).length + 2;
  return [0xff, 0xe1, (len >> 8) & 255, len & 255, ...body];
}

/** Handyfoto: quer gespeichert (SOF 64 × 48), EXIF-Ausrichtung 6 („90° im Uhrzeigersinn drehen“), dazu GPS-Angabe */
export const JPEG_ROTATED = bytes(
  0xff, 0xd8,
  ...exifApp1(6),
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x30, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9,
);
