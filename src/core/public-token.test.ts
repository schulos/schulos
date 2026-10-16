import { describe, expect, it } from "vitest";
import { isPublicPath } from "./public-paths";
import { checkStamp, hashPublicToken, isTokenShape, newPublicToken, sameHash, signStamp, withMinDuration } from "./public-token";

describe("öffentliche Token (P4-34)", () => {
  it("256 bit, base64url, jedes Mal anders; gespeichert wird nur der SHA-256", () => {
    const a = newPublicToken();
    const b = newPublicToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(hashPublicToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPublicToken(a)).not.toContain(a);
    expect(hashPublicToken(a)).toBe(hashPublicToken(a));
  });

  it("Form prüfen, bevor die DB gefragt wird", () => {
    expect(isTokenShape(newPublicToken())).toBe(true);
    for (const bad of ["", "x", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}/`, `${"a".repeat(42)}=`, null, 42, "../../etc/passwd"]) expect(isTokenShape(bad)).toBe(false);
  });

  it("Hash-Vergleich zeitkonstant und robust", () => {
    const h = hashPublicToken("x");
    expect(sameHash(h, h)).toBe(true);
    expect(sameHash(h, hashPublicToken("y"))).toBe(false);
    expect(sameHash(h, h.slice(0, 10))).toBe(false);
    expect(sameHash(null, h)).toBe(false);
    expect(sameHash("", "")).toBe(false);
  });
});

describe("signierter Formular-Zeitstempel", () => {
  const t0 = new Date("2027-02-01T10:00:00Z");
  const later = (ms: number) => new Date(t0.getTime() + ms);
  const opts = { minMs: 5_000, maxMs: 3_600_000 };

  it("gültig nach der Mindestdauer, zu früh davor, abgelaufen danach", () => {
    const s = signStamp("anmeldung:v1", t0, "geheim");
    expect(checkStamp(s, "anmeldung:v1", later(6_000), opts, "geheim")).toBe("ok");
    expect(checkStamp(s, "anmeldung:v1", later(1_000), opts, "geheim")).toBe("zu-frueh");
    expect(checkStamp(s, "anmeldung:v1", later(3_600_001), opts, "geheim")).toBe("abgelaufen");
  });

  it("anderer Zweck, anderer Schlüssel oder veränderter Zeitpunkt → ungültig", () => {
    const s = signStamp("anmeldung:v1", t0, "geheim");
    expect(checkStamp(s, "anmeldung:v2", later(6_000), opts, "geheim")).toBe("ungueltig");
    expect(checkStamp(s, "anmeldung:v1", later(6_000), opts, "anders")).toBe("ungueltig");
    const [, nonce, mac] = s.split(".");
    const forged = `${(t0.getTime() - 60_000).toString(36)}.${nonce}.${mac}`;
    expect(checkStamp(forged, "anmeldung:v1", later(6_000), opts, "geheim")).toBe("ungueltig");
    // GATE-4c: Zufallsteil ist mitsigniert – austauschen macht den Stempel ungültig; zwei Stempel derselben ms unterscheiden sich
    expect(checkStamp(`${s.split(".")[0]}.${"0".repeat(16)}.${mac}`, "anmeldung:v1", later(6_000), opts, "geheim")).toBe("ungueltig");
    expect(signStamp("anmeldung:v1", t0, "geheim")).not.toBe(s);
    expect(checkStamp(`${s}.x`, "anmeldung:v1", later(6_000), opts, "geheim")).toBe("ungueltig");
    for (const bad of [undefined, "", "abc", "x.y", "a".repeat(200)]) expect(checkStamp(bad, "anmeldung:v1", later(6_000), opts, "geheim")).toBe("ungueltig");
  });
});

describe("gleich lange Antworten", () => {
  it("wartet bis zur Mindestdauer – auch bei Fehlern", async () => {
    const start = Date.now();
    expect(await withMinDuration(120, async () => 1)).toBe(1);
    expect(Date.now() - start).toBeGreaterThanOrEqual(110);
    const s2 = Date.now();
    await expect(withMinDuration(120, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(Date.now() - s2).toBeGreaterThanOrEqual(110);
  });
});

describe("öffentliche Pfade (Proxy, S30)", () => {
  it("genau die Anmeldeseiten sind ohne Sitzung erreichbar – nicht ähnlich benannte", () => {
    for (const p of ["/anmeldung", "/anmeldung/abc", "/anmeldung/bestaetigen/t", "/anmeldung/vorgang/t", "/anmeldung/vorgang/t/termin.ics", "/impressum", "/login"])
      expect(isPublicPath(p), p).toBe(true);
    for (const p of ["/anmeldungen", "/anmeldungX/abc", "/schulanmeldung", "/verwaltung/anmeldung", "/impressum/x", "/api/anmeldung", "/dev/mail", "/"]) expect(isPublicPath(p), p).toBe(false);
  });
});
