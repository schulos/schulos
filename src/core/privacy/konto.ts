// Konto-Lebenszyklus (B-02, DATENSCHUTZ.md §3.3 LK-KONTO): aktiv → gesperrt mit Abgang → gelöscht nach der Karenz.
// Elternkonten folgen den Kindern. Konten, auf die noch eine Akte im Live-System verweist (Klassenbuch), bleiben
// gesperrt stehen, bis die Akte archiviert und abgelaufen ist – sonst nähme das Löschen die Akte mit.
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { audit } from "@/core/audit";
import * as schema from "@/core/db/schema";
import { parentChild, privacyDeletionRuns, sessions, users, type Role } from "@/core/db/schema";
import { collectRetention, type RetentionEntry } from "@/core/retention";
import type { FileStorage } from "@/core/files/storage";
import { addDays } from "@/core/time";
import { endLiveStreams } from "@/core/notifications/bus";
import { assertMayManage, loadActor } from "@/modules/verwaltung/escalation";
import { ValidationError } from "@/modules/verwaltung/users";
import { MODULES } from "@/modules";
import { sweepOrphanFiles } from "./dateispeicher";
import { readModuleSetting } from "@/core/modules/settings";
import { ACCOUNT_GRACE } from "@/modules/verwaltung/settings";
import { validPeriod } from "./fristen";
// Schullogo-Dateien stehen in app_settings und melden sich beim Aufräumlauf per registerStorageKeySource an (P4-03)
import "@/core/school/logo";
import { auditOfUsers, pseudonymizeAudit } from "./protokoll";
import { qid, refWhere, SOFT_REFS, userRefs, type UserRef } from "./refs";
import { de } from "@/core/db/sort";
import { scrubSolverRuns } from "@/modules/stundenplan/solverlauf-konto";

/** Karenz zwischen Abgang und Löschung (Rückfragen, Eigenexport) – Vorgabe; die Schule stellt sie ein (DS-15, 30–365 Tage). */
export const ACCOUNT_GRACE_DAYS = 90;

/** Wirksame Karenz in Tagen (Moduleinstellung `verwaltung.account_grace`, nur innerhalb der Grenzen von LK-KONTO). */
export async function accountGraceDays(db: Db): Promise<number> {
  return validPeriod("LK-KONTO", await readModuleSetting(db, ACCOUNT_GRACE)) ?? ACCOUNT_GRACE_DAYS;
}

const ymd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// ------------------------------------------------------------------ Abgang / Reaktivieren

/**
 * Trägt den Abgang ein: Konto gesperrt, Sitzungen beendet. Bei Schüler:innen folgen Elternkonten, die danach kein
 * aktives Kind mehr haben (Kontoende = Abgang des letzten Kindes).
 */
