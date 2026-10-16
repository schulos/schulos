// Kopplung auf der Seite des Backupservers (INSTALLATION.md §4.3, Protokoll in @schulos/server/pairing).
import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import {
  aad,
  atRestKey,
  generatePairingCode,
  normalizePairingCode,
  open,
  pairingKey,
  pairingLookup,
  PAIRING_VALID_HOURS,
  randomSecret,
  seal,
  sha256Hex,
  type PairingClaim,
  type PairingHello,
  type PairingResult,
} from "@schulos/server/pairing";
import { audit } from "@/audit";
import type { Db } from "@/db/client";
import { instances, pairingCodes } from "@/db/schema";
import type { Retention } from "@schulos/server/backup-retention";
import { removeRestUser, setRestUser } from "./htpasswd";

export interface PairingContext {
  appSecret: string;
  caPem: string | null;
  serverName: string;
  restDir: string;
  restBaseUrl: string;
  /** Aufbewahrung für neue Instanzen (SCHULOS_RETENTION aus dem Installer); ohne Angabe die Vorgabe der Datenbank */
  retention?: { retention: Retention; reason: string | null };
}

const KEY_AAD = "pairing-key";
const REPO_AAD = "repo-password";
const RESULT_AAD = "pairing-result";

/**
 * So lange nach der Kopplung liefert derselbe Code noch einmal dasselbe Ergebnis – falls die Antwort auf „claim“ unterwegs verloren
 * ging (Verbindung abgebrochen), kann der Aufrufer es so wiederholen. Danach ist der Code endgültig verbraucht.
 */
export const PAIRING_REPLAY_MINUTES = 15;

// ---------------------------------------------------------------- Codes (Web-UI)

/**
 * Neuer Kopplungscode – wird genau einmal angezeigt. Mit `replacesInstanceId` ein **Ersatz-Code** (neue Hardware): wer ihn einlöst,
 * übernimmt diese Instanz samt Repository und erhält dessen Passwort, um die Sicherungen zurückzuspielen.
 */
export async function createPairingCode(
  db: Db,
  actorId: string | null,
  appSecret: string,
  now = new Date(),
  replacesInstanceId: string | null = null,
): Promise<{ code: string; expiresAt: Date }> {
  const code = generatePairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_VALID_HOURS * 3600_000);
  await db.insert(pairingCodes).values({
    id: crypto.randomUUID(),
    lookup: pairingLookup(code),
    keyEnc: seal(atRestKey(appSecret, "pairing"), pairingKey(code).toString("base64url"), KEY_AAD),
    createdBy: actorId,
    createdAt: now,
    expiresAt,
    replacesInstanceId,
  });
  await audit(db, actorId, replacesInstanceId ? "kopplung.ersatzcode_erzeugt" : "kopplung.code_erzeugt", replacesInstanceId, {
    gueltigBis: expiresAt.toISOString(),
  });
  return { code, expiresAt };
}

export async function openCodes(db: Db, now = new Date()) {
  return db
    .select({ id: pairingCodes.id, createdAt: pairingCodes.createdAt, expiresAt: pairingCodes.expiresAt, replacesInstanceId: pairingCodes.replacesInstanceId })
    .from(pairingCodes)
    .where(and(isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, now)))
    .orderBy(asc(pairingCodes.createdAt));
}

export async function revokeCode(db: Db, actorId: string, id: string): Promise<void> {
  await db.delete(pairingCodes).where(and(eq(pairingCodes.id, id), isNull(pairingCodes.usedAt)));
  await audit(db, actorId, "kopplung.code_zurueckgezogen", id);
}

/** Offener Code – oder (`replay`) ein gerade eingelöster, dessen Ergebnis noch für eine Wiederholung bereitliegt. */
async function findCode(db: Db, lookup: string, appSecret: string, now: Date) {
  if (!/^[0-9a-f]{64}$/.test(lookup)) return null;
  const replaySince = new Date(now.getTime() - PAIRING_REPLAY_MINUTES * 60_000);
  const [row] = await db
    .select()
    .from(pairingCodes)
    .where(
      and(
        eq(pairingCodes.lookup, lookup),
        or(
          and(isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, now)),
          and(isNotNull(pairingCodes.resultEnc), gt(pairingCodes.usedAt, replaySince)),
        ),
      ),
    );
  if (!row) return null;
  const key = Buffer.from(open<string>(atRestKey(appSecret, "pairing"), row.keyEnc, KEY_AAD), "base64url");
  return { row, key, replay: row.usedAt !== null };
}

