// Nur für Tests (P4-40b): Test-CA, Zertifikate und eine nachgebaute step-ca (Provisioner-Liste + /1.0/sign), damit Ausstellung,
// PKCS#12 und TLS-Client-Authentifizierung ohne Docker geprüft werden können. Die echte step-ca prüft der CI-Job `stack`.
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify, X509Certificate, type KeyObject } from "node:crypto";
import { calculateJwkThumbprint, CompactEncrypt, exportJWK, generateKeyPair, jwtVerify, type JWK } from "jose";
import { bits, explicit, implicitPrimitive, int, nameCN, nul, octets, oid, OID, pem, pemBlocks, seq, time, tlv } from "./der";
import type { Transport } from "./step-ca";

// ---------------------------------------------------------------- DER lesen (nur so viel wie nötig)

export interface Tlv {
  tag: number;
  /** ganzer Block inkl. Kopf */
  raw: Buffer;
  value: Buffer;
}

export function readTlv(buf: Buffer, at = 0): Tlv & { end: number } {
  const tag = buf[at]!;
  let len = buf[at + 1]!;
  let head = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i]!;
    head = 2 + n;
  }
  const end = at + head + len;
  return { tag, raw: buf.subarray(at, end), value: buf.subarray(at + head, end), end };
}

export function children(value: Buffer): Tlv[] {
  const out: Tlv[] = [];
  for (let at = 0; at < value.length; ) {
    const t = readTlv(value, at);
    out.push(t);
    at = t.end;
  }
  return out;
}

/** CSR lesen und Signatur prüfen: öffentlicher Schlüssel, CN, dNSNames */
export function parseCsr(csrPem: string): { publicKey: KeyObject; commonName: string; dnsNames: string[]; signatureOk: boolean } {
  const der = pemBlocks(csrPem, "CERTIFICATE REQUEST")[0]!;
  const [info, , sig] = children(readTlv(der).value);
  const [, subject, spki, attrs] = children(info!.value);
  const publicKey = createPublicKey({ key: spki!.raw, format: "der", type: "spki" });
  const cnAttr = children(children(children(subject!.value)[0]!.value)[0]!.value);
  const commonName = cnAttr[1]!.value.toString("utf8");
  const dnsNames: string[] = [];
  for (const attr of attrs ? children(attrs.value) : []) {
    const [, values] = children(attr.value);
    for (const ext of children(children(values!.value)[0]!.value)) {
      const [, extValue] = children(ext.value).filter((c) => c.tag !== 0x01);
      for (const name of children(readTlv(extValue!.value).value)) if (name.tag === 0x82) dnsNames.push(name.value.toString("ascii"));
    }
  }
  const signatureOk = verify("sha256", info!.raw, publicKey, sig!.value.subarray(1));
  return { publicKey, commonName, dnsNames, signatureOk };
}

// ---------------------------------------------------------------- Zertifikate bauen

const boolTrue = () => tlv(0x01, Buffer.from([0xff]));
const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [boolTrue()] : []), octets(value));

export interface TestCert {
  der: Buffer;
  pem: string;
  key: KeyObject;
  x509: X509Certificate;
}

/** X.509 v3, SHA-256/RSA. Ohne `issuer` selbstsigniert (CA). */
export function makeCert(opts: {
  cn: string;
  issuer?: TestCert;
  publicKey?: KeyObject;
  privateKey?: KeyObject;
  ca?: boolean;
  notBefore?: Date;
  notAfter?: Date;
  dnsNames?: string[];
}): TestCert {
  const own = opts.publicKey ? { publicKey: opts.publicKey, privateKey: opts.privateKey! } : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signer = opts.issuer?.key ?? own.privateKey;
  const issuerName = opts.issuer ? readIssuerSubject(opts.issuer.der) : nameCN(opts.cn);
  const now = Date.now();
  const extensions = [
    ext(OID.basicConstraints, true, opts.ca ? seq(boolTrue()) : seq()),
    // keyUsage: CA → keyCertSign|cRLSign, Gerät → digitalSignature|keyEncipherment
    ext(OID.keyUsage, true, opts.ca ? tlv(0x03, Buffer.from([1, 0x06])) : tlv(0x03, Buffer.from([5, 0xa0]))),
    ...(opts.ca ? [] : [ext(OID.extKeyUsage, false, seq(oid(OID.clientAuth), oid("1.3.6.1.5.5.7.3.1")))]),
    ...(opts.dnsNames?.length ? [ext(OID.subjectAltName, false, seq(...opts.dnsNames.map((d) => implicitPrimitive(2, Buffer.from(d, "ascii")))))] : []),
  ];
  const algorithm = seq(oid(OID.sha256WithRSA), nul());
  const tbs = seq(
    explicit(0, int(2)),
    int(Buffer.concat([Buffer.from([0x40]), randomBytes(15)])),
    algorithm,
    issuerName,
    seq(time(opts.notBefore ?? new Date(now - 3_600_000)), time(opts.notAfter ?? new Date(now + 30 * 86_400_000))),
    nameCN(opts.cn),
    own.publicKey.export({ type: "spki", format: "der" }),
    explicit(3, seq(...extensions)),
  );
  const der = seq(tbs, algorithm, bits(sign("sha256", tbs, signer)));
  return { der, pem: pem("CERTIFICATE", der), key: own.privateKey, x509: new X509Certificate(der) };
}