export async function setAccountLeft(db: Db, actorId: string, userId: string, leftOn: string): Promise<{ parentsLocked: string[] }> {
  if (userId === actorId) throw new ValidationError({ leftOn: "Du kannst für dich selbst keinen Abgang eintragen" });
  if (!ymd(leftOn)) throw new ValidationError({ leftOn: "Abgangsdatum angeben" });
  const [u] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId));
  if (!u) throw new ValidationError({ leftOn: "Konto gibt es nicht" });
  await assertMayManage(db, await loadActor(db, actorId), userId, "leftOn"); // SEC-04
  await db.update(users).set({ status: "locked", leftOn }).where(eq(users.id, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  endLiveStreams(userId);
  await audit(db, actorId, "verwaltung.user.left", userId, { leftOn });
  const parentsLocked: string[] = [];
  for (const p of await parentsOf(db, userId)) {
    const kids = await db
      .select({ status: users.status, leftOn: users.leftOn })
      .from(parentChild)
      .innerJoin(users, eq(users.id, parentChild.childId))
      .where(eq(parentChild.parentId, p.id));
    if (kids.some((k) => k.status === "active" || !k.leftOn)) continue;
    if (p.leftOn) continue; // schon abgegangen
    const last = kids.map((k) => k.leftOn!).sort().at(-1)!;
    await db.update(users).set({ status: "locked", leftOn: last }).where(eq(users.id, p.id));
    await db.delete(sessions).where(eq(sessions.userId, p.id));
    endLiveStreams(p.id);
    await audit(db, actorId, "verwaltung.user.left", p.id, { leftOn: last, follows: userId });
    parentsLocked.push(p.id);
  }
  return { parentsLocked };
}

/** Nimmt den Abgang zurück (Irrtum, Rückkehr). Elternkonten, die nur wegen des Kindes abgegangen sind, kommen mit. */
export async function reactivateAccount(db: Db, actorId: string, userId: string): Promise<void> {
  const [u] = await db.select({ leftOn: users.leftOn }).from(users).where(eq(users.id, userId));
  if (!u) throw new ValidationError({ leftOn: "Konto gibt es nicht" });
  await assertMayManage(db, await loadActor(db, actorId), userId, "leftOn"); // SEC-04
  await db.update(users).set({ status: "active", leftOn: null, erasureRequestedOn: null }).where(eq(users.id, userId));
  await audit(db, actorId, "verwaltung.user.reactivate", userId);
  if (!u.leftOn) return;
  for (const p of await parentsOf(db, userId)) {
    if (!p.leftOn || p.erasureRequestedOn) continue;
    await db.update(users).set({ status: "active", leftOn: null }).where(eq(users.id, p.id));
    await audit(db, actorId, "verwaltung.user.reactivate", p.id, { follows: userId });
  }
}

async function parentsOf(db: Db, childId: string) {
  return db
    .select({ id: users.id, leftOn: users.leftOn, erasureRequestedOn: users.erasureRequestedOn })
    .from(parentChild)
    .innerJoin(users, eq(users.id, parentChild.parentId))
    .where(eq(parentChild.childId, childId));
}

// ------------------------------------------------------------------ Wirkung einer Löschung

export type ImpactEffect = "deleted" | "anonymized" | "record";

export interface ImpactItem {
  table: string;
  purpose: string;
  effect: ImpactEffect;
  count: number;
}

/** Tabellen der Akte (LK-AKTE) einschließlich der Tabellen, die ihnen folgen. */
export function recordTables(entries: readonly RetentionEntry[] = collectRetention(MODULES)): Set<string> {
  const out = new Set(entries.filter((e) => !("follows" in e.decl) && e.decl.class === "LK-AKTE").map((e) => e.decl.table));
  let grew = true;
  while (grew) {
    grew = false;
    for (const { decl } of entries)
      if ("follows" in decl && out.has(decl.follows) && !out.has(decl.table)) {
        out.add(decl.table);
        grew = true;
      }
  }
  return out;
}

function purposes(entries: readonly RetentionEntry[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const { decl } of entries) if (!m.has(decl.table)) m.set(decl.table, decl.purpose);
  return m;
}

/**
 * Was eine Löschung des Kontos bewirkt – je Tabelle mit Verweis auf die Person:
 * gelöscht (Kaskade), bleibt ohne Namen (Verweis wird geleert) oder Akte (verhindert die Löschung vorerst).
 */
export async function accountErasureImpact(db: Db, userId: string): Promise<ImpactItem[]> {
  const entries = collectRetention(MODULES);
  const records = recordTables(entries);
  const purpose = purposes(entries);
  const out = new Map<string, ImpactItem>();
  for (const r of userRefs()) {
    if (r.table === "users" || r.onDelete === "keep") continue;
    const res = await db.execute(sql`select count(*)::int as n from ${qid(r.table)} where ${refWhere(r, userId)}`);
    const n = Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0);
    if (!n) continue;
    const effect: ImpactEffect = records.has(r.table) ? "record" : r.onDelete === "cascade" ? "deleted" : "anonymized";
    const key = `${r.table}:${effect}`;
    const prev = out.get(key);
    if (prev) prev.count += n;
    else out.set(key, { table: r.table, purpose: purpose.get(r.table) ?? r.table, effect, count: n });
  }
  return [...out.values()].sort((a, b) => a.effect.localeCompare(b.effect) || b.count - a.count);
}

// ------------------------------------------------------------------ Löschen

export interface AccountPlanItem {
  id: string;
  name: string;
  role: Role;
  leftOn: string;
  /** ab diesem Tag fällig */
  dueOn: string;
  erasureRequested: boolean;
  /** gesetzt = noch nicht löschbar, mit Grund */
  blocked?: string;
}

/** Konten mit Abgang: fällig (Karenz abgelaufen oder Antrag) bzw. blockiert (Akte, Löschsperre). Noch nicht fällige fehlen. */
export async function planAccountDeletion(db: Db, todayYmd: string, heldUsers: readonly string[] = []): Promise<AccountPlanItem[]> {
  const rows = await db
    .select({ id: users.id, name: users.name, role: users.role, leftOn: users.leftOn, erasureRequestedOn: users.erasureRequestedOn })
    .from(users)
    .where(and(eq(users.status, "locked"), isNotNull(users.leftOn)))
    .orderBy(users.leftOn, de(users.name));
  const records = recordTables();
  const refs = userRefs().filter((r) => records.has(r.table));
  const out: AccountPlanItem[] = [];
  const grace = await accountGraceDays(db);
  for (const r of rows) {
    const dueOn = r.erasureRequestedOn ?? addDays(r.leftOn!, grace);
    if (dueOn > todayYmd) continue;
    const item: AccountPlanItem = { id: r.id, name: r.name, role: r.role, leftOn: r.leftOn!, dueOn, erasureRequested: Boolean(r.erasureRequestedOn) };
    if (heldUsers.includes(r.id)) item.blocked = "Löschsperre";
    else {
      const n = await countRefs(db, refs, r.id);
      if (n) item.blocked = `Aktenpflicht: ${n} Einträge im Klassenbuch – bleibt gesperrt bis zum Archivexport`;
    }
    out.push(item);
  }
  return out;
}

