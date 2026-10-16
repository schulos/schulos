// Client für die Schul-CA (step-ca, Compose-Profil `geraete`, P4-40b): CSR mit einem Einmal-Token des JWK-Provisioners
// signieren lassen. Ablauf wie `step ca certificate`: Provisioner-Liste holen, dessen verschlüsselten Schlüssel (JWE,
// PBES2) mit dem Provisioner-Passwort öffnen, ein kurzlebiges JWT (ES256) ausstellen, `POST /1.0/sign`.
// Verbindung nur per TLS gegen die Wurzel der Schul-CA (kein System-Vertrauen, kein „unsicher“).
import { readFileSync } from "node:fs";
import { request } from "node:https";
import path from "node:path";
import { randomUUID, X509Certificate } from "node:crypto";
import { compactDecrypt, importJWK, SignJWT, type JWK } from "jose";

export interface StepCaConfig {
  /** z. B. https://step-ca:9000 (internes Netz `ca` in compose.yaml) */
  url: string;
  provisioner: string;
  password: string;
  /** Wurzelzertifikat der Schul-CA (PEM) – für die TLS-Verbindung zu step-ca */
  rootPem: string;
}

export class StepCaError extends Error {}

/** Umgebung (process.env oder in Tests ein Objekt) */
export type Env = Record<string, string | undefined>;

/** Verzeichnis mit `root_ca.crt`/`intermediate_ca.crt` (Volume `geraete_ca`, schreibt step-ca beim Start) */
export function deviceCaDir(env: Env = process.env): string {
  return env.SCHULOS_DEVICE_CA_DIR ?? "/srv/schulos/geraete-ca";
}

/** Wurzelzertifikat der Schul-CA oder null (noch nicht eingerichtet) */
export function readRootPem(env: Env = process.env): string | null {
  try {
    const text = readFileSync(path.join(deviceCaDir(env), "root_ca.crt"), "utf8");
    return text.includes("-----BEGIN CERTIFICATE-----") ? text : null;
  } catch {
    return null;
  }
}

/** Konfiguration aus der Umgebung (compose.yaml, Dienst `app`) – mit verständlicher Meldung, was fehlt */
export function stepCaConfig(env: Env = process.env): StepCaConfig {
  if (env.SCHULOS_DEVICE_CERTS !== "an") throw new StepCaError("Die Schul-CA ist nicht eingerichtet (SCHULOS_DEVICE_CERTS=an, INSTALLATION.md „Gerätezertifikate“).");
  const password = env.SCHULOS_DEVICE_CA_PROVISIONER_PASSWORD;
  if (!password) throw new StepCaError("SCHULOS_DEVICE_CA_PROVISIONER_PASSWORD fehlt in der .env des Stacks.");
  const rootPem = readRootPem(env);
  if (!rootPem) throw new StepCaError(`Wurzelzertifikat der Schul-CA fehlt (${path.join(deviceCaDir(env), "root_ca.crt")}) – läuft step-ca (docker compose --profile geraete up -d)?`);
  return { url: (env.SCHULOS_DEVICE_CA_URL ?? "https://step-ca:9000").replace(/\/+$/, ""), provisioner: env.SCHULOS_DEVICE_CA_PROVISIONER ?? "schulos", password, rootPem };
}

export type Transport = (url: string, init: { method: "GET" | "POST"; body?: unknown }) => Promise<{ status: number; json: unknown }>;

/** HTTPS nur gegen die Wurzel der Schul-CA */
export function caTransport(rootPem: string): Transport {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const body = init.body === undefined ? undefined : JSON.stringify(init.body);
      const req = request(url, { method: init.method, ca: rootPem, headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}, timeout: 15_000 }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null });
          } catch {
            reject(new StepCaError(`Unerwartete Antwort der Schul-CA (HTTP ${res.statusCode})`));
          }
        });
      });
      req.on("timeout", () => req.destroy(new StepCaError("Schul-CA antwortet nicht (Zeitüberschreitung)")));
      req.on("error", (e) => reject(e instanceof StepCaError ? e : new StepCaError(`Schul-CA nicht erreichbar: ${e.message}`)));
      req.end(body);
    });
}