function readIssuerSubject(certDer: Buffer): Buffer {
  const tbs = children(readTlv(certDer).value)[0]!;
  // version [0], serial, algorithm, issuer, validity, subject
  return children(tbs.value)[5]!.raw;
}

// ---------------------------------------------------------------- nachgebaute step-ca

export interface FakeStepCa {
  transport: Transport;
  root: TestCert;
  intermediate: TestCert;
  password: string;
  provisioner: string;
  /** zuletzt signierte CSRs (für Prüfungen im Test) */
  signed: { commonName: string; notAfter: string }[];
  /** nächste Antwort von /1.0/sign verfälschen */
  tamper?: "fremder-schluessel" | "anderer-name" | "fehler";
}

export async function fakeStepCa(opts: { password?: string; provisioner?: string; url?: string } = {}): Promise<FakeStepCa> {
  const password = opts.password ?? "provisioner-passwort";
  const provisioner = opts.provisioner ?? "schulos";
  const url = opts.url ?? "https://step-ca:9000";
  const root = makeCert({ cn: "Test Root CA", ca: true });
  const intermediate = makeCert({ cn: "Test Intermediate CA", ca: true, issuer: root });
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const priv = { ...(await exportJWK(privateKey)), alg: "ES256" } as JWK;
  const kid = await calculateJwkThumbprint(priv);
  const encryptedKey = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({ ...priv, kid })))
    .setProtectedHeader({ alg: "PBES2-HS256+A128KW", enc: "A256GCM", cty: "jwk+json" })
    .setKeyManagementParameters({ p2c: 100_000 })
    .encrypt(new TextEncoder().encode(password));
  const pub = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };

  const ca: FakeStepCa = { transport: async () => ({ status: 500, json: null }), root, intermediate, password, provisioner, signed: [] };
  ca.transport = async (u, init) => {
    const p = new URL(u);
    if (init.method === "GET" && p.pathname === "/health") return { status: 200, json: { status: "ok" } };
    if (init.method === "GET" && p.pathname === "/provisioners")
      return { status: 200, json: { provisioners: [{ type: "ACME", name: "acme" }, { type: "JWK", name: provisioner, key: pub, encryptedKey }], nextCursor: "" } };
    if (init.method === "POST" && p.pathname === "/1.0/sign") {
      const body = init.body as { csr: string; ott: string; notAfter: string };
      let claims;
      try {
        ({ payload: claims } = await jwtVerify(body.ott, publicKey, { issuer: provisioner, audience: `${url}/1.0/sign` }));
      } catch (e) {
        return { status: 401, json: { message: `ott: ${(e as Error).message}` } };
      }
      const csr = parseCsr(body.csr);
      if (!csr.signatureOk) return { status: 400, json: { message: "CSR-Signatur" } };
      if (claims.sub !== csr.commonName || JSON.stringify(claims.sans) !== JSON.stringify(csr.dnsNames)) return { status: 403, json: { message: "Name passt nicht zum Token" } };
      if (ca.tamper === "fehler") return { status: 500, json: { message: "kaputt" } };
      ca.signed.push({ commonName: csr.commonName, notAfter: body.notAfter });
      const leaf =
        ca.tamper === "fremder-schluessel"
          ? makeCert({ cn: csr.commonName, issuer: intermediate })
          : makeCert({ cn: ca.tamper === "anderer-name" ? "geraet-fremd" : csr.commonName, issuer: intermediate, publicKey: csr.publicKey, privateKey: undefined, notAfter: new Date(body.notAfter), dnsNames: csr.dnsNames });
      return { status: 201, json: { crt: leaf.pem, ca: intermediate.pem, certChain: [leaf.pem, intermediate.pem] } };
    }
    return { status: 404, json: { message: "nicht gefunden" } };
  };
  return ca;
}