async function countRefs(db: Db, refs: UserRef[], userId: string): Promise<number> {
  let total = 0;
  for (const r of refs) {
    const res = await db.execute(sql`select count(*)::int as n from ${qid(r.table)} where ${refWhere(r, userId)}`);
    total += Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0);
  }
  return total;
}

/**
 * Löschung auf Antrag (Art. 17): Konto sofort sperren, Antrag vermerken. Steht nichts entgegen, wird sofort gelöscht
 * (mit Eintrag im Löschprotokoll); sonst übernimmt der Löschlauf, sobald die Akte abgelaufen ist.
 */
export async function requestErasure(
  db: Db,
  actorId: string,
  userId: string,
  todayYmd: string,
  opts: { storage?: FileStorage } = {},
): Promise<{ deleted: boolean; blocked?: string }> {
  if (userId === actorId) throw new ValidationError({ erasure: "Das eigene Konto kann nicht gelöscht werden" });
  const [u] = await db.select({ role: users.role, leftOn: users.leftOn }).from(users).where(eq(users.id, userId));
  if (!u) throw new ValidationError({ erasure: "Konto gibt es nicht" });
  await assertMayManage(db, await loadActor(db, actorId), userId, "erasure"); // SEC-04
  if (u.role === "admin") {
    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.role, "admin"), eq(users.status, "active")))) as [
      { n: number },
    ];
    if (n <= 1) throw new ValidationError({ erasure: "Das letzte aktive Admin-Konto kann nicht gelöscht werden" });
  }
  await db
    .update(users)
    .set({ status: "locked", leftOn: u.leftOn ?? todayYmd, erasureRequestedOn: todayYmd })
    .where(eq(users.id, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  endLiveStreams(userId);
  await audit(db, actorId, "datenschutz.loeschantrag", userId);
  const [item] = (await planAccountDeletion(db, todayYmd, await heldUserIds(db, todayYmd))).filter((p) => p.id === userId);
  if (!item || item.blocked) return { deleted: false, blocked: item?.blocked };
  const deleted = await deleteAccounts(db, [userId]);
  const result: { table: string; scope?: string; deleted: number }[] = [{ table: "users", scope: "auf Antrag", deleted }];
  if (opts.storage) {
    const files = await sweepOrphanFiles(db, opts.storage, new Date());
    if (files) result.push({ table: "Dateispeicher", deleted: files });
  }
  const total = result.reduce((s, r) => s + r.deleted, 0);
  await db.insert(privacyDeletionRuns).values({ triggeredBy: actorId, result, total, finishedAt: new Date() });
  return { deleted: deleted > 0 };
}

async function heldUserIds(db: Db, todayYmd: string): Promise<string[]> {
  const rows = await db.select({ userId: schema.privacyHolds.userId }).from(schema.privacyHolds).where(sql`${schema.privacyHolds.until} >= ${todayYmd}`);
  return rows.map((r) => r.userId).filter((x): x is string => Boolean(x));
}

/**
 * Löscht Konten; alles mit Kaskade geht mit, Verweise mit „set null“ bleiben ohne Namen. **Einziger Weg, Konten zu löschen** –
 * Löschung auf Antrag und nächtlicher Löschlauf rufen beide diese Funktion (DS-21), damit die Bereinigung ohne Fremdschlüssel
 * (Zeitwünsche, Solver-Läufe) und die sofortige Pseudonymisierung des Audit-Logs nie fehlen. Alles in einer Transaktion.
 */
export async function deleteAccounts(db: Db, ids: readonly string[]): Promise<number> {
  if (!ids.length) return 0;
  // Verweise ohne Fremdschlüssel, die mit dem Konto gehen (z. B. Zeitwünsche einer Lehrkraft)
  const soft = SOFT_REFS.filter((r) => r.onDelete === "cascade");
  const res = await db.transaction(async (tx) => {
    // Audit-Log bleibt als Nachweis, aber ohne Klarnamen (sonst stünde dort nur noch „System“ bzw. die sprechende ID)
    await pseudonymizeAudit(tx, auditOfUsers(ids));
    for (const r of soft) for (const id of ids) await tx.execute(sql`delete from ${qid(r.table)} where ${refWhere(r, id)}`);
    // SP-14/DS-21: Lehrkraft-Kennungen und -Kürzel in Solver-Läufen (ohne Fremdschlüssel) → Platzhalter „gelöschte Lehrkraft“
    await scrubSolverRuns(tx, ids);
    return tx.delete(users).where(inArray(users.id, [...ids])).returning({ id: users.id });
  });
  return res.length;
}
