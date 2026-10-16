// Notenbuch (P5-20): Krypto-Hilfen des Offline-Caches (WebCrypto, in Node 24 wie im Browser) – Geräteanteil nicht
// exportierbar, Cache-Schlüssel nur aus Geräte- **und** Server-Anteil, Einträge an ihr Fach gebunden, Manipulation erkannt.
import { describe, expect, it } from "vitest";
import { deriveCacheKey, fromBase64, importDeviceShare, newShare, open, randomBytes, seal, SHARE_BYTES, toBase64 } from "./offline-crypto";

describe("Notenbuch Offline: Verschlüsselung", () => {
  it("Schlüsselanteile: 32 zufällige Bytes als Base64, jedes Mal anders", () => {
    const a = newShare();
    const b = newShare();
    expect(fromBase64(a)).toHaveLength(SHARE_BYTES);
    expect(a).not.toBe(b);
    const bytes = randomBytes(7);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("Geräteanteil ist nach dem Import nicht exportierbar", async () => {
    const key = await importDeviceShare(randomBytes(SHARE_BYTES));
    expect(key.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("Cache-Schlüssel: nicht exportierbar; anderer Server-Anteil oder andere Gerätekennung → anderer Schlüssel", async () => {
    const device = await importDeviceShare(randomBytes(SHARE_BYTES));
    const share = newShare();
    const k1 = await deriveCacheKey(device, share, "geraet-1");
    expect(k1.extractable).toBe(false);
    const sealed = await seal(k1, "geraet-1:buch:queue", { ops: [1, 2] });
    expect(await open(k1, "geraet-1:buch:queue", sealed)).toEqual({ ops: [1, 2] });
    const k2 = await deriveCacheKey(device, newShare(), "geraet-1");
    await expect(open(k2, "geraet-1:buch:queue", sealed)).rejects.toThrow();
    const k3 = await deriveCacheKey(device, share, "geraet-2");
    await expect(open(k3, "geraet-1:buch:queue", sealed)).rejects.toThrow();
    // derselbe Anteil ergibt denselben Schlüssel (Cache bleibt über Seitenaufrufe lesbar)
    const k4 = await deriveCacheKey(device, share, "geraet-1");
    expect(await open(k4, "geraet-1:buch:queue", sealed)).toEqual({ ops: [1, 2] });
  });

  it("anderer Geräteanteil mit demselben Server-Anteil → Cache unlesbar (beide Anteile nötig)", async () => {
    const share = newShare();
    const k1 = await deriveCacheKey(await importDeviceShare(randomBytes(SHARE_BYTES)), share, "g");
    const k2 = await deriveCacheKey(await importDeviceShare(randomBytes(SHARE_BYTES)), share, "g");
    const sealed = await seal(k1, "g:b:queue", "geheim");
    await expect(open(k2, "g:b:queue", sealed)).rejects.toThrow();
  });

  it("Eintrag bleibt an sein Fach gebunden; manipulierte Bytes und ein ungültiger Server-Anteil werden abgelehnt", async () => {
    const device = await importDeviceShare(randomBytes(SHARE_BYTES));
    const key = await deriveCacheKey(device, newShare(), "g");
    const sealed = await seal(key, "g:buch-a:queue", { v: 1 });
    await expect(open(key, "g:buch-b:queue", sealed)).rejects.toThrow();
    const tampered = { iv: sealed.iv, data: new Uint8Array(sealed.data) };
    tampered.data[0] = tampered.data[0]! ^ 0xff;
    await expect(open(key, "g:buch-a:queue", tampered)).rejects.toThrow();
    // frischer IV je Eintrag
    const again = await seal(key, "g:buch-a:queue", { v: 1 });
    expect(toBase64(again.iv)).not.toBe(toBase64(sealed.iv));
    await expect(deriveCacheKey(device, "kurz", "g")).rejects.toThrow(/ungültig/);
  });
});
