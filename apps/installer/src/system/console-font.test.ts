import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildConsoleFonts, fontName, parseFbSize, parsePsf2, patchConsoleFont, pickConsoleFont, serializePsf2, TERMINUS_SIZES, type Psf2 } from "./console-font";

/** kleine Schrift: A, ░ (Schachbrett), ▶, sechs serbische Buchstaben (Plätze für ▀▄▌▐▓), Ж (russisch – bleibt) */
function sample(width = 8, height = 16): Psf2 {
  const row = Math.ceil(width / 8);
  const cps = [[0x41], [0x2591], [0x25b6], [0x0402], [0x0409], [0x040a], [0x040b], [0x040f], [0x0452], [0x0416]];
  const glyphs = cps.map((_c, i) => {
    const g = Buffer.alloc(row * height);
    if (i === 1) for (let y = 0; y < height; y++) g[y * row] = y % 2 ? 0x55 : 0xaa;
    return g;
  });
  return { width, height, glyphs, table: cps.map((codepoints) => ({ codepoints, sequences: Buffer.alloc(0) })) };
}

const pixels = (f: Psf2, cp: number) => {
  const g = f.glyphs[f.table.findIndex((t) => t.codepoints.includes(cp))]!;
  const row = Math.ceil(f.width / 8);
  return Array.from({ length: f.height }, (_, y) => Array.from({ length: f.width }, (_, x) => (g[y * row + (x >> 3)]! & (0x80 >> (x & 7)) ? "#" : ".")).join(""));
};

describe("Konsolenschrift", () => {
  it("ergänzt ▀ ▄ ▌ ▐ ▓ auf Plätzen seltener kyrillischer Buchstaben, ► und ◄ als zweite Namen", () => {
    const f = patchConsoleFont(sample());
    const top = pixels(f, 0x2580);
    expect(top.slice(0, 8).every((r) => r === "########")).toBe(true);
    expect(top.slice(8).every((r) => r === "........")).toBe(true);
    expect(pixels(f, 0x2584)[15]).toBe("########");
    expect(pixels(f, 0x2584)[0]).toBe("........");
    expect(pixels(f, 0x258c)[3]).toBe("####....");
    expect(pixels(f, 0x2590)[3]).toBe("....####");
    // ▓ = umgekehrtes ░
    expect(pixels(f, 0x2593)[0]).toBe(".#.#.#.#");
    expect(f.table.find((t) => t.codepoints.includes(0x25b6))!.codepoints).toContain(0x25ba);
    // A und Ж bleiben, fünf der sechs Spender sind verbraucht
    const all = f.table.flatMap((t) => t.codepoints);
    expect(all).toContain(0x41);
    expect(all).toContain(0x0416);
    expect(all.filter((c) => c >= 0x0400 && c <= 0x045f && c !== 0x0416)).toHaveLength(1);
    expect(f.glyphs).toHaveLength(10);
  });

  it("breite Schriften (12×24): Halbblöcke über die ganze Breite", () => {
    const f = patchConsoleFont(sample(12, 24));
    expect(pixels(f, 0x2580)[11]).toBe("############");
    expect(pixels(f, 0x2580)[12]).toBe("............");
    expect(pixels(f, 0x2590)[0]).toBe("......######");
  });

  it("schreibt PSF2 und liest es wieder (auch PSF1 mit Folgen)", () => {
    const f = patchConsoleFont(sample());
    const again = parsePsf2(serializePsf2(f));
    expect(again.table.map((t) => t.codepoints)).toEqual(f.table.map((t) => t.codepoints));
    expect(again.glyphs).toEqual(f.glyphs);
    // PSF1: 256 Glyphen à 16 Byte, Tabelle UCS-2 mit 0xFFFE-Folge und 0xFFFF-Ende
    const psf1 = [Buffer.from([0x36, 0x04, 0x02, 16]), Buffer.alloc(256 * 16, 0x11)];
    const table: number[] = [];
    for (let i = 0; i < 256; i++) table.push(...(i === 65 ? [0x41, 0x0410, 0xfffe, 0x41, 0x30a, 0xffff] : [i === 0 ? 0x20 : 0xe000 + i, 0xffff]));
    const buf = Buffer.concat([...psf1, Buffer.from(new Uint16Array(table).buffer)]);
    const p = parsePsf2(buf);
    expect(p.width).toBe(8);
    expect(p.table[65]!.codepoints).toEqual([0x41, 0x0410]);
    expect(p.table[65]!.sequences).toEqual(Buffer.concat([Buffer.from([0xfe]), Buffer.from("Å", "utf8")]));
    expect(parsePsf2(serializePsf2(p)).table[65]).toEqual(p.table[65]);
  });

  it("ohne freie Plätze: Fehler statt kaputter Schrift", () => {
    const f = sample();
    f.table = f.table.map((t, i) => (i >= 3 ? { ...t, codepoints: [0x41 + i] } : t));
    expect(() => patchConsoleFont(f)).toThrow(/kein freier Platz/);
  });

  it("ISO-Bau: alle Größen als schulos-<B>x<H>.psf", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "konsolenschrift-"));
    try {
      for (const s of TERMINUS_SIZES) writeFileSync(path.join(dir, s.file), gzipSync(serializePsf2(sample(s.width, s.height))));
      const out = buildConsoleFonts(dir, path.join(dir, "aus"));
      expect(out.map((o) => path.basename(o))).toEqual(TERMINUS_SIZES.map((s) => fontName(s.width, s.height)));
      const f = parsePsf2(readFileSync(out[3]!));
      expect([f.width, f.height]).toEqual([12, 24]);
      expect(f.table.some((t) => t.codepoints.includes(0x2580))).toBe(true);
      rmSync(path.join(dir, TERMINUS_SIZES[0]!.file));
      expect(() => buildConsoleFonts(dir, path.join(dir, "aus"))).toThrow(/fehlt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Größe je Bildschirm: mindestens 100×30, sonst 80×25", () => {
    expect(pickConsoleFont({ width: 1920, height: 1080 })).toEqual({ width: 16, height: 32 }); // 120×33
    expect(pickConsoleFont({ width: 1280, height: 800 })).toEqual({ width: 12, height: 24 }); // 106×33
    expect(pickConsoleFont({ width: 1024, height: 768 })).toEqual({ width: 10, height: 20 }); // 102×38
    expect(pickConsoleFont({ width: 800, height: 600 })).toEqual({ width: 8, height: 16 }); // 100×37
    expect(pickConsoleFont({ width: 640, height: 400 })).toEqual({ width: 8, height: 16 }); // 80×25
    expect(pickConsoleFont({ width: 320, height: 200 })).toEqual({ width: 8, height: 16 });
    expect(pickConsoleFont(null)).toBeNull();
    expect(parseFbSize("1280,800\n")).toEqual({ width: 1280, height: 800 });
    expect(parseFbSize("")).toBeNull();
  });
});
