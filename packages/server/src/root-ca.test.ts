import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprintLines, mobileconfig, parseRootCa, pemToDer, rootCaInfo } from "./root-ca";

const fixtures = path.join(import.meta.dirname, "../test-fixtures");
const ca = readFileSync(path.join(fixtures, "ca.pem"), "utf8");
const other = readFileSync(path.join(fixtures, "other-ca.pem"), "utf8");

describe("Root der eigenen CA (CA-02…CA-05)", () => {
  it("parseRootCa: PEM + Fingerabdruck nur für CA-Zertifikate", () => {
    const r = parseRootCa(ca)!;
    expect(r.info).toEqual(rootCaInfo(ca));
    expect(r.info.fingerprint).toBe(new X509Certificate(ca).fingerprint256);
    expect(parseRootCa(readFileSync(path.join(fixtures, "localhost.pem"), "utf8"))).toBeNull();
    expect(parseRootCa(readFileSync(path.join(fixtures, "localhost.key"), "utf8"))).toBeNull();
  });

  it("DER für .cer und Fingerabdruck in zwei Hälften", () => {
    expect(pemToDer(ca).equals(new X509Certificate(ca).raw)).toBe(true);
    const fp = rootCaInfo(ca)!.fingerprint;
    const [a, b] = fingerprintLines(fp);
    expect(`${a}:${b}`).toBe(fp);
    expect(a.split(":")).toHaveLength(16);
  });

  it("mobileconfig: genau die Root als com.apple.security.root, stabile Kennung je Root, Name maskiert", () => {
    const p = mobileconfig(ca, { name: "Schul-Zertifikat A & B <Test>" });
    expect(p).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
    expect(p).toContain("<string>com.apple.security.root</string>");
    expect(p).toContain("<string>Configuration</string>");
    expect(p).toContain("Schul-Zertifikat A &amp; B &lt;Test&gt;");
    expect(p).not.toContain("<Test>");
    expect(p).not.toMatch(/PRIVATE|BEGIN/);
    const data = /<data>\n([\s\S]+?)\n\s*<\/data>/.exec(p)?.[1]?.replace(/\s/g, "");
    expect(Buffer.from(data!, "base64").equals(pemToDer(ca))).toBe(true);
    const uuids = [...p.matchAll(/<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
    expect(uuids).toHaveLength(2);
    for (const u of uuids) expect(u).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    expect(new Set(uuids).size).toBe(2);
    // gleiche Root → gleiches Profil (ersetzt beim erneuten Import), andere Root → andere Kennung
    expect(mobileconfig(ca, { name: "x" })).toBe(mobileconfig(ca, { name: "x" }));
    const id = (s: string) => /<key>PayloadIdentifier<\/key>\s*<string>([^<]+)<\/string>\s*<key>PayloadRemovalDisallowed/.exec(s)?.[1];
    expect(id(mobileconfig(ca, { name: "x" }))).not.toBe(id(mobileconfig(other, { name: "x" })));
    expect(id(mobileconfig(ca, { name: "x" }))).toMatch(/^schulos\.root-ca\.[0-9a-f]{16}$/);
  });
});

describe("Download (CA-03/CA-05)", () => {
  it("crt = PEM, cer = DER, mobileconfig; nur bekannte Formate; Dateiname bereinigt", async () => {
    const { isRootCaFormat, rootCaDownload } = await import("./root-ca");
    expect(["crt", "cer", "mobileconfig"].every(isRootCaFormat)).toBe(true);
    expect(isRootCaFormat("key")).toBe(false);
    const crt = rootCaDownload(ca, "crt", { name: "x", filename: "schul-zertifikat" });
    expect(crt.headers.get("content-type")).toBe("application/x-x509-ca-cert");
    expect(crt.headers.get("content-disposition")).toBe('attachment; filename="schul-zertifikat.crt"');
    expect(crt.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await crt.text()).toBe(ca.replace(/\r\n/g, "\n"));
    const cer = rootCaDownload(ca, "cer", { name: "x", filename: 'a"b' });
    expect(Buffer.from(await cer.arrayBuffer()).equals(pemToDer(ca))).toBe(true);
    expect(cer.headers.get("content-disposition")).toBe('attachment; filename="a-b.cer"');
    const mc = rootCaDownload(ca, "mobileconfig", { name: "Schule", filename: "s" });
    expect(mc.headers.get("content-type")).toBe("application/x-apple-aspen-config");
    expect(await mc.text()).toContain("com.apple.security.root");
  });
});
