import { describe, expect, it } from "vitest";
import {
  aad,
  atRestKey,
  generatePairingCode,
  generateRecoveryKey,
  normalizePairingCode,
  open,
  pairingKey,
  pairingLookup,
  seal,
} from "./pairing";

describe("Kopplungscode", () => {
  it("12 Zeichen Crockford-Base32 in Vierergruppen, Eingabe tolerant", () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normalizePairingCode(code.toLowerCase().replace(/-/g, " "))).toBe(code.replace(/-/g, ""));
    expect(normalizePairingCode("k7q2-9mxa-4rt1")).toBe("K7Q29MXA4RT1");
    expect(normalizePairingCode("OIL0-0000-0000")).toBe("0110" + "0".repeat(8));
    expect(normalizePairingCode("K7Q2-9MXA")).toBeNull();
    expect(normalizePairingCode("K7Q2-9MXA-4RTU")).toBeNull(); // U gibt es nicht
  });

  it("Suchschlüssel und AES-Schlüssel hängen nur vom Code ab, nicht von der Schreibweise", () => {
    expect(pairingLookup("k7q2 9mxa 4rt1")).toBe(pairingLookup("K7Q2-9MXA-4RT1"));
    expect(pairingKey("k7q2-9mxa-4rt1").equals(pairingKey("K7Q29MXA4RT1"))).toBe(true);
    expect(pairingLookup("K7Q2-9MXA-4RT1")).not.toBe(pairingLookup("K7Q2-9MXA-4RT2"));
    expect(() => pairingLookup("kaputt")).toThrow();
  });

  it("Wiederherstellungsschlüssel: 30 Zeichen in Fünfergruppen, jedes Mal neu", () => {
    const k = generateRecoveryKey();
    expect(k).toMatch(/^([0-9A-Z]{5}-){5}[0-9A-Z]{5}$/);
    expect(generateRecoveryKey()).not.toBe(k);
  });
});

describe("seal/open", () => {
  const key = pairingKey("K7Q2-9MXA-4RT1");
  const lookup = pairingLookup("K7Q2-9MXA-4RT1");

  it("Rundreise; falscher Code, falscher Zweck und veränderte Daten scheitern", () => {
    const s = seal(key, { caPem: null, serverName: "Backup" }, aad.hello(lookup));
    expect(open(key, s, aad.hello(lookup))).toEqual({ caPem: null, serverName: "Backup" });
    expect(() => open(pairingKey("K7Q2-9MXA-4RT2"), s, aad.hello(lookup))).toThrow();
    expect(() => open(key, s, aad.claim(lookup))).toThrow();
    const [v, iv, data, tag] = s.split(".");
    const flipped = Buffer.from(data!, "base64url");
    flipped[0]! ^= 1;
    expect(() => open(key, [v, iv, flipped.toString("base64url"), tag].join("."), aad.hello(lookup))).toThrow();
    expect(seal(key, 1, "x")).not.toBe(seal(key, 1, "x")); // zufälliger IV
  });

  it("Schlüssel für Geheimnisse in der DB hängt von App-Geheimnis und Zweck ab", () => {
    expect(atRestKey("a", "repo").equals(atRestKey("a", "repo"))).toBe(true);
    expect(atRestKey("a", "repo").equals(atRestKey("a", "pairing"))).toBe(false);
    expect(atRestKey("a", "repo").equals(atRestKey("b", "repo"))).toBe(false);
  });
});
