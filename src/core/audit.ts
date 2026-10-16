import { and, eq, gte, isNull } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { auditLog } from "@/core/db/schema";

/** Schreibt einen Eintrag ins Audit-Log. `action` im Format "<modul>.<vorgang>", z. B. "verwaltung.user.lock". */
export async function audit(
  db: Db,
  actorId: string | null,
  action: string,
  target?: string | null,
  meta?: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({ actorId, action, target: target ?? null, meta: meta ?? null });
}

/** Lesezugriffe gleicher Art auf dasselbe Ziel innerhalb dieses Fensters werden nur einmal protokolliert. */
export const READ_DEDUP_MINUTES = 30;

/**
 * Protokolliert einen Lesezugriff auf sensible Daten (Klassenbuch, Fehlzeiten, Abwesenheiten; DS-08).
 * `action` im Format "lesen.<bereich>". Wiederholtes Blättern zählt innerhalb von 30 Minuten als ein Zugriff.
 */
export async function auditRead(
  db: Db,
  actorId: string,
  action: `lesen.${string}`,
  target: string | null,
  meta?: Record<string, unknown>,
  now = new Date(),
): Promise<boolean> {
  const since = new Date(now.getTime() - READ_DEDUP_MINUTES * 60_000);
  const [recent] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorId, actorId),
        eq(auditLog.action, action),
        target === null ? isNull(auditLog.target) : eq(auditLog.target, target),
        gte(auditLog.createdAt, since),
      ),
    )
    .limit(1);
  if (recent) return false;
  await db.insert(auditLog).values({ actorId, action, target, meta: meta ?? null, createdAt: now });
  return true;
}
