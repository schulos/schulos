// Schlüssel, CSR und Export der Gerätezertifikate (P4-40b): PKCS#12 (.p12) für Windows/Android/Intune/Relution und ein
// Apple-Konfigurationsprofil (.mobileconfig) für iPad/Mac bzw. den Upload ins MDM. Der private Schlüssel entsteht hier,
// wandert nur verschlüsselt in die Datei und wird nirgends gespeichert.
//
// PKCS#12 bewusst im verbreitetsten Format (RFC 7292, „legacy“ wie OpenSSL -legacy): Schlüssel und Zertifikate mit
// pbeWithSHAAnd3-KeyTripleDES-CBC, MAC mit HMAC-SHA1, 2048 Runden – das lesen alle MDM-Systeme und Apple-Geräte
// (AES/PBES2-Dateien scheitern auf älteren iOS/macOS-Versionen). Der Schutz liegt im langen Zufallspasswort.
import { createCipheriv, createHash, createHmac, generateKeyPair, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { promisify } from "node:util";
import { bits, bmp, explicit, implicitPrimitive, int, nameCN, nul, octets, oid, OID, pem, seq, set } from "./der";

const generateKeyPairAsync = promisify(generateKeyPair);

/** RSA 2048 – von allen Zielsystemen (Apple, Windows, Android, MDM) als Client-Identität unterstützt */
export async function newDeviceKey(): Promise<{ privateKey: KeyObject; publicKey: KeyObject }> {
  return generateKeyPairAsync("rsa", { modulusLength: 2048 });
}

/** CSR (PKCS#10) mit CN und gleichlautendem dNSName (so verlangt es der JWK-Provisioner von step-ca), SHA-256/RSA signiert */
export function createCsr(key: { privateKey: KeyObject; publicKey: KeyObject }, commonName: string): string {
  const spki = key.publicKey.export({ type: "spki", format: "der" });
  const san = seq(oid(OID.subjectAltName), octets(seq(implicitPrimitive(2, Buffer.from(commonName, "ascii")))));
  const attributes = explicit(0, seq(oid(OID.extensionRequest), set(seq(san))));
  const info = seq(int(0), nameCN(commonName), spki, attributes);
  const signature = sign("sha256", info, key.privateKey);
  return pem("CERTIFICATE REQUEST", seq(info, seq(oid(OID.sha256WithRSA), nul()), bits(signature)));
}

/** Passwort für die Datei: 20 Zeichen ohne verwechselbare Zeichen (≈ 100 bit), in Vierergruppen zum Abtippen */
export function exportPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(20);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12, 16].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

// ---------------------------------------------------------------- PKCS#12 (RFC 7292)

const ITERATIONS = 2048;

/** Passwort als BMPString mit abschließendem Null-Zeichen (RFC 7292 B.1) */
function bmpPassword(password: string): Buffer {
  return Buffer.concat([Buffer.from(password, "utf16le").swap16(), Buffer.from([0, 0])]);
}

