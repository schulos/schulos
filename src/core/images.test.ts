import { describe, expect, it } from "vitest";
import { ValidationError } from "@/modules/verwaltung/users";
import { ascii, bytes, JPEG, JPEG_64x48, JPEG_ROTATED, PNG, pngOf, WEBP_VP8, WEBP_VP8L, WEBP_VP8X } from "./images.fixtures";
import { cleanImage, ImageError, jpegOrientation, rasterSize, sniffImage, stripJpeg, stripPng, stripWebp, svgSize, type ImageRules } from "./images";

const RULES: ImageRules = { field: "logo", maxBytes: 1024, types: ["image/png", "image/webp"], empty: "leer", tooBig: "zu groß", wrongType: "falscher Typ" };

describe("Bild-Baustein: Typ erkennen", () => {
  it("erkennt JPEG, PNG und WebP an den Bytes, sonst nichts", () => {
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(WEBP_VP8)).toBe("image/webp");
    expect(sniffImage(WEBP_VP8X)).toBe("image/webp");
    expect(sniffImage(bytes("GIF89a....."))).toBeNull();
    expect(sniffImage(bytes("<svg></svg>"))).toBeNull();
    expect(sniffImage(bytes("RIFF....WAVEfmt ...."))).toBeNull();
  });
});

describe("Bild-Baustein: Metadaten entfernen", () => {
  it("JPEG: EXIF und Kommentar fallen weg, JFIF und Bilddaten bleiben", () => {
    const out = ascii(stripJpeg(JPEG));
    expect(out).toContain("JFIF");
    expect(out).not.toContain("Exif");
    expect(out).not.toContain("hi!");
    expect(out.endsWith(ascii(bytes(0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9)))).toBe(true);
  });

  it("JPEG vom Handy: Ausrichtung bleibt als minimales EXIF, alles andere (GPS) fällt weg (Code-Review Gate 4a M2)", () => {
    expect(jpegOrientation(JPEG_ROTATED)).toBe(6);
    const out = stripJpeg(JPEG_ROTATED);
    expect(jpegOrientation(out)).toBe(6);
    expect(ascii(out)).not.toContain("GPS");
    expect(out.length).toBeLessThan(JPEG_ROTATED.length);
    expect(rasterSize(out, "image/jpeg")).toEqual({ width: 64, height: 48 });
    // ohne Ausrichtung (bzw. 1) kommt kein EXIF zurück
    expect(ascii(stripJpeg(JPEG_64x48))).not.toContain("Exif");
    expect(jpegOrientation(JPEG_64x48)).toBe(1);
  });

  it("PNG: Text- und EXIF-Blöcke fallen weg", () => {
    const out = ascii(stripPng(PNG));
    expect(out).toContain("IHDR");
    expect(out).toContain("IDAT");
    expect(out).toContain("IEND");
    expect(out).not.toContain("tEXt");
    expect(out).not.toContain("eXIf");
  });

  it("WebP: EXIF und XMP fallen weg, Kopfgröße und VP8X-Kennzeichen stimmen danach", () => {
    const out = stripWebp(WEBP_VP8X);
    const text = ascii(out);
    expect(text).not.toContain("EXIF");
    expect(text).not.toContain("GPS");
    expect(text).not.toContain("xmpmeta");
    expect(text).toContain("VP8L");
    const riffSize = out[4]! | (out[5]! << 8) | (out[6]! << 16) | (out[7]! << 24);
    expect(riffSize).toBe(out.length - 8);
    expect(out[20]! & 0x0c).toBe(0); // VP8X-Kennzeichen „EXIF/XMP vorhanden“ gelöscht
    expect(rasterSize(out, "image/webp")).toEqual({ width: 640, height: 480 });
  });

  it("kaputte Dateien werfen ImageError", () => {
    expect(() => stripJpeg(JPEG.subarray(0, 12))).toThrow(ImageError);
    expect(() => stripPng(PNG.subarray(0, 30))).toThrow(ImageError);
    expect(() => stripWebp(WEBP_VP8X.subarray(0, 40))).toThrow(ImageError);
  });
});

