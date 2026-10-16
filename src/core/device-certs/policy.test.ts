import { describe, expect, it } from "vitest";
import type { ExternalZone } from "@/core/external-access";
import { ROLES } from "@/core/roles";
import { decideExternalAccess, effectivePolicy, type CertCheck, type ExternalPolicy } from "./policy";

// P4-40b / SICHERHEIT.md S27/S28: jede Kombination aus Zone, Rolle, Zertifikat und Schuleinstellung

const ZONES: ExternalZone[] = ["intern", "oeffentlich", "alles", "geraet"];
const CERTS: CertCheck[] = ["gebunden", "gueltig", "fehlt", "ungueltig"];
const POLICIES: ExternalPolicy[] = [
  { staffCertRequired: true, adminAllowed: false },
  { staffCertRequired: true, adminAllowed: true },
  { staffCertRequired: false, adminAllowed: false },
  { staffCertRequired: false, adminAllowed: true },
];

/** Erwartung, unabhängig von der Implementierung aufgeschrieben */
function expected(zone: ExternalZone, role: string, cert: CertCheck, p: ExternalPolicy): boolean {
  if (zone === "intern") return true;
  if (zone === "oeffentlich") return false;
  if (!["schueler", "eltern", "lehrkraft", "personal", "beratung", "verwaltung", "admin"].includes(role)) return false;
  const valid = cert === "gueltig" || cert === "gebunden";
  if (zone === "geraet" && !valid) return false;
  if ((role === "verwaltung" || role === "admin") && !p.adminAllowed) return false;
  if (["lehrkraft", "personal", "beratung", "verwaltung", "admin"].includes(role) && p.staffCertRequired && !valid) return false;
  // GATE-4c: Verwaltung/Admin über ein Zertifikat nur mit Bindung an das Konto
  if ((role === "verwaltung" || role === "admin") && (zone === "geraet" || p.staffCertRequired) && cert !== "gebunden") return false;
  return true;
}

describe("decideExternalAccess – vollständige Tabelle", () => {
  it("stimmt für alle Zonen × Rollen × Zertifikate × Einstellungen (inkl. unbekannter Rolle)", () => {
    let n = 0;
    for (const zone of ZONES)
      for (const role of [...ROLES, "", "superadmin"])
        for (const cert of CERTS)
          for (const policy of POLICIES) {
            const d = decideExternalAccess({ zone, role, cert, policy });
            expect(d.allowed, JSON.stringify({ zone, role, cert, policy })).toBe(expected(zone, role, cert, policy));
            n++;
          }
    expect(n).toBe(4 * 9 * 4 * 4);
  });

  const strict = { staffCertRequired: true, adminAllowed: false };

  it("Schulnetz: alles erlaubt, auch ohne Zertifikat", () => {
    for (const role of ROLES) expect(decideExternalAccess({ zone: "intern", role, cert: "fehlt", policy: strict })).toEqual({ allowed: true });
  });

  it("nur öffentliche Seiten: keine Sitzung von außen, auch nicht mit gültigem Zertifikat", () => {
    expect(decideExternalAccess({ zone: "oeffentlich", role: "eltern", cert: "gueltig", policy: strict })).toEqual({ allowed: false, reason: "kein-zugang" });
  });

  it("Lehrkraft/Personal von außen nur mit gültigem Zertifikat; Grund „zertifikat“", () => {
    for (const role of ["lehrkraft", "personal", "beratung"]) {
      expect(decideExternalAccess({ zone: "alles", role, cert: "gueltig", policy: strict }).allowed).toBe(true);
      expect(decideExternalAccess({ zone: "alles", role, cert: "fehlt", policy: strict })).toEqual({ allowed: false, reason: "zertifikat" });
      expect(decideExternalAccess({ zone: "geraet", role, cert: "ungueltig", policy: strict })).toEqual({ allowed: false, reason: "zertifikat" });
    }
  });

  it("Verwaltung/Admin von außen per Vorgabe gesperrt – auch mit gültigem Zertifikat; erlaubt, dann mit Zertifikatspflicht", () => {
    for (const role of ["verwaltung", "admin"]) {
      expect(decideExternalAccess({ zone: "geraet", role, cert: "gueltig", policy: strict })).toEqual({ allowed: false, reason: "rolle" });
      expect(decideExternalAccess({ zone: "geraet", role, cert: "gebunden", policy: { ...strict, adminAllowed: true } }).allowed).toBe(true);
      // GATE-4c: ungebundenes Zertifikat reicht für Verwaltung/Admin nicht
      expect(decideExternalAccess({ zone: "geraet", role, cert: "gueltig", policy: { ...strict, adminAllowed: true } })).toEqual({ allowed: false, reason: "zertifikat" });
      expect(decideExternalAccess({ zone: "alles", role, cert: "gueltig", policy: { ...strict, adminAllowed: true } }).allowed).toBe(false);
      // ohne Zertifikatspflicht im Modus „alles“ entscheidet allein die Freigabe (Zertifikat öffnet dort nichts)
      expect(decideExternalAccess({ zone: "alles", role, cert: "gueltig", policy: { staffCertRequired: false, adminAllowed: true } }).allowed).toBe(true);
      expect(decideExternalAccess({ zone: "alles", role, cert: "fehlt", policy: { ...strict, adminAllowed: true } }).allowed).toBe(false);
    }
  });

  it("Eltern/Schüler:innen: im Modus „alles“ ohne Zertifikat wie bisher; mit Gerät-Durchlass nur mit gültigem Zertifikat", () => {
    for (const role of ["eltern", "schueler"]) {
      expect(decideExternalAccess({ zone: "alles", role, cert: "fehlt", policy: strict }).allowed).toBe(true);
      expect(decideExternalAccess({ zone: "alles", role, cert: "ungueltig", policy: strict }).allowed).toBe(true);
      expect(decideExternalAccess({ zone: "geraet", role, cert: "ungueltig", policy: strict }).allowed).toBe(false);
    }
  });
});

describe("effectivePolicy – Vorgaben", () => {
  it("Zertifikatspflicht folgt der CA, solange nichts eingestellt ist; Verwaltung/Admin gesperrt", () => {
    expect(effectivePolicy({ staffCert: null, adminAllowed: null }, true)).toEqual({ staffCertRequired: true, adminAllowed: false });
    expect(effectivePolicy({ staffCert: null, adminAllowed: null }, false)).toEqual({ staffCertRequired: false, adminAllowed: false });
  });

  it("ausdrückliche Einstellung gewinnt", () => {
    expect(effectivePolicy({ staffCert: "aus", adminAllowed: true }, true)).toEqual({ staffCertRequired: false, adminAllowed: true });
    expect(effectivePolicy({ staffCert: "an", adminAllowed: false }, false)).toEqual({ staffCertRequired: true, adminAllowed: false });
  });
});