/** Schlüsselableitung nach RFC 7292 Anhang B.2 mit SHA-1 (u = 20, v = 64); id 1 = Schlüssel, 2 = IV, 3 = MAC */
export function pkcs12Kdf(password: Buffer, salt: Buffer, id: 1 | 2 | 3, iterations: number, size: number): Buffer {
  const u = 20;
  const v = 64;
  const fill = (b: Buffer) => {
    if (b.length === 0) return Buffer.alloc(0);
    const out = Buffer.alloc(v * Math.ceil(b.length / v));
    for (let i = 0; i < out.length; i++) out[i] = b[i % b.length]!;
    return out;
  };
  const D = Buffer.alloc(v, id);
  const I = Buffer.concat([fill(salt), fill(password)]);
  const blocks: Buffer[] = [];
  for (let n = 0; n < Math.ceil(size / u); n++) {
    let A = createHash("sha1").update(D).update(I).digest();
    for (let r = 1; r < iterations; r++) A = createHash("sha1").update(A).digest();
    blocks.push(A);
    const B = fill(A);
    // I_j = (I_j + B + 1) mod 2^(v·8) für jeden v-Block
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = I[j + k]! + B[k]! + carry;
        I[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return Buffer.concat(blocks).subarray(0, size);
}

function pbeEncrypt(password: Buffer, data: Buffer): { algorithm: Buffer; encrypted: Buffer } {
  const salt = randomBytes(8);
  const key = pkcs12Kdf(password, salt, 1, ITERATIONS, 24);
  const iv = pkcs12Kdf(password, salt, 2, ITERATIONS, 8);
  const cipher = createCipheriv("des-ede3-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return { algorithm: seq(oid(OID.pbeSha1TripleDes), seq(octets(salt), int(ITERATIONS))), encrypted };
}

const contentInfoData = (content: Buffer) => seq(oid(OID.data), explicit(0, octets(content)));

/**
 * PKCS#12 mit Schlüssel, Gerätezertifikat und Kette (Zwischenzertifikat). `localKeyId` verbindet Schlüssel und Zertifikat,
 * `friendlyName` erscheint auf dem Gerät.
 */
export function createPkcs12(input: { privateKey: KeyObject; certDer: Buffer; chainDer: Buffer[]; password: string; friendlyName: string }): Buffer {
  const pw = bmpPassword(input.password);
  const localKeyId = createHash("sha1").update(input.certDer).digest();
  const attrs = set(seq(oid(OID.friendlyName), set(bmp(input.friendlyName))), seq(oid(OID.localKeyId), set(octets(localKeyId))));

  const certBag = (der: Buffer, withAttrs: boolean) =>
    seq(oid(OID.certBag), explicit(0, seq(oid(OID.x509Certificate), explicit(0, octets(der)))), ...(withAttrs ? [attrs] : []));
  const certs = pbeEncrypt(pw, seq(certBag(input.certDer, true), ...input.chainDer.map((c) => certBag(c, false))));
  const encryptedCerts = seq(oid(OID.encryptedData), explicit(0, seq(int(0), seq(oid(OID.data), certs.algorithm, implicitPrimitive(0, certs.encrypted)))));

  const pkcs8 = input.privateKey.export({ type: "pkcs8", format: "der" });
  const key = pbeEncrypt(pw, pkcs8);
  const keyBag = seq(oid(OID.keyBag), explicit(0, seq(key.algorithm, octets(key.encrypted))), attrs);

  const authSafe = seq(encryptedCerts, contentInfoData(seq(keyBag)));
  const macSalt = randomBytes(8);
  const macKey = pkcs12Kdf(pw, macSalt, 3, ITERATIONS, 20);
  const mac = createHmac("sha1", macKey).update(authSafe).digest();
  const macData = seq(seq(seq(oid(OID.sha1), nul()), octets(mac)), octets(macSalt), int(ITERATIONS));
  return seq(int(3), contentInfoData(authSafe), macData);
}

// ---------------------------------------------------------------- Apple-Konfigurationsprofil

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Unsigniertes Konfigurationsprofil mit der Identität (PKCS#12-Nutzlast). Mit Passwort, damit ein MDM es ohne Nachfrage
 * installieren kann – die Datei ist deshalb so geheim wie .p12 + Passwort zusammen.
 */
export function createMobileconfig(input: { p12: Buffer; password: string; commonName: string; label: string; organization: string }): Buffer {
  const id = `schulos.geraet.${input.commonName}`;
  const b64 = input.p12.toString("base64").replace(/.{1,68}/g, "$&\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>Password</key>
      <string>${xml(input.password)}</string>
      <key>PayloadCertificateFileName</key>
      <string>${xml(input.commonName)}.p12</string>
      <key>PayloadContent</key>
      <data>
${b64}</data>
      <key>PayloadDescription</key>
      <string>Gerätezertifikat für den Zugang zu SchulOS von außerhalb des Schulnetzes</string>
      <key>PayloadDisplayName</key>
      <string>${xml(input.commonName)}</string>
      <key>PayloadIdentifier</key>
      <string>${xml(id)}.pkcs12</string>
      <key>PayloadType</key>
      <string>com.apple.security.pkcs12</string>
      <key>PayloadUUID</key>
      <string>${randomUUID().toUpperCase()}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Gerätezertifikat der Schule für SchulOS (${xml(input.label)})</string>
  <key>PayloadDisplayName</key>
  <string>SchulOS-Gerätezertifikat – ${xml(input.label)}</string>
  <key>PayloadIdentifier</key>
  <string>${xml(id)}</string>
  <key>PayloadOrganization</key>
  <string>${xml(input.organization)}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${randomUUID().toUpperCase()}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
  return Buffer.from(body, "utf8");
}

