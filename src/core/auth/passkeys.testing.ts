// SEC-03, nur für Tests: ein Software-Sicherheitsschlüssel (WebAuthn-Attrappe). Erzeugt ein ES256-Schlüsselpaar und baut
// Antworten wie ein echter Schlüssel mit Attestierung „none“ – ohne Browser.
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash("sha256").update(data).digest());
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
const b64 = (data: Uint8Array | string) => isoBase64URL.fromBuffer(new Uint8Array(typeof data === "string" ? new TextEncoder().encode(data) : data));

export interface FakeAuthenticator {
  credentialId: string;
  register(options: PublicKeyCredentialCreationOptionsJSON, origin: string): RegistrationResponseJSON;
  authenticate(options: PublicKeyCredentialRequestOptionsJSON, origin: string, opts?: { counter?: number }): AuthenticationResponseJSON;
}

export function fakeAuthenticator(): FakeAuthenticator {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const credId = new Uint8Array(randomBytes(16));
  const credentialId = b64(credId);
  let counter = 0;
  // COSE-Schlüssel: kty EC2 (2), alg ES256 (-7), crv P-256 (1), x, y
  const cose = new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, isoBase64URL.toBuffer(jwk.x)],
    [-3, isoBase64URL.toBuffer(jwk.y)],
  ]);

  function authData(rpId: string, flags: number, count: number, attested: boolean): Uint8Array {
    const c = new Uint8Array(4);
    new DataView(c.buffer).setUint32(0, count);
    const base = concat(sha256(rpId), new Uint8Array([flags]), c);
    if (!attested) return base;
    const len = new Uint8Array(2);
    new DataView(len.buffer).setUint16(0, credId.length);
    return concat(base, new Uint8Array(16), len, credId, isoCBOR.encode(cose));
  }

  return {
    credentialId,
    register(options, origin) {
      const clientData = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false });
      // Flags: UP (0x01) + AT (0x40)
      const attestation = new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData(options.rp.id ?? "localhost", 0x41, counter, true)],
      ]);
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: b64(clientData),
          attestationObject: b64(isoCBOR.encode(attestation as Parameters<typeof isoCBOR.encode>[0])),
          transports: ["usb"],
        },
        clientExtensionResults: {},
      };
    },
    authenticate(options, origin, opts) {
      counter = opts?.counter ?? counter + 1;
      const data = authData(options.rpId ?? "localhost", 0x01, counter, false);
      const clientData = JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false });
      const signature = createSign("sha256")
        .update(concat(data, sha256(clientData)))
        .sign(privateKey);
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: { clientDataJSON: b64(clientData), authenticatorData: b64(data), signature: b64(new Uint8Array(signature)) },
        clientExtensionResults: {},
      };
    },
  };
}
