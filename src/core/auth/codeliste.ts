// SEC-02: Gedruckte Code-Liste für Schüler:innen ohne Handy. Das Sekretariat erzeugt zehn Einmalcodes und druckt sie mit Name
// und Klasse aus; gespeichert werden nur HMACs der unbenutzten Codes (Schlüssel = Server-Geheimnis – ein Datenbank-Abzug allein
// reicht nicht zum Durchprobieren). Eine neue Liste macht die alte ungültig und beendet alle Sitzungen des Kontos (G4E-S03). Von außerhalb des Schulnetzes verlangt SchulOS nach
// dem Passwort einen Code von der Liste (SEC-01, pflicht.ts); der Code kennzeichnet die Sitzung als „mit zweitem Faktor“.
import { createHmac, randomInt } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { sessions, twoFactorCodeLists, users } from "@/core/db/schema";
import { endLiveStreams } from "@/core/notifications/bus";
import { consumeRate, rateLimitMessage } from "@/core/rate-limit";
import { assertMayManage, loadActor } from "@/modules/verwaltung/escalation";

export const CODE_COUNT = 10;
/** ohne leicht verwechselbare Zeichen (0/O, 1/I/L) */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 10;

export class CodeListError extends Error {}

const DEV_SECRET = "schulos-dev-code-liste";
function key(env: Record<string, string | undefined> = process.env): string {
  return env.BETTER_AUTH_SECRET || DEV_SECRET;
}

/** Eingabe vereinheitlichen: Groß, ohne Leerzeichen/Bindestriche. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

/** HMAC eines Codes, gebunden an das Konto (derselbe Code an zwei Konten ergibt verschiedene Werte). */
export function codeHash(userId: string, code: string): string {
  return createHmac("sha256", key())
    .update(`${userId}:${normalizeCode(code)}`)
    .digest("hex");
}

/** Code zum Drucken: „ABCDE-FGHJK“ (10 Zeichen aus 31 ≈ 49 bit). */
export function newCode(): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export interface CodeListStatus {
  remaining: number;
  total: number;
  createdAt: Date;
}

export async function codeListStatus(db: Db, userId: string): Promise<CodeListStatus | null> {
  const [row] = await db.select().from(twoFactorCodeLists).where(eq(twoFactorCodeLists.userId, userId));
  return row ? { remaining: row.codes.length, total: row.total, createdAt: row.createdAt } : null;
}

/** Hat das Konto eine Liste mit mindestens einem unbenutzten Code? */
export async function hasCodeList(db: Db, userId: string): Promise<boolean> {
  return ((await codeListStatus(db, userId))?.remaining ?? 0) > 0;
}

/**
 * Neue Liste erzeugen (ersetzt eine vorhandene). Nur für Schüler:innen; Rechte prüft der Aufrufer (`verwaltung.zwei_faktor`),
 * Konten mit mehr Rechten nur durch Admins (wie beim Zurücksetzen). Liefert die Codes **einmal** zum Drucken.
 */
export async function createCodeList(db: Db, actorId: string, userId: string, now = new Date()): Promise<string[]> {
  await assertMayManage(db, await loadActor(db, actorId), userId, "twoFactor");
  const [u] = await db.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, userId));
  if (!u) throw new CodeListError("Konto gibt es nicht");
  if (u.role !== "schueler") throw new CodeListError("Code-Listen gibt es nur für Schüler:innen – Erwachsene richten eine Authenticator-App ein.");
  if (u.status !== "active") throw new CodeListError("Das Konto ist gesperrt");
  const codes = Array.from({ length: CODE_COUNT }, newCode);
  const hashes = codes.map((c) => codeHash(userId, c));
  const ended = await db.transaction(async (tx) => {
    const [before] = await tx.select({ userId: twoFactorCodeLists.userId }).from(twoFactorCodeLists).where(eq(twoFactorCodeLists.userId, userId)).for("update");
    await tx
      .insert(twoFactorCodeLists)
      .values({ userId, codes: hashes, total: CODE_COUNT, createdBy: actorId, createdAt: now })
      .onConflictDoUpdate({ target: twoFactorCodeLists.userId, set: { codes: hashes, total: CODE_COUNT, createdBy: actorId, createdAt: now } });
    // G4E-S03 (Q-4E-43): eine neue Liste ersetzt eine verlorene – Anmeldungen mit Codes der alten Liste dürfen nicht weiterlaufen.
    // Welche Sitzung mit welchem Code entstand, ist nicht gespeichert; deshalb enden alle Sitzungen des Kontos.
    if (!before) return 0;
    return (await tx.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id })).length;
  });
  if (ended) endLiveStreams(userId);
  await audit(db, actorId, "verwaltung.user.2fa_codeliste", userId, ended ? { sitzungenBeendet: ended } : undefined);
  return codes;
}

/**
 * Code von der Liste einlösen: gültig → Code verbraucht (atomar, nur einmal) und die Sitzung als „mit zweitem Faktor
 * angemeldet“ gekennzeichnet. Höchstens 10 Versuche je 15 Minuten und Konto.
 */
export async function redeemCode(db: Db, userId: string, sessionId: string, raw: string, now = new Date()): Promise<void> {
  const code = normalizeCode(raw);
  if (!code) throw new CodeListError("Bitte einen Code von der Liste eingeben.");
  const rate = await consumeRate(db, "konto.codeliste", userId, now);
  if (!rate.allowed) throw new CodeListError(rateLimitMessage(rate.retryAt));
  const hash = codeHash(userId, code);
  const used = await db
    .update(twoFactorCodeLists)
    .set({ codes: sql`${twoFactorCodeLists.codes} - ${hash}::text` })
    .where(and(eq(twoFactorCodeLists.userId, userId), sql`${twoFactorCodeLists.codes} @> jsonb_build_array(${hash}::text)`))
    .returning({ userId: twoFactorCodeLists.userId });
  if (used.length === 0) {
    await audit(db, userId, "konto.2fa.codeliste_falsch", userId);
    throw new CodeListError("Der Code stimmt nicht oder wurde schon benutzt.");
  }
  await db
    .update(sessions)
    .set({ secondFactorAt: now })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  await audit(db, userId, "konto.2fa.codeliste_benutzt", userId);
}