type FoundCode = NonNullable<Awaited<ReturnType<typeof findCode>>>;

/** Ergebnis für eine Wiederholung ablegen (ohne Nonce – die kommt aus der jeweiligen Anfrage). */
function sealResult(appSecret: string, result: Omit<PairingResult, "nonce">): string {
  return seal(atRestKey(appSecret, "pairing"), result, RESULT_AAD);
}

/**
 * SEC-06: Wiederholungsfenster schließen, sobald sich der Agent mit seinem Token meldet – dann ist die Antwort angekommen,
 * und wer den Code mitgelesen hat, bekommt die Zugangsdaten nicht mehr (sonst bis zu 15 Minuten lang).
 */
export async function endPairingReplay(db: Db, instanceId: string): Promise<void> {
  await db.update(pairingCodes).set({ resultEnc: null }).where(and(eq(pairingCodes.instanceId, instanceId), isNotNull(pairingCodes.resultEnc)));
}

/** Abgelegte Ergebnisse nach dem Wiederholungsfenster löschen (Hintergrundjob). */
export async function forgetPairingResults(db: Db, now = new Date()): Promise<void> {
  const before = new Date(now.getTime() - PAIRING_REPLAY_MINUTES * 60_000);
  await db.update(pairingCodes).set({ resultEnc: null }).where(and(isNotNull(pairingCodes.resultEnc), lte(pairingCodes.usedAt, before)));
}

// ---------------------------------------------------------------- Protokoll (API, ohne Anmeldung – der Code ist der Zugang)

/** „hello“: CA und Name, verschlüsselt mit dem Code. null = kein offener Code mit diesem Suchschlüssel. */
export async function pairingHello(db: Db, lookup: string, ctx: PairingContext, now = new Date()): Promise<string | null> {
  const found = await findCode(db, lookup, ctx.appSecret, now);
  if (!found) return null;
  const hello: PairingHello = { caPem: ctx.caPem, serverName: ctx.serverName };
  return seal(found.key, hello, aad.hello(lookup));
}

export class PairingRejected extends Error {}

/**
 * „claim“: legt die Instanz an (eigener rest-server-Zugang, Agent-Token), verbraucht den Code und antwortet verschlüsselt.
 * Innerhalb von PAIRING_REPLAY_MINUTES liefert derselbe Code bei einer Wiederholung dasselbe Ergebnis (Antwort verloren gegangen).
 * null = kein offener Code; PairingRejected = Anfrage nicht mit diesem Code verschlüsselt oder unvollständig.
 */
