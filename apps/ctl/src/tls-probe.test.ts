// CA-08: Bewertung des ausgelieferten Zertifikats (Messung am echten Handshake: status-json.test.ts)
import { describe, expect, it } from "vitest";
import { acmeFromEnv, evaluatePeer, isStagingIssuer } from "./tls-probe";

const cert = (name: string, issuer: Record<string, string> = { O: "Let's Encrypt", CN: "R12" }) => ({
  valid_from: "Nov  2 10:00:00 2026 GMT",
  valid_to: "Jan 31 10:00:00 2027 GMT",
  issuer: issuer as never,
  subject: { CN: name } as never,
  subjectaltname: `DNS:${name}`,
});

describe("CA-08: öffentliches Zertifikat bewerten", () => {
  it("ACME-Modus aus SCHULOS_TLS", () => {
    expect(acmeFromEnv({ SCHULOS_TLS: "it@schule.de" })).toBe(true);
    expect(acmeFromEnv({ SCHULOS_TLS: "internal" })).toBe(false);
    expect(acmeFromEnv({})).toBe(false);
  });

  it("öffentlich gültig nur mit gültiger Kette und passendem Namen", () => {
    expect(evaluatePeer(cert("schulos.schule.de"), true, null, "schulos.schule.de")).toEqual({
      expiresAt: "2027-01-31T10:00:00.000Z",
      issuedAt: "2026-11-02T10:00:00.000Z",
      issuer: "Let's Encrypt R12",
      trusted: true,
      nameOk: true,
      problem: null,
    });
    expect(evaluatePeer(cert("anders.schule.de"), true, null, "schulos.schule.de")).toMatchObject({ trusted: false, nameOk: false, problem: "Name passt nicht zu schulos.schule.de" });
    expect(evaluatePeer(cert("schulos.schule.de"), false, "SELF_SIGNED_CERT_IN_CHAIN", "schulos.schule.de")).toMatchObject({ trusted: false, nameOk: true, problem: "SELF_SIGNED_CERT_IN_CHAIN" });
    expect(evaluatePeer({ ...cert("x"), valid_to: "" }, true, null, "x")).toBeNull();
  });

  it("Staging-Aussteller erkannt", () => {
    expect(isStagingIssuer("(STAGING) Let's Encrypt (STAGING) Counterfeit Cashew R10")).toBe(true);
    expect(isStagingIssuer("Let's Encrypt R12")).toBe(false);
  });
});
