// Kleiner DER-Kodierer (ASN.1) für CSR und PKCS#12 der Gerätezertifikate (P4-40b). Bewusst ohne Bibliothek: node-forge hat
// eine offene Sicherheitsmeldung ohne Fix (npm audit, Stand 2026-10), und mehr als diese Bausteine brauchen wir nicht.
// Geprüft wird das Ergebnis gegen OpenSSL (Node: X509Certificate, tls.createSecureContext) in pkcs12.test.ts.

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Tag-Länge-Wert */
export function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

export const seq = (...c: Buffer[]) => tlv(0x30, ...c);
/** SET OF – DER verlangt sortierte Elemente */
export const set = (...c: Buffer[]) => tlv(0x31, ...[...c].sort(Buffer.compare));
export const octets = (b: Buffer) => tlv(0x04, b);
export const nul = () => Buffer.from([0x05, 0x00]);
export const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
export const ia5 = (s: string) => tlv(0x16, Buffer.from(s, "ascii"));
/** BMPString (UTF-16BE) – friendlyName in PKCS#12 */
export const bmp = (s: string) => tlv(0x1e, Buffer.from(s, "utf16le").swap16());
/** BIT STRING ohne ungenutzte Bits */
export const bits = (b: Buffer) => tlv(0x03, Buffer.from([0]), b);
/** [n] EXPLICIT bzw. konstruiert, kontextspezifisch */
export const explicit = (n: number, ...c: Buffer[]) => tlv(0xa0 + n, ...c);
/** [n] IMPLICIT, primitiv (z. B. dNSName, encryptedContent) */
export const implicitPrimitive = (n: number, b: Buffer) => tlv(0x80 + n, b);

/** nicht-negative Ganzzahl (Zahl oder Big-Endian-Bytes), mit führender Null, wenn das höchste Bit gesetzt ist */
export function int(v: number | Buffer): Buffer {
  let b: Buffer;
  if (typeof v === "number") {
    const bytes: number[] = [];
    for (let x = v; x > 0; x = Math.floor(x / 256)) bytes.unshift(x & 0xff);
    b = Buffer.from(bytes.length ? bytes : [0]);
  } else {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    b = v.subarray(i);
  }
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime (bis 2049) bzw. GeneralizedTime – für Testzertifikate */
export function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

export const OID = {
  commonName: "2.5.4.3",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  clientAuth: "1.3.6.1.5.5.7.3.2",
  extensionRequest: "1.2.840.113549.1.9.14",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRSA: "1.2.840.113549.1.1.11",
  sha1: "1.3.14.3.2.26",
  data: "1.2.840.113549.1.7.1",
  encryptedData: "1.2.840.113549.1.7.6",
  pbeSha1TripleDes: "1.2.840.113549.1.12.1.3",
  keyBag: "1.2.840.113549.1.12.10.1.2",
  certBag: "1.2.840.113549.1.12.10.1.3",
  x509Certificate: "1.2.840.113549.1.9.22.1",
  friendlyName: "1.2.840.113549.1.9.20",
  localKeyId: "1.2.840.113549.1.9.21",
} as const;

/** Name mit genau einem CN */
export const nameCN = (cn: string) => seq(set(seq(oid(OID.commonName), utf8(cn))));

export function pem(label: string, der: Buffer): string {
  const b64 = der.toString("base64").replace(/.{1,64}/g, "$&\n");
  return `-----BEGIN ${label}-----\n${b64}-----END ${label}-----\n`;
}

/** Alle DER-Blöcke eines PEM-Texts mit diesem Label (z. B. die Kette „CERTIFICATE“) */
export function pemBlocks(text: string, label: string): Buffer[] {
  const re = new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+?)-----END ${label}-----`, "g");
  return [...text.matchAll(re)].map((m) => Buffer.from(m[1]!.replace(/\s+/g, ""), "base64"));
}