export async function pairingClaim(db: Db, lookup: string, sealedRequest: string, ctx: PairingContext, now = new Date()): Promise<string | null> {
  const found = await findCode(db, lookup, ctx.appSecret, now);
  if (!found) return null;
  let req: PairingClaim;
  try {
    req = open<PairingClaim>(found.key, sealedRequest, aad.claim(lookup));
  } catch {
    throw new PairingRejected("Anfrage passt nicht zum Kopplungscode");
  }
  const name = String(req.instanceName ?? "").trim().slice(0, 80);
  if (!name || typeof req.repoPassword !== "string" || req.repoPassword.length < 20 || typeof req.nonce !== "string")
    throw new PairingRejected("Anfrage unvollständig");
  if (found.replay) return replayClaim(db, found, lookup, req, ctx);
  if (found.row.replacesInstanceId) return claimReplacement(db, found, lookup, req, ctx, now);

  const instanceId = crypto.randomUUID();
  const restUser = `i-${randomBytes(4).toString("hex")}`;
  const restPassword = randomSecret();
  const agentToken = randomSecret();
  const repoUrl = `${ctx.restBaseUrl}/${restUser}/`;
  const resultEnc = sealResult(ctx.appSecret, { instanceId, repoUrl, restUser, restPassword, agentToken, repoPassword: req.repoPassword, freshRepository: true });

  const claimed = await db.transaction(async (tx) => {
    // atomar: ein Code koppelt genau einmal, auch bei gleichzeitigen Anfragen
    const [code] = await tx
      .update(pairingCodes)
      .set({ usedAt: now, resultEnc })
      .where(and(eq(pairingCodes.id, found.row.id), isNull(pairingCodes.usedAt)))
      .returning({ id: pairingCodes.id });
    if (!code) return false;
    await tx.insert(instances).values({
      id: instanceId,
      name,
      restUser,
      repoPasswordEnc: seal(atRestKey(ctx.appSecret, "repo"), req.repoPassword, REPO_AAD),
      agentTokenHash: sha256Hex(agentToken),
      ...(ctx.retention ? { retention: ctx.retention.retention, retentionReason: ctx.retention.reason } : {}),
      mainUrl: typeof req.mainUrl === "string" ? req.mainUrl.slice(0, 300) : null,
      pairedBy: found.row.createdBy,
      createdAt: now,
    });
    await tx.update(pairingCodes).set({ instanceId }).where(eq(pairingCodes.id, found.row.id));
    return true;
  });
  if (!claimed) return null;

  await setRestUser(ctx.restDir, restUser, restPassword);
  await audit(db, null, "kopplung.gekoppelt", instanceId, { name, hauptsystem: req.mainUrl ?? null });
  const result: PairingResult = { nonce: req.nonce, instanceId, repoUrl, restUser, restPassword, agentToken };
  return seal(found.key, result, aad.claimOk(lookup));
}

/**
 * Ersatz-Kopplung: dieselbe Instanz, dasselbe Repository – neue rest-server-Zugangsdaten und neuer Agent-Token (die alten werden
 * ungültig), dazu das bestehende Repository-Passwort. Das neue Hauptsystem spielt damit die Sicherungen zurück (Agent: wiederherstellen).
 */
async function claimReplacement(
  db: Db,
  found: FoundCode,
  lookup: string,
  req: PairingClaim,
  ctx: PairingContext,
  now: Date,
): Promise<string | null> {
  const [inst] = await db.select().from(instances).where(eq(instances.id, found.row.replacesInstanceId!));
  if (!inst) throw new PairingRejected("Die zu ersetzende Instanz gibt es nicht mehr.");
  const restPassword = randomSecret();
  const agentToken = randomSecret();
  const replacement: Omit<PairingResult, "nonce"> = {
    instanceId: inst.id,
    repoUrl: `${ctx.restBaseUrl}/${inst.restUser}/`,
    restUser: inst.restUser,
    restPassword,
    agentToken,
    repoPassword: repoPassword(inst, ctx.appSecret),
  };
  const claimed = await db.transaction(async (tx) => {
    const [code] = await tx
      .update(pairingCodes)
      .set({ usedAt: now, instanceId: inst.id, resultEnc: sealResult(ctx.appSecret, replacement) })
      .where(and(eq(pairingCodes.id, found.row.id), isNull(pairingCodes.usedAt)))
      .returning({ id: pairingCodes.id });
    if (!code) return false;
    await tx
      .update(instances)
      .set({ agentTokenHash: sha256Hex(agentToken), mainUrl: typeof req.mainUrl === "string" ? req.mainUrl.slice(0, 300) : inst.mainUrl, removedAt: null })
      .where(eq(instances.id, inst.id));
    return true;
  });
  if (!claimed) return null;
  await setRestUser(ctx.restDir, inst.restUser, restPassword);
  await audit(db, null, "kopplung.ersatz", inst.id, { name: inst.name, hauptsystem: req.mainUrl ?? null });
  return seal(found.key, { nonce: req.nonce, ...replacement } satisfies PairingResult, aad.claimOk(lookup));
}

