// Bausteine für öffentliche Abläufe ohne Konto (P4-34, Schulanmeldung): geheime Links (Token), signierte Formular-Zeitstempel
// gegen Bots und gleich lange Antworten. Rein (ohne DB, ohne Next) und damit direkt testbar.
//
// Token: 32 Byte aus dem Zufallsgenerator (256 bit), base64url → 43 Zeichen. In der DB steht nur der SHA-256 (hex); verglichen
// wird zeitkonstant. Ein Datenbank-Abbild verrät damit keine gültigen Links.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_BYTES = 32;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function newPublicToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** SHA-256 als Hex – so wird der Token gespeichert und gesucht. */
export function hashPublicToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Hat der Wert überhaupt die Form eines Tokens? (vor jedem DB-Zugriff – kaputte Adressen kosten keine Abfrage) */
export function isTokenShape(token: unknown): token is string {
  return typeof token === "string" && TOKEN_SHAPE.test(token);
}

/** Zeitkonstanter Vergleich zweier Hex-Hashes (verschiedene Längen → false). */
export function sameHash(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const DEV_SECRET = "schulos-dev-public-stamp";

export function stampSecret(env: Record<string, string | undefined> = process.env): string {
  return env.BETTER_AUTH_SECRET || DEV_SECRET;
}

/**
 * Signierter Zeitstempel für ein Formular („wann wurde es ausgeliefert, für welchen Zweck“). Der Server prüft beim Absenden
 * Signatur, Zweck und Mindestdauer – Bots, die sofort absenden oder Formulare wiederverwenden, fallen auf.
 */
export function signStamp(purpose: string, now = new Date(), secret = stampSecret(), nonce = randomBytes(8).toString("hex")): string {
  // GATE-4c: mit Zufallsteil (mitsigniert), damit der Aufrufer jeden Stempel nur einmal gelten lassen kann
  const t = now.getTime().toString(36);
  const mac = createHmac("sha256", secret).update(`${purpose}\0${t}\0${nonce}`).digest("base64url").slice(0, 32);
  return `${t}.${nonce}.${mac}`;
}

export type StampCheck = "ok" | "zu-frueh" | "abgelaufen" | "ungueltig";

export function checkStamp(
  stamp: unknown,
  purpose: string,
  now = new Date(),
  opts: { minMs: number; maxMs: number } = { minMs: 5_000, maxMs: 12 * 3_600_000 },
  secret = stampSecret(),
): StampCheck {
  if (typeof stamp !== "string" || stamp.length > 80) return "ungueltig";
  const [t, nonce, mac, ...rest] = stamp.split(".");
  if (!t || !nonce || !mac || rest.length || !/^[0-9a-z]{1,12}$/.test(t) || !/^[0-9a-f]{16}$/.test(nonce)) return "ungueltig";
  const expected = createHmac("sha256", secret).update(`${purpose}\0${t}\0${nonce}`).digest("base64url").slice(0, 32);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "ungueltig";
  const age = now.getTime() - parseInt(t, 36);
  if (age < opts.minMs) return "zu-frueh";
  if (age > opts.maxMs) return "abgelaufen";
  return "ok";
}

/**
 * Führt `fn` aus und wartet danach, bis mindestens `minMs` vergangen sind – Antworten öffentlicher Abläufe dauern so gleich
 * lang, egal ob es eine Adresse/einen Vorgang gibt, ob eine Mail rausging oder ob ein Limit griff.
 */
export async function withMinDuration<R>(minMs: number, fn: () => Promise<R>, clock: () => number = Date.now): Promise<R> {
  const started = clock();
  try {
    return await fn();
  } finally {
    const wait = minMs - (clock() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}
