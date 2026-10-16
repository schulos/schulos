/**
 * Vorübergehende Sperre bei Fehlversuchen (B-10, DATENSCHUTZ.md §5 „Brute-Force“).
 * Reine Regeln, gemeinsam für SchulOS und SchulOS Backup; die Zähler in der DB und den Better-Auth-Hook hat jede App selbst.
 */
export const THROTTLE = {
  /** Fenster, in dem Fehlversuche zählen */
  windowMinutes: 15,
  /** Dauer der Sperre */
  lockMinutes: 15,
  /** je Benutzername (auch unbekannte – sonst verrät die Sperre, welche Konten es gibt) */
  maxPerUser: 5,
  /** je IP-Adresse (nur hinter einem Proxy, der X-Forwarded-For setzt) – wirkt nicht auf jede Anmeldung, s. `blockingLock` */
  maxPerIp: 30,
} as const;

export interface ThrottleState {
  failures: number;
  windowStartedAt: Date;
  lockedUntil: Date | null;
}

/** Rein: Zustand nach einem Fehlversuch. Neues Fenster, wenn das alte abgelaufen ist; bei Erreichen der Grenze gesperrt. */
export function afterFailure(prev: ThrottleState | undefined, max: number, now: Date): ThrottleState {
  const windowMs = THROTTLE.windowMinutes * 60_000;
  const fresh = !prev || now.getTime() - prev.windowStartedAt.getTime() > windowMs || (prev.lockedUntil !== null && prev.lockedUntil <= now);
  const failures = fresh ? 1 : prev.failures + 1;
  const windowStartedAt = fresh ? now : prev.windowStartedAt;
  const lockedUntil = failures >= max ? new Date(now.getTime() + THROTTLE.lockMinutes * 60_000) : null;
  return { failures, windowStartedAt, lockedUntil };
}

export function isLocked(state: Pick<ThrottleState, "lockedUntil"> | undefined, now: Date): boolean {
  return Boolean(state?.lockedUntil && state.lockedUntil > now);
}

/** Hat dieser Zähler im laufenden Fenster schon Fehlversuche (und ist nicht gerade aus einer abgelaufenen Sperre)? */
export function hasRecentFailures(state: ThrottleState | undefined, now: Date): boolean {
  if (!state || state.failures <= 0) return false;
  if (state.lockedUntil && state.lockedUntil <= now) return false;
  return now.getTime() - state.windowStartedAt.getTime() <= THROTTLE.windowMinutes * 60_000;
}

/**
 * Welche Sperre steht dieser Anmeldung entgegen (Ende der Sperre) – oder null (SEC-04).
 *
 * - Sperre des Benutzernamens: immer (5 Fehlversuche je Konto, bekannte Abwägung – gezieltes Aussperren eines Kontos geht).
 * - Sperre der IP-Adresse: NUR für unbekannte Benutzernamen und für Konten, die im laufenden Fenster schon Fehlversuche
 *   haben. Vorher sperrte sie jede Anmeldung von der Adresse – hinter einer gemeinsamen NAT-Adresse (Schul-WLAN,
 *   Mobilfunk-CGNAT) konnte so eine Person mit 30 Anfragen die ganze Schule aussperren. Jetzt kommt, wer sein Passwort
 *   beim ersten Versuch richtig eingibt, auch während einer IP-Sperre an. Ein Angreifer hinter der Adresse bekommt dann
 *   je Konto höchstens einen Versuch pro Fenster (danach hat das Konto Fehlversuche) – und das gezielte Aussperren
 *   einzelner Konten kann er ohnehin schon über die Kontosperre.
 */
export function blockingLock(user: ThrottleState | undefined, ip: ThrottleState | undefined, accountExists: boolean, now: Date): Date | null {
  const until: Date[] = [];
  if (isLocked(user, now)) until.push(user!.lockedUntil!);
  if (isLocked(ip, now) && (!accountExists || hasRecentFailures(user, now))) until.push(ip!.lockedUntil!);
  return until.length ? new Date(Math.max(...until.map((d) => d.getTime()))) : null;
}

// ---------- Allgemeine Zähler (P4-31: öffentliche Formulare, Token-Prüfungen, Meldungen) ----------

/** Regel: höchstens `max` Vorgänge je Fenster; danach gesperrt bis Fensterende bzw. `lockMinutes` ab dem letzten Versuch. */
export interface RateRule {
  max: number;
  windowMinutes: number;
  /** ohne Angabe: gesperrt bis zum Ende des Fensters */
  lockMinutes?: number;
}

export interface RateState {
  count: number;
  windowStartedAt: Date;
  blockedUntil: Date | null;
}

/** Ist das Fenster abgelaufen (und keine Sperre mehr aktiv)? Dann beginnt der nächste Vorgang ein neues. */
export function rateWindowExpired(prev: RateState | undefined, rule: RateRule, now: Date): boolean {
  if (!prev) return true;
  const windowOver = now.getTime() - prev.windowStartedAt.getTime() >= rule.windowMinutes * 60_000;
  return windowOver && (prev.blockedUntil === null || prev.blockedUntil <= now);
}

/** Rein: Zustand nach einem Vorgang. Erlaubt ist er, solange der Zähler `max` nicht übersteigt. */
export function afterHit(prev: RateState | undefined, rule: RateRule, now: Date): RateState & { allowed: boolean } {
  const fresh = rateWindowExpired(prev, rule, now);
  const count = fresh ? 1 : prev!.count + 1;
  const windowStartedAt = fresh ? now : prev!.windowStartedAt;
  const over = count > rule.max;
  const blockedUntil = over
    ? new Date(rule.lockMinutes !== undefined ? now.getTime() + rule.lockMinutes * 60_000 : windowStartedAt.getTime() + rule.windowMinutes * 60_000)
    : null;
  return { count, windowStartedAt, blockedUntil, allowed: !over };
}

export const userKey = (username: string) => `u:${username.trim().toLowerCase()}`;
export const ipKey = (ip: string) => `ip:${ip}`;

/** Erste Adresse aus X-Forwarded-For bzw. X-Real-IP – ohne Proxy gibt es keine, dann zählt nur der Benutzername. */
export function clientIp(headers: Headers | undefined): string | null {
  const xff = headers?.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || headers?.get("x-real-ip")?.trim() || null;
}

const timeFmt = new Intl.DateTimeFormat("de-DE", { timeStyle: "short", timeZone: "Europe/Berlin" });

export function lockMessage(until: Date): string {
  return `Zu viele Fehlversuche. Die Anmeldung ist bis ${timeFmt.format(until)} Uhr gesperrt.`;
}