describe("Bild-Baustein: Maße lesen", () => {
  it("PNG, JPEG und alle drei WebP-Arten", () => {
    expect(rasterSize(pngOf(120, 40), "image/png")).toEqual({ width: 120, height: 40 });
    expect(rasterSize(JPEG_64x48, "image/jpeg")).toEqual({ width: 64, height: 48 });
    expect(rasterSize(stripJpeg(JPEG_64x48), "image/jpeg")).toEqual({ width: 64, height: 48 });
    expect(rasterSize(WEBP_VP8, "image/webp")).toEqual({ width: 300, height: 100 });
    expect(rasterSize(WEBP_VP8L, "image/webp")).toEqual({ width: 20, height: 10 });
    expect(rasterSize(WEBP_VP8X, "image/webp")).toEqual({ width: 640, height: 480 });
    expect(rasterSize(JPEG, "image/jpeg")).toBeNull(); // ohne Bildkopf
  });

  it("SVG: width/height, sonst viewBox, Prozentangaben zählen nicht", () => {
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80px"></svg>')).toEqual({ width: 200, height: 80 });
    expect(svgSize("<svg viewBox='0 0 512 256'/>")).toEqual({ width: 512, height: 256 });
    expect(svgSize('<svg width="100%" height="100%" viewBox="0,0,30,10"></svg>')).toEqual({ width: 30, height: 10 });
    expect(svgSize('<svg width="60" viewBox="0 0 30 10"></svg>')).toEqual({ width: 60, height: 20 });
    expect(svgSize("<svg></svg>")).toBeNull();
    expect(svgSize("kein svg")).toBeNull();
  });
});

describe("Bild-Baustein: Upload prüfen", () => {
  it("nimmt erlaubte Typen an, entfernt Metadaten und liefert die Maße", () => {
    const r = cleanImage(pngOf(32, 16), RULES);
    expect(r.mime).toBe("image/png");
    expect(r.size).toEqual({ width: 32, height: 16 });
    expect(ascii(r.data)).not.toContain("Author");
    expect(cleanImage(WEBP_VP8L, RULES).mime).toBe("image/webp");
  });

  it("gedrehtes Handyfoto: Maße wie angezeigt (Breite und Höhe vertauscht)", () => {
    const r = cleanImage(JPEG_ROTATED, { ...RULES, types: ["image/jpeg"] });
    expect(r.size).toEqual({ width: 48, height: 64 });
    expect(jpegOrientation(r.data)).toBe(6);
  });

  it("lehnt Bilder mit zu vielen Pixeln ab (Dekompressionsbombe, Security-Review Gate 4a Hinweis 2)", () => {
    const err = (b: Uint8Array) => {
      try {
        cleanImage(b, RULES);
        return null;
      } catch (e) {
        return e instanceof ValidationError ? e.fieldErrors.logo : e;
      }
    };
    expect(err(pngOf(12_000, 3_000))).toBeNull();
    expect(err(pngOf(12_001, 10))).toMatch(/zu viele Pixel/);
    expect(err(pngOf(8_000, 8_000))).toMatch(/zu viele Pixel/);
  });

  it("lehnt leere, zu große, nicht erlaubte und kaputte Dateien mit der Meldung am Feld ab", () => {
    const err = (b: Uint8Array) => {
      try {
        cleanImage(b, RULES);
      } catch (e) {
        return e instanceof ValidationError ? e.fieldErrors : e;
      }
      return null;
    };
    expect(err(new Uint8Array())).toEqual({ logo: "leer" });
    expect(err(new Uint8Array(2048).fill(0x89))).toEqual({ logo: "zu groß" });
    expect(err(JPEG)).toEqual({ logo: "falscher Typ" });
    expect(err(bytes("<svg onload=alert(1)>"))).toEqual({ logo: "falscher Typ" });
    expect(err(PNG.subarray(0, 30))).toEqual({ logo: "Bilddatei ist beschädigt" });
  });
});
