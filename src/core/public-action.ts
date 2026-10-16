// Server Actions und Seiten ohne Sitzung (P4-34): `publicAction()` statt `requireUser()`. Die Origin-Prüfung von Next für
// Server Actions bleibt; dazu kommen Modulsperre, die Client-IP (nur als gekürztes Subjekt für Rate-Limits, nie gespeichert)
// und eine Mindestdauer je Antwort (kein Aufzählen über die Antwortzeit).
//
// Nur für ausdrücklich öffentliche Abläufe verwenden – die Pfade stehen in `src/proxy.ts` (PUBLIC) und in SICHERHEIT.md.
import "server-only";
import { headers } from "next/headers";
import { moduleOn } from "@/core/modules/guard";
import { ForbiddenError } from "@/core/permissions";
import { withMinDuration } from "@/core/public-token";
import { clientIp, ipSubject } from "@/core/rate-limit";

export interface PublicContext {
  /** gekürztes Subjekt der Client-IP (IPv6 /64) bzw. „unbekannt“ ohne Proxy-Angabe – nur für Rate-Limits */
  ip: string;
  now: Date;
}

/** Mindestdauer öffentlicher Antworten */
export const PUBLIC_MIN_MS = 400;

/** IP der Anfrage (von Caddy in X-Forwarded-For gesetzt; ohne Proxy keine – dann teilen sich alle ein Kontingent). */
export async function publicIp(): Promise<string> {
  const raw = clientIp(await headers());
  return raw ? ipSubject(raw) : "unbekannt";
}

/**
 * Öffentlichen Ablauf ausführen: Modul muss eingeschaltet sein, keine Sitzung nötig, Antwort frühestens nach `minMs`.
 * Wirft bei ausgeschaltetem Modul (wie `moduleActions`).
 */
export async function publicAction<R>(moduleId: string, fn: (ctx: PublicContext) => Promise<R>, opts: { minMs?: number } = {}): Promise<R> {
  return withMinDuration(opts.minMs ?? PUBLIC_MIN_MS, async () => {
    if (!(await moduleOn(moduleId))) throw new ForbiddenError(`${moduleId} (Modul ausgeschaltet)`);
    return fn({ ip: await publicIp(), now: new Date() });
  });
}
