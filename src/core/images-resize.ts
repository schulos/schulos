// Bild verkleinern auf dem Server (RS-04, Raumfotos): sharp – kommt mit Next (Bildoptimierung) und liegt deshalb auch im
// Standalone-Image. Nur für Uploads, deren Typ und Pixelmaße `cleanImage()` (images.ts) schon geprüft hat. Die Ausgabe ist
// immer JPEG ohne Metadaten: sharp übernimmt EXIF/XMP/ICC nur auf ausdrücklichen Wunsch, die Drehung aus EXIF wird vorher
// angewendet (`autoOrient`), danach entfernt `stripJpeg` vorsorglich noch einmal alle APP-Segmente.
// sharp wird erst beim ersten Verkleinern geladen (natives Modul): die gebündelte Kommandozeile (scripts/build-cli.mjs, sharp
// dort extern) zieht über den Demo-Seed diese Datei mit, braucht sharp aber nie.
import { MAX_IMAGE_PIXELS, jpegOrientation, rasterSize, stripJpeg, type ImageSize } from "./images";

export interface ResizedImage {
  data: Uint8Array;
  mime: "image/jpeg";
  size: ImageSize;
}

/** Verkleinert auf höchstens `edge` Pixel Kantenlänge (kleinere Bilder bleiben so groß), Transparenz auf Weiß. */
export async function resizeToJpeg(input: Uint8Array, edge: number, quality = 82): Promise<ResizedImage> {
  const { default: sharp } = await import("sharp");
  const out = await sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error" })
    .autoOrient()
    .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, mozjpeg: false })
    .toBuffer();
  const data = stripJpeg(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
  const size = rasterSize(data, "image/jpeg");
  // nach autoOrient gibt es keine Ausrichtung mehr; eine Angabe ≠ 1 wäre ein Fehler im Ablauf
  if (!size || jpegOrientation(data) !== 1) throw new Error("Verkleinertes Bild unlesbar");
  return { data, mime: "image/jpeg", size };
}
