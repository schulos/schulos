import { createSecureContext, connect, createServer, type TLSSocket } from "node:tls";
import { describe, expect, it } from "vitest";
import { pemBlocks } from "./der";
import { createCsr, createMobileconfig, createPkcs12, exportPassword, newDeviceKey, pkcs12Kdf } from "./pkcs12";
import { makeCert, parseCsr } from "./testing";

// P4-40b: CSR, PKCS#12 und Konfigurationsprofil – geprüft gegen OpenSSL (über Node), inkl. echter TLS-Client-Authentifizierung

describe("CSR", () => {
  it("trägt CN und gleichlautenden dNSName, Signatur stimmt", async () => {
    const key = await newDeviceKey();
    const csr = parseCsr(createCsr(key, "geraet-0a1b2c3d4e5f"));
    expect(csr.commonName).toBe("geraet-0a1b2c3d4e5f");
    expect(csr.dnsNames).toEqual(["geraet-0a1b2c3d4e5f"]);
    expect(csr.signatureOk).toBe(true);
    expect(csr.publicKey.export({ type: "spki", format: "der" })).toEqual(key.publicKey.export({ type: "spki", format: "der" }));
  });
});

describe("PKCS#12-Schlüsselableitung (RFC 7292 B.2)", () => {
  it("liefert die bekannten Werte (Testvektor wie OpenSSL/BouncyCastle: smeg, 3DES-Schlüssel)", () => {
    // Testvektor aus der BouncyCastle-Testsuite (PKCS12Test): Passwort „smeg“, Salz 0A58CF64530D823F, 1 Runde
    const pw = Buffer.concat([Buffer.from("smeg", "utf16le").swap16(), Buffer.from([0, 0])]);
    const key = pkcs12Kdf(pw, Buffer.from("0A58CF64530D823F", "hex"), 1, 1, 24);
    expect(key.toString("hex").toUpperCase()).toBe("8AAAE6297B6CB04642AB5B077851284EB7128F1A2A7FBCA3");
    const iv = pkcs12Kdf(pw, Buffer.from("0A58CF64530D823F", "hex"), 2, 1, 8);
    expect(iv.toString("hex").toUpperCase()).toBe("79993DFE048D3B76");
  });
});

describe("PKCS#12 und TLS-Client-Authentifizierung", () => {
  const root = makeCert({ cn: "Test Root CA", ca: true });
  const intermediate = makeCert({ cn: "Test Intermediate CA", ca: true, issuer: root });
  const server = makeCert({ cn: "localhost", issuer: root, dnsNames: ["localhost"] });

  async function deviceIdentity(issuer = intermediate) {
    const key = await newDeviceKey();
    const leaf = makeCert({ cn: "geraet-abc", issuer, publicKey: key.publicKey, privateKey: key.privateKey, dnsNames: ["geraet-abc"] });
    const password = exportPassword();
    const p12 = createPkcs12({ privateKey: key.privateKey, certDer: leaf.der, chainDer: [intermediate.der], password, friendlyName: "SchulOS iPad Lehrerzimmer" });
    return { leaf, password, p12 };
  }

  /** Server wie Caddy mit `verify_if_given`: fordert ein Zertifikat an, verlangt es aber nicht; vertraut nur der Schul-CA */
  async function handshake(client: { pfx?: Buffer; passphrase?: string }): Promise<{ authorized: boolean; fingerprint: string | null; error?: string }> {
    const srv = createServer({ key: server.key.export({ type: "pkcs8", format: "pem" }), cert: server.pem, ca: [root.pem], requestCert: true, rejectUnauthorized: false });
    const seen = new Promise<{ authorized: boolean; fingerprint: string | null }>((resolve) =>
      srv.on("secureConnection", (s: TLSSocket) => {
        const peer = s.getPeerCertificate();
        resolve({ authorized: s.authorized, fingerprint: peer && "fingerprint256" in peer && peer.fingerprint256 ? peer.fingerprint256 : null });
        s.end();
      }),
    );
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
      const sock = connect({ host: "127.0.0.1", port, servername: "localhost", ca: [root.pem], ...client });
      await new Promise<void>((resolve, reject) => {
        sock.once("secureConnect", () => resolve());
        sock.once("error", reject);
      });
      const r = await seen;
      sock.destroy();
      return r;
    } finally {
      srv.close();
    }
  }

  it("OpenSSL liest die Datei mit dem Passwort – mit falschem Passwort nicht", async () => {
    const { p12, password } = await deviceIdentity();
    expect(() => createSecureContext({ pfx: p12, passphrase: password })).not.toThrow();
    expect(() => createSecureContext({ pfx: p12, passphrase: "falsch" })).toThrow();
  });

  it("Gerät meldet sich mit dem Zertifikat aus der .p12 an (Kette über das Zwischenzertifikat)", async () => {
    const { p12, password, leaf } = await deviceIdentity();
    const r = await handshake({ pfx: p12, passphrase: password });
    expect(r.authorized).toBe(true);
    expect(r.fingerprint).toBe(leaf.x509.fingerprint256);
  });

  it("Zertifikat einer fremden CA wird nicht als verifiziert anerkannt; ohne Zertifikat auch nicht", async () => {
    const foreign = makeCert({ cn: "Fremde CA", ca: true });
    const { p12, password } = await deviceIdentity(foreign);
    expect((await handshake({ pfx: p12, passphrase: password })).authorized).toBe(false);
    const none = await handshake({});
    expect(none.authorized).toBe(false);
  });

  it("Konfigurationsprofil enthält die .p12, das Passwort und maskierte Bezeichnungen", async () => {
    const { p12, password } = await deviceIdentity();
    const text = createMobileconfig({ p12, password, commonName: "geraet-abc", label: 'iPad <3> & "Co"', organization: "Gesamtschule am Lindenhof" }).toString("utf8");
    expect(text).toContain("<string>com.apple.security.pkcs12</string>");
    expect(text).toContain(`<string>${password}</string>`);
    expect(text).toContain("iPad &lt;3&gt; &amp; &quot;Co&quot;");
    expect(text).not.toContain("<3>");
    const data = /<data>\n([\s\S]+?)<\/data>/.exec(text)?.[1]?.replace(/\s+/g, "");
    expect(Buffer.from(data!, "base64").equals(p12)).toBe(true);
  });

  it("Export-Passwort: 5 Vierergruppen ohne verwechselbare Zeichen, jedes Mal neu", () => {
    const a = exportPassword();
    expect(a).toMatch(/^[a-km-np-z2-9]{4}(?:-[a-km-np-z2-9]{4}){4}$/);
    expect(exportPassword()).not.toBe(a);
  });

  it("pemBlocks liest Ketten", () => {
    expect(pemBlocks(root.pem + intermediate.pem, "CERTIFICATE")).toEqual([root.der, intermediate.der]);
  });
});
