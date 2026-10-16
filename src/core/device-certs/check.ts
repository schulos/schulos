// Prüfung der Schul-CA (P4-40b) für `node cli.mjs geraete-ca-pruefen` (CI-Job `stack`, Betrieb): ein Testzertifikat über
// step-ca ausstellen lassen und prüfen – Schlüssel passt, Name stimmt, Kette führt zur Wurzel, Laufzeit wie bestellt.
// Trägt nichts in die Freigabeliste ein (das Zertifikat gilt also nirgends) und speichert den Schlüssel nicht.
import { randomBytes, X509Certificate } from "node:crypto";
import { fingerprintOf } from "./issue";
import { createCsr, newDeviceKey } from "./pkcs12";
import { signCsr, stepCaConfig, type Env, type Transport } from "./step-ca";

export async function checkDeviceCa(env: Env, transport?: Transport): Promise<{ ok: boolean; fingerprint?: string; notAfter?: string; error?: string }> {
  try {
    const cfg = stepCaConfig(env);
    const cn = `geraet-pruefung-${randomBytes(4).toString("hex")}`;
    const key = await newDeviceKey();
    const notAfter = new Date(Date.now() + 365 * 86_400_000);
    const signed = await signCsr(cfg, createCsr(key, cn), cn, notAfter, transport);
    const cert = new X509Certificate(signed.certPem);
    const root = new X509Certificate(cfg.rootPem);
    const chain = signed.chainPem.map((p) => new X509Certificate(p));
    const problems: string[] = [];
    if (!cert.checkPrivateKey(key.privateKey)) problems.push("Schlüssel passt nicht");
    if (!cert.subject.split("\n").includes(`CN=${cn}`)) problems.push("Name stimmt nicht");
    // Kette: Gerät ← Zwischen-CA(s) ← Wurzel
    let issuer = cert;
    for (const c of chain) {
      if (!issuer.verify(c.publicKey)) problems.push(`Kette bricht bei ${c.subject}`);
      issuer = c;
    }
    if (!issuer.verify(root.publicKey)) problems.push("Kette endet nicht an der Wurzel der Schul-CA");
    if (Math.abs(new Date(cert.validTo).getTime() - notAfter.getTime()) > 86_400_000) problems.push(`Laufzeit ${cert.validTo} statt ${notAfter.toISOString()}`);
    return problems.length ? { ok: false, error: problems.join("; ") } : { ok: true, fingerprint: fingerprintOf(cert), notAfter: new Date(cert.validTo).toISOString() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