/**
 * Wiederholter „claim“ kurz nach der Kopplung: dasselbe Ergebnis wie beim ersten Mal (gleiche Instanz, Zugangsdaten und
 * Repository-Passwort), nur mit der Nonce der neuen Anfrage. Den rest-server-Zugang schreibt er erneut – falls der erste Versuch
 * nach dem Eintrag in der DB abgebrochen ist. Eine inzwischen entkoppelte oder ersetzte Instanz wird nicht wiederbelebt.
 */
async function replayClaim(db: Db, found: FoundCode, lookup: string, req: PairingClaim, ctx: PairingContext): Promise<string | null> {
  const stored = open<Omit<PairingResult, "nonce">>(atRestKey(ctx.appSecret, "pairing"), found.row.resultEnc!, RESULT_AAD);
  const [inst] = await db.select().from(instances).where(and(eq(instances.id, stored.instanceId), isNull(instances.removedAt)));
  if (!inst || inst.agentTokenHash !== sha256Hex(stored.agentToken)) return null;
  await setRestUser(ctx.restDir, stored.restUser, stored.restPassword);
  await audit(db, null, "kopplung.wiederholt", inst.id, { name: inst.name });
  return seal(found.key, { nonce: req.nonce, ...stored } satisfies PairingResult, aad.claimOk(lookup));
}

// ---------------------------------------------------------------- Instanzen (Web-UI)

export async function listInstances(db: Db) {
  return db.select().from(instances).where(isNull(instances.removedAt)).orderBy(asc(instances.name));
}

export async function renameInstance(db: Db, actorId: string, id: string, name: string): Promise<void> {
  const n = name.trim().slice(0, 80);
  if (!n) throw new PairingRejected("Name fehlt");
  await db.update(instances).set({ name: n }).where(eq(instances.id, id));
  await audit(db, actorId, "instanz.umbenannt", id, { name: n });
}

/** Entkoppeln: Zugang im rest-server entfernen, Agent-Token ungültig. Das Repository bleibt erhalten. */
export async function unpairInstance(db: Db, actorId: string, id: string, restDir: string, now = new Date()): Promise<void> {
  const [inst] = await db.select().from(instances).where(and(eq(instances.id, id), isNull(instances.removedAt)));
  if (!inst) return;
  removeRestUser(restDir, inst.restUser);
  await db.update(instances).set({ removedAt: now, agentTokenHash: `entfernt:${inst.id}` }).where(eq(instances.id, id));
  await audit(db, actorId, "instanz.entkoppelt", id, { name: inst.name });
}

/** Repository-Passwort einer Instanz (für restic-Läufe auf dem Backupserver ab B-25). */
export function repoPassword(inst: { repoPasswordEnc: string }, appSecret: string): string {
  return open<string>(atRestKey(appSecret, "repo"), inst.repoPasswordEnc, REPO_AAD);
}

/**
 * Kopplungscode aus der Konfiguration (SCHULOS_INITIAL_PAIRING_CODE) – für Installer und CI (INSTALLATION.md §7), die
 * Backupserver und Hauptsystem ohne Klick in der Web-UI koppeln. Wird beim Start einmal übernommen (24 h gültig);
 * ein schon bekannter Code (offen, verbraucht oder abgelaufen) wird nicht erneut angelegt.
 */
export async function registerInitialCode(db: Db, code: string, appSecret: string, now = new Date()): Promise<"angelegt" | "bekannt" | "ungueltig"> {
  if (!normalizePairingCode(code)) return "ungueltig";
  const lookup = pairingLookup(code);
  const [known] = await db.select({ id: pairingCodes.id }).from(pairingCodes).where(eq(pairingCodes.lookup, lookup));
  if (known) return "bekannt";
  await db.insert(pairingCodes).values({
    id: crypto.randomUUID(),
    lookup,
    keyEnc: seal(atRestKey(appSecret, "pairing"), pairingKey(code).toString("base64url"), KEY_AAD),
    createdBy: null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + PAIRING_VALID_HOURS * 3600_000),
  });
  await audit(db, null, "kopplung.code_erzeugt", null, { quelle: "Konfiguration" });
  return "angelegt";
}
