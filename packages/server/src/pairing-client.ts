// Kopplung aus Sicht des Hauptsystems (INSTALLATION.md §4.3): hello → CA prüfen → claim über gepinntes TLS.
import {
  aad,
  generateRecoveryKey,
  normalizePairingCode,
  open,
  pairingKey,
  pairingLookup,
  randomSecret,
  seal,
  type PairingClaim,
  type PairingHello,
  type PairingResult,
} from "./pairing";
import { RequestError, requestJson, type TlsTrust } from "./pinned-request";

/** Was das Hauptsystem nach der Kopplung dauerhaft speichert (Konfigurationsordner, nur für den App-Benutzer lesbar). */
export interface StoredPairing {
  version: 1;
  backupUrl: string;
  serverName: string;
  /** gepinnte CA des Backupservers; null = öffentliches Zertifikat (System-Truststore) */
  caPem: string | null;
  instanceId: string;
  instanceName: string;
  repoUrl: string;
  restUser: string;
  restPassword: string;
  agentToken: string;
  /** restic-Repository-Passwort – entsteht hier, der Backupserver hat eine Kopie */
  repoPassword: string;
  /** zweiter restic-Schlüssel zum Ausdrucken; bleibt nur gespeichert, bis der Agent ihn ins Repository eingetragen hat (B-24) */
  recoveryKey: string | null;
  recoveryConfirmedAt: string | null;
  pairedAt: string;
}

export class PairingError extends Error {
  constructor(
    message: string,
    /** true = Netz (noch) nicht bereit – ein späterer Versuch kann gelingen (z. B. DHCP/DNS direkt nach dem Start) */
    readonly transient = false,
  ) {
    super(message);
  }
}

export type RequestFn = typeof requestJson;

export interface PairInput {
  backupUrl: string;
  code: string;
  instanceName: string;
  mainUrl: string;
}

/** Adresse prüfen und normalisieren; http nur, wenn ausdrücklich erlaubt (Entwicklung, Tests). */
export function normalizeBackupUrl(input: string, allowHttp = false): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new PairingError("Die Adresse des Backupservers ist ungültig (z. B. https://backup.schule.de).");
  }
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw new PairingError("Die Adresse des Backupservers muss mit https:// beginnen.");
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

function trustFor(url: string, caPem: string | null): TlsTrust {
  if (url.startsWith("http:")) return { mode: "system" }; // ohne TLS (nur Entwicklung)
  return caPem ? { mode: "ca", caPem } : { mode: "system" };
}

/** TLS-Vertrauen für alle späteren Aufrufe beim Backupserver (Agent, Status). */
export function pairingTrust(p: Pick<StoredPairing, "backupUrl" | "caPem">): TlsTrust {
  return trustFor(p.backupUrl, p.caPem);
}

function networkMessage(err: unknown): never {
  if (err instanceof RequestError) {
    if (err.kind === "tls")
      throw new PairingError(
        "Das Zertifikat des Backupservers passt nicht zu der CA, die er bei der Kopplung genannt hat. Kopplung abgebrochen – Adresse prüfen (jemand dazwischen?).",
      );
    if (err.kind === "too_large")
      throw new PairingError("Die Antwort ist viel zu groß für einen Backupserver – falsche Adresse oder jemand dazwischen. Kopplung abgebrochen.");
    throw new PairingError(`Der Backupserver ist nicht erreichbar (${err.message}).`, true);
  }
  throw err;
}

const NOT_FOUND = "Der Kopplungscode ist unbekannt, abgelaufen oder schon verwendet. Auf dem Backupserver einen neuen Code erzeugen.";

