// Audit-Log mit Frist (B-06, DATENSCHUTZ.md §3.4 / DS-08): Einträge älter als ein Jahr – und alle Einträge eines
// gelöschten Kontos – werden pseudonymisiert statt gelöscht. Konto-IDs (u-<benutzername>, also sprechend) werden
// durch ein stabiles Pseudonym ersetzt (HMAC mit einem Geheimnis der Instanz): Zusammenhänge bleiben erkennbar
// („dieselbe Person hat A und B getan“), der Name nicht.
import { createHmac, randomBytes } from "node:crypto";
import { eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { appSettings, auditLog, users } from "@/core/db/schema";

const PEPPER_KEY = "privacy.audit_pepper";
const BATCH = 500;

/** Geheimnis für die Pseudonyme; wird beim ersten Bedarf erzeugt und nie angezeigt. */
export async function auditPepper(db: Db): Promise<string> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, PEPPER_KEY));
  if (typeof row?.value === "string") return row.value;
  await db.insert(appSettings).values({ key: PEPPER_KEY, value: randomBytes(32).toString("hex") }).onConflictDoNothing();
  const [again] = await db.select().from(appSettings).where(eq(appSettings.key, PEPPER_KEY));
  return again!.value as string;
}

/** Rein: stabiles Pseudonym einer Konto-ID. */
export function pseudonymOf(pepper: string, userId: string): string {
  return `P-${createHmac("sha256", pepper).update(userId).digest("hex").slice(0, 10)}`;
}

export const isPseudonym = (s: string | null | undefined): boolean => /^P-[0-9a-f]{10}$/.test(s ?? "");

/** Schlüssel in `meta`, die Klarnamen tragen könnten – fallen beim Pseudonymisieren weg, wenn das Ziel eine Person ist. */
const NAME_KEYS = new Set(["name", "username", "email", "firstName", "lastName"]);

export interface AuditRowIn {
  actorId: string | null;
  actorPseudonym: string | null;
  target: string | null;
  meta: unknown;
}

/** Rein: pseudonymisiert einen Eintrag. `isUser` erkennt Konto-IDs (auch bereits gelöschter Konten). */
export function pseudonymizeRow(row: AuditRowIn, pseudo: (userId: string) => string, isUser: (s: string) => boolean) {
  const swap = (v: unknown): unknown => {
    if (typeof v === "string") return isUser(v) ? pseudo(v) : v;
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  const targetIsUser = Boolean(row.target && isUser(row.target));
  let meta = swap(row.meta);
  if (targetIsUser && meta && typeof meta === "object" && !Array.isArray(meta))
    meta = Object.fromEntries(Object.entries(meta).filter(([k]) => !NAME_KEYS.has(k)));
  return {
    actorId: null,
    actorPseudonym: row.actorId ? pseudo(row.actorId) : row.actorPseudonym,
    target: row.target && targetIsUser ? pseudo(row.target) : row.target,
    meta,
  };
}

/** Konto-IDs sind „u-<benutzername>“; dazu alle bestehenden IDs (falls je anders vergeben). */
async function userMatcher(db: Db): Promise<(s: string) => boolean> {
  const ids = new Set((await db.select({ id: users.id }).from(users)).map((u) => u.id));
  return (s) => !isPseudonym(s) && (s.startsWith("u-") || ids.has(s));
}

/** Pseudonymisiert alle noch nicht pseudonymisierten Einträge, auf die `where` zutrifft. Gibt die Anzahl zurück. */
export async function pseudonymizeAudit(db: Db, where: SQL, now = new Date()): Promise<number> {
  const pepper = await auditPepper(db);
  const isUser = await userMatcher(db);
  const pseudo = (u: string) => pseudonymOf(pepper, u);
  let total = 0;
  for (;;) {
    const rows = await db
      .select({ id: auditLog.id, actorId: auditLog.actorId, actorPseudonym: auditLog.actorPseudonym, target: auditLog.target, meta: auditLog.meta })
      .from(auditLog)
      .where(sql`${auditLog.pseudonymizedAt} is null and (${where})`)
      .orderBy(auditLog.id)
      .limit(BATCH);
    if (!rows.length) return total;
    await db.transaction(async (tx) => {
      for (const r of rows) {
        const p = pseudonymizeRow(r, pseudo, isUser);
        await tx.update(auditLog).set({ ...p, pseudonymizedAt: now }).where(eq(auditLog.id, r.id));
      }
    });
    total += rows.length;
  }
}

/** Alle Einträge, die eine der Personen betreffen oder von ihr stammen – vor der Kontolöschung. */
export function auditOfUsers(ids: readonly string[]): SQL {
  const list = sql.join(
    ids.map((u) => sql`${u}`),
    sql`, `,
  );
  // auch Erwähnungen in meta (userId, userIds, follows …) – als JSON-String in Anführungszeichen
  const inMeta = sql.join(
    ids.map((u) => sql`strpos(${auditLog.meta}::text, ${JSON.stringify(u)}) > 0`),
    sql` or `,
  );
  return sql`(${auditLog.actorId} in (${list}) or ${auditLog.target} in (${list}) or ${inMeta})`;
}