interface Provisioner {
  type: string;
  name: string;
  key?: JWK;
  encryptedKey?: string;
}

/** Privater Schlüssel des JWK-Provisioners (in step-ca als JWE mit PBES2 verschlüsselt abgelegt) */
async function provisionerKey(cfg: StepCaConfig, transport: Transport): Promise<{ jwk: JWK; kid: string }> {
  const res = await transport(`${cfg.url}/provisioners?limit=100`, { method: "GET" });
  const list = (res.json as { provisioners?: Provisioner[] } | null)?.provisioners;
  if (res.status !== 200 || !Array.isArray(list)) throw new StepCaError(`Provisioner-Liste der Schul-CA nicht lesbar (HTTP ${res.status})`);
  const p = list.find((x) => x.type === "JWK" && x.name === cfg.provisioner);
  if (!p?.encryptedKey || !p.key?.kid) throw new StepCaError(`Provisioner „${cfg.provisioner}“ (JWK) fehlt in der Schul-CA`);
  let plain: Uint8Array;
  try {
    // step verschlüsselt mit 100 000 Runden – mehr als jose von sich aus zulässt
    ({ plaintext: plain } = await compactDecrypt(p.encryptedKey, new TextEncoder().encode(cfg.password), {
      keyManagementAlgorithms: ["PBES2-HS256+A128KW", "PBES2-HS384+A192KW", "PBES2-HS512+A256KW"],
      maxPBES2Count: 1_000_000,
    }));
  } catch {
    throw new StepCaError("Provisioner-Passwort passt nicht (SCHULOS_DEVICE_CA_PROVISIONER_PASSWORD)");
  }
  return { jwk: JSON.parse(new TextDecoder().decode(plain)) as JWK, kid: p.key.kid };
}

/** Einmal-Token (5 min) für genau diesen Namen */
export async function signToken(cfg: StepCaConfig, transport: Transport, commonName: string, now = new Date()): Promise<string> {
  const { jwk, kid } = await provisionerKey(cfg, transport);
  const alg = jwk.alg ?? "ES256";
  const key = await importJWK(jwk, alg);
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ sans: [commonName] })
    .setProtectedHeader({ alg, kid, typ: "JWT" })
    .setIssuer(cfg.provisioner)
    .setSubject(commonName)
    .setAudience(`${cfg.url}/1.0/sign`)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(iat + 300)
    .setJti(randomUUID())
    .sign(key);
}

export interface SignedCert {
  certPem: string;
  /** Zwischenzertifikat(e) ohne das Gerätezertifikat selbst */
  chainPem: string[];
}

/** CSR signieren lassen; Laufzeit bis `notAfter` (step-ca begrenzt per Provisioner, siehe compose.yaml) */
export async function signCsr(cfg: StepCaConfig, csrPem: string, commonName: string, notAfter: Date, transport: Transport = caTransport(cfg.rootPem)): Promise<SignedCert> {
  const ott = await signToken(cfg, transport, commonName);
  const res = await transport(`${cfg.url}/1.0/sign`, { method: "POST", body: { csr: csrPem, ott, notAfter: notAfter.toISOString() } });
  const body = res.json as { crt?: string; ca?: string; certChain?: string[]; message?: string } | null;
  if (res.status !== 200 && res.status !== 201) throw new StepCaError(`Schul-CA hat nicht ausgestellt (HTTP ${res.status}${body?.message ? `: ${body.message}` : ""})`);
  if (!body?.crt) throw new StepCaError("Schul-CA hat kein Zertifikat geliefert");
  const chain = (body.certChain?.length ? body.certChain.slice(1) : body.ca ? [body.ca] : []).filter(Boolean);
  // Lesbarkeit prüfen (wirft bei Unsinn)
  new X509Certificate(body.crt);
  return { certPem: body.crt, chainPem: chain };
}

/** Erreichbarkeit für die Übersicht (GET /health) */
export async function caHealth(cfg: StepCaConfig, transport: Transport = caTransport(cfg.rootPem)): Promise<boolean> {
  try {
    const res = await transport(`${cfg.url}/health`, { method: "GET" });
    return res.status === 200 && (res.json as { status?: string } | null)?.status === "ok";
  } catch {
    return false;
  }
}
