import { describe, expect, it } from "vitest";
import { crc32, createZip, createZipAsync, readZip } from "./zip";

describe("zip", () => {
  it("CRC32 nach Standard", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("schreibt Einträge (Deflate und gespeichert, Umlaute) und liest sie zurück", () => {
    const big = new TextEncoder().encode("Schüler ".repeat(500));
    const tiny = new Uint8Array([7]);
    const zip = createZip([
      { name: "daten/übersicht.json", data: big },
      { name: "a.bin", data: tiny },
    ]);
    expect(zip.length).toBeLessThan(big.length);
    const back = readZip(zip);
    expect(new TextDecoder().decode(back.get("daten/übersicht.json"))).toBe("Schüler ".repeat(500));
    expect([...back.get("a.bin")!]).toEqual([7]);
  });

  it("asynchron (SEC-05): gleiches Archiv, Einträge auch aus einem Async-Iterator", async () => {
    const big = new TextEncoder().encode("Abgabe ".repeat(800));
    async function* entries() {
      yield { name: "a/abgabe.txt", data: big };
      yield { name: "b.bin", data: new Uint8Array([1, 2, 3]) };
    }
    const zip = await createZipAsync(entries());
    expect(zip.length).toBeLessThan(big.length);
    const back = readZip(zip);
    expect(new TextDecoder().decode(back.get("a/abgabe.txt"))).toBe("Abgabe ".repeat(800));
    expect([...back.get("b.bin")!]).toEqual([1, 2, 3]);
    await expect(createZipAsync([{ name: "../x", data: new Uint8Array() }])).rejects.toThrow();
  });

  it("lehnt doppelte und ausbrechende Namen ab", () => {
    expect(() => createZip([{ name: "../x", data: new Uint8Array() }])).toThrow();
    expect(() => createZip([{ name: "x", data: new Uint8Array() }, { name: "x", data: new Uint8Array() }])).toThrow();
  });
});