/** 1. hello – TLS noch ungeprüft, Antwort mit dem Code verschlüsselt. Verbraucht den Code nicht. */
async function hello(backupUrl: string, code: string, request: RequestFn) {
  const lookup = pairingLookup(code);
  const key = pairingKey(code);
  const res = await request<{ sealed?: string; error?: string }>(`${backupUrl}/api/pairing/hello`, {
    trust: { mode: "insecure" },
    headers: { "x-pairing-lookup": lookup },
  }).catch(networkMessage);
  if (res.status === 404) throw new PairingError(NOT_FOUND);
  if (res.status !== 200 || !res.body?.sealed) throw new PairingError(`Unerwartete Antwort des Backupservers (${res.status}). Ist das die richtige Adresse?`);
  let info: PairingHello;
  try {
    info = open<PairingHello>(key, res.body.sealed, aad.hello(lookup));
  } catch {
    throw new PairingError("Die Antwort passt nicht zum Kopplungscode – falsche Adresse oder jemand dazwischen. Kopplung abgebrochen.");
  }
  return { info, lookup, key };
}

function parseCode(input: string): string {
  const code = normalizePairingCode(input);
  if (!code) throw new PairingError("Der Kopplungscode hat nicht das richtige Format (zwölf Zeichen, z. B. K7Q2-9MXA-4RT1).");
  return code;
}

/**
 * Vorab-Prüfung für den Installer (§3.2): Backupserver erreichbar und Code gültig? Nur „hello“ – der Code bleibt unverbraucht,
 * gekoppelt wird erst nach der Installation.
 */
export async function checkBackupServer(
  input: { backupUrl: string; code: string },
  opts: { allowHttp?: boolean; request?: RequestFn } = {},
): Promise<{ serverName: string; ownCa: boolean }> {
  const code = parseCode(input.code);
  const { info } = await hello(normalizeBackupUrl(input.backupUrl, opts.allowHttp), code, opts.request ?? requestJson);
  return { serverName: info.serverName, ownCa: info.caPem !== null };
}

export async function pairWithBackup(input: PairInput, opts: { allowHttp?: boolean; request?: RequestFn; now?: Date } = {}): Promise<StoredPairing> {
  const request = opts.request ?? requestJson;
  const code = parseCode(input.code);
  const backupUrl = normalizeBackupUrl(input.backupUrl, opts.allowHttp);
  const instanceName = input.instanceName.trim().slice(0, 80);
  if (!instanceName) throw new PairingError("Name der Instanz fehlt.");
  const { info, lookup, key } = await hello(backupUrl, code, request);

  // 2. claim – nur noch über TLS mit der genannten CA bzw. dem System-Truststore
  const trust = trustFor(backupUrl, info.caPem);
  const claim: PairingClaim = { nonce: randomSecret(16), instanceName, mainUrl: input.mainUrl, repoPassword: randomSecret() };
  const res = await request<{ sealed?: string; error?: string }>(`${backupUrl}/api/pairing/claim`, {
    method: "POST",
    trust,
    body: { lookup, request: seal(key, claim, aad.claim(lookup)) },
  }).catch(networkMessage);
  if (res.status === 404) throw new PairingError(NOT_FOUND);
  if (res.status !== 200 || !res.body?.sealed) throw new PairingError(res.body?.error ?? `Kopplung abgelehnt (${res.status}).`);
  let result: PairingResult;
  try {
    result = open<PairingResult>(key, res.body.sealed, aad.claimOk(lookup));
  } catch {
    throw new PairingError("Die Antwort passt nicht zum Kopplungscode. Kopplung abgebrochen.");
  }
  if (result.nonce !== claim.nonce) throw new PairingError("Die Antwort gehört nicht zu dieser Anfrage. Kopplung abgebrochen.");
  // Ersatz-Kopplung: bestehendes Repository, Wiederherstellungsschlüssel schon eingetragen
  const existing = Boolean(result.repoPassword) && !result.freshRepository;

  return {
    version: 1,
    backupUrl,
    serverName: info.serverName,
    caPem: info.caPem,
    instanceId: result.instanceId,
    instanceName,
    repoUrl: result.repoUrl,
    restUser: result.restUser,
    restPassword: result.restPassword,
    agentToken: result.agentToken,
    // Ersatz-Kopplung bzw. Wiederholung: das Passwort des Backupservers gilt
    repoPassword: result.repoPassword ?? claim.repoPassword,
    recoveryKey: existing ? null : generateRecoveryKey(),
    recoveryConfirmedAt: existing ? (opts.now ?? new Date()).toISOString() : null,
    pairedAt: (opts.now ?? new Date()).toISOString(),
  };
}
