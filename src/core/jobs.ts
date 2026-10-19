// Hintergrundjobs im App-Prozess (B-17): zeitgesteuerte Läufe (Löschlauf nachts) und eine Sperre gegen
// Doppelläufe über die Datenbank – hält auch, wenn zwei App-Prozesse dieselbe Datenbank nutzen (z. B. beim Update).
import { hostname } from "node:os";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { systemJobs } from "@/core/db/schema";
import { fromBerlinLocal, toBerlinDate, toBerlinLocal } from "@/core/time";

export interface JobRunResult<T> {
  ran: boolean;
  result?: T;
  error?: string;
}

const owner = () => `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;

/**
 * Sperre holen: gelingt nur, wenn keine gültige Sperre besteht – und, falls `notStartedSince` gesetzt ist,
 * der letzte Start davor lag (sonst liefe ein Nachtjob in zwei Prozessen nacheinander doppelt).
 */
export async function tryAcquire(db: Db, name: string, who: string, ttlMs: number, now: Date, notStartedSince?: Date): Promise<boolean> {
  await db.insert(systemJobs).values({ name }).onConflictDoNothing();
  const conds = [eq(systemJobs.name, name), or(isNull(systemJobs.lockedUntil), lt(systemJobs.lockedUntil, now))];
  if (notStartedSince) conds.push(or(isNull(systemJobs.lastStartedAt), lt(systemJobs.lastStartedAt, notStartedSince)));
  const rows = await db
    .update(systemJobs)
    .set({ lockedUntil: new Date(now.getTime() + ttlMs), lockedBy: who, lastStartedAt: now })
    .where(and(...conds))
    .returning({ name: systemJobs.name });
  return rows.length === 1;
}

async function release(db: Db, name: string, who: string, status: "ok" | "failed", error: string | null) {
  await db
    .update(systemJobs)
    .set({ lockedUntil: null, lockedBy: null, lastFinishedAt: new Date(), lastStatus: status, lastError: error })
    .where(and(eq(systemJobs.name, name), eq(systemJobs.lockedBy, who)));
}

/**
 * Sperre verlängern (Heartbeat, SP-06): nur der eigene Halter kann das; liefert false, wenn die Sperre inzwischen jemand
 * anderem gehört (abgelaufen und neu vergeben) – der Aufrufer sollte dann aufhören.
 */
export async function extendLock(db: Db, name: string, who: string, ttlMs: number, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(systemJobs)
    .set({ lockedUntil: new Date(now.getTime() + ttlMs) })
    .where(and(eq(systemJobs.name, name), eq(systemJobs.lockedBy, who)))
    .returning({ name: systemJobs.name });
  return rows.length === 1;
}

export interface HeldLock {
  /** Sperre um `ttlMs` (Vorgabe: die TTL des Laufs) ab jetzt verlängern; false = Sperre verloren */
  extend: (ttlMs?: number) => Promise<boolean>;
}

/** Führt `fn` unter der Sperre `name` aus; läuft schon ein Lauf, passiert nichts (`ran: false`). Lange Läufe verlängern die Sperre über `lock.extend()`. */
export async function runExclusive<T>(
  db: Db,
  name: string,
  fn: (lock: HeldLock) => Promise<T>,
  opts: { ttlMs?: number; now?: Date; notStartedSince?: Date } = {},
): Promise<JobRunResult<T>> {
  const who = owner();
  const ttlMs = opts.ttlMs ?? 30 * 60_000;
  if (!(await tryAcquire(db, name, who, ttlMs, opts.now ?? new Date(), opts.notStartedSince))) return { ran: false };
  try {
    const result = await fn({ extend: (ms = ttlMs) => extendLock(db, name, who, ms) });
    await release(db, name, who, "ok", null);
    return { ran: true, result };
  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 500) : String(err);
    await release(db, name, who, "failed", error);
    return { ran: true, error };
  }
}

export interface ScheduledJob {
  name: string;
  /** täglich ab dieser Berliner Uhrzeit („02:30“) … */
  at: string;
  /** … bis höchstens zu dieser Uhrzeit (verpasste Fenster werden nicht tagsüber nachgeholt) */
  until: string;
  ttlMs: number;
  run: (db: Db, now: Date) => Promise<unknown>;
}

/**
 * Liegt `now` im Fenster, gibt es Mitternacht (Berlin) dieses Tages zurück – der Job läuft, wenn er seitdem
 * noch nicht gestartet wurde (einmal je Kalendertag, auch in der doppelten Stunde der Zeitumstellung). Sonst null.
 */
export function dueWindow(job: Pick<ScheduledJob, "at" | "until">, now: Date): Date | null {
  const hm = toBerlinLocal(now).slice(11);
  if (hm < job.at || hm >= job.until) return null;
  return fromBerlinLocal(toBerlinDate(now));
}

/** Ein Takt: startet fällige Jobs nacheinander (die Sperre verhindert Doppelläufe auch über Prozesse hinweg). */
export async function tick(db: Db, jobs: readonly ScheduledJob[], now = new Date()): Promise<{ name: string; ran: boolean; error?: string }[]> {
  const out: { name: string; ran: boolean; error?: string }[] = [];
  for (const job of jobs) {
    const window = dueWindow(job, now);
    if (!window) continue;
    const r = await runExclusive(db, job.name, () => job.run(db, now), { ttlMs: job.ttlMs, now, notStartedSince: window });
    if (r.ran) out.push({ name: job.name, ran: true, ...(r.error ? { error: r.error } : {}) });
  }
  return out;
}

/** Jobs laufen im Container (SCHULOS_INSTANCE gesetzt) oder mit SCHULOS_JOBS=1; SCHULOS_JOBS=0 schaltet sie ab. */
export function jobsEnabled(env: Record<string, string | undefined>): boolean {
  if (env.SCHULOS_JOBS === "0") return false;
  return env.SCHULOS_JOBS === "1" || Boolean(env.SCHULOS_INSTANCE?.trim());
}

export async function listJobs(db: Db) {
  return db.select().from(systemJobs).orderBy(systemJobs.name);
}
