// Löschlauf (B-01, DATENSCHUTZ.md §3.7): wertet die Löschklassen aus den Manifesten aus, zeigt vorab, was gelöscht
// würde (Vorschau), löscht und schreibt ein Löschprotokoll mit Anzahlen. Löschsperren nehmen Personen/Gruppen aus.
import { and, desc, eq, gte, is, sql, type SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { audit } from "@/core/audit";
import * as schema from "@/core/db/schema";
import { groups, privacyDeletionRuns, privacyHolds, schoolYears, users } from "@/core/db/schema";
import { collectRetention, RETENTION_CLASSES, type RetentionClassId, type RetentionEntry } from "@/core/retention";
import type { FileStorage } from "@/core/files/storage";
import { readModuleSetting, type ModuleSettingDecl } from "@/core/modules/settings";
import { addDays } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { MODULES } from "@/modules";
import { sweepOrphanFiles } from "./dateispeicher";
// Schullogo-Dateien stehen in app_settings und melden sich beim Aufräumlauf per registerStorageKeySource an (P4-03)
import "@/core/school/logo";
import { deleteAccounts, planAccountDeletion, recordTables } from "./konto";
import { pseudonymizeAudit } from "./protokoll";
import { readPeriods } from "./fristen";

/** Spalten, über die eine Zeile einer Person gehört bzw. einer Gruppe – für Löschsperren. */
const PERSON_COLUMNS = [
  "user_id",
  "student_id",
  "teacher_id",
  "author_id",
  "sender_id",
  "created_by",
  "owner_id",
  "booked_by",
  "reported_by",
  "parent_id",
  "child_id",
  "substitute_id",
  "actor_id",
];
const GROUP_COLUMNS = ["group_id"];

/** Klassen, die der Löschlauf (noch) nicht selbst behandelt – mit Begründung. */
const HANDLED_ELSEWHERE: Partial<Record<RetentionClassId, string>> = {
  "LK-KONTO": "wird mit dem Konto gelöscht (Abgang + 90 Tage)",
  "LK-AKTE": "geht mit der Gruppe, sobald ihr Archivexport als übergeben bestätigt ist (Schuljahreswechsel)",
};

export interface PlanItem {
  owner: string;
  table: string;
  scope?: string;
  purpose: string;
  classId: RetentionClassId | null;
  status: "due" | "skipped";
  reason?: string;
  count: number;
  /** pseudonymize: Zeilen bleiben, Personenbezug wird ersetzt (Audit-Log); clear: nur `clear`-Spalten werden geleert */
  mode?: "pseudonymize" | "clear";
  /** bei mode „clear“: die zu leerenden Spalten */
  clear?: string[];
  /** nur intern: Bedingung für Zählen und Löschen */
  where?: SQL;
  /** nur intern (Konten): die zu löschenden Konten – gelöscht über `deleteAccounts` (DS-21) */
  userIds?: string[];
}

type ColumnTypes = Map<string, Map<string, string>>;

function columnTypes(): ColumnTypes {
  const out: ColumnTypes = new Map();
  for (const v of Object.values(schema) as unknown[]) {
    if (!is(v, PgTable)) continue;
    const cfg = getTableConfig(v);
    out.set(cfg.name, new Map(cfg.columns.map((c) => [c.name, c.columnType])));
  }
  return out;
}

const minusYears = (ymd: string, n: number) => `${Number(ymd.slice(0, 4)) - n}${ymd.slice(4)}`;
const id = (name: string) => sql.raw(`"${name.replace(/"/g, "")}"`);

/** Rein: Stichtag „Zeilen mit Startzeitpunkt vor diesem Tag sind fällig“ für zeitbasierte Klassen. */
export function cutoffFor(classId: RetentionClassId, todayYmd: string, endedYears: string[]): string | null {
  switch (classId) {
    case "LK-SESSION":
      return todayYmd;
    case "LK-90":
      return addDays(todayYmd, -90);
    case "LK-1J":
    case "LK-ENDE-1J":
      return minusYears(todayYmd, 1);
    case "LK-TERMIN":
      return minusYears(todayYmd, 2);
    case "LK-SJ": {
      // Ende des Schuljahres der Entstehung: alles bis zum Ende des letzten abgeschlossenen Schuljahres
      const last = endedYears
        .filter((e) => e < todayYmd)
        .sort()
        .at(-1);
      return last ? addDays(last, 1) : null;
    }
    case "LK-SJ-1J": {
      const last = endedYears
        .filter((e) => e < minusYears(todayYmd, 1))
        .sort()
        .at(-1);
      return last ? addDays(last, 1) : null;
    }
    default:
      return null;
  }
}

/** Grenze für Schuljahres-Verweise: Schuljahre, die vor diesem Tag geendet haben, sind fällig. */
function yearBoundFor(classId: RetentionClassId, todayYmd: string): string {
  return classId === "LK-SJ" ? todayYmd : minusYears(todayYmd, 1);
}

export async function activeHolds(db: Db, todayYmd: string) {
  return db
    .select({
      id: privacyHolds.id,
      userId: privacyHolds.userId,
      groupId: privacyHolds.groupId,
      reason: privacyHolds.reason,
      until: privacyHolds.until,
      userName: users.name,
      groupName: groups.name,
    })
    .from(privacyHolds)
    .leftJoin(users, eq(users.id, privacyHolds.userId))
    .leftJoin(groups, eq(groups.id, privacyHolds.groupId))
    .where(gte(privacyHolds.until, todayYmd))
    .orderBy(privacyHolds.until);
}

const moduleSetting = (key: string): ModuleSettingDecl | undefined => MODULES.flatMap((m) => m.settings ?? []).find((s) => s.key === key);

/** Vorschau: je deklarierter Tabelle, wie viele Zeilen heute fällig wären (bzw. warum sie ausgelassen wird). */
export async function planDeletion(db: Db, todayYmd: string, entries: readonly RetentionEntry[] = collectRetention(MODULES)): Promise<PlanItem[]> {
  const types = columnTypes();
  const [years, holds, periods] = await Promise.all([db.select({ endsOn: schoolYears.endsOn }).from(schoolYears), activeHolds(db, todayYmd), readPeriods(db, entries)]);
  const endedYears = years.map((y) => y.endsOn);
  const heldUsers = holds.map((h) => h.userId).filter((x): x is string => Boolean(x));
  const heldGroups = holds.map((h) => h.groupId).filter((x): x is string => Boolean(x));
  const out: PlanItem[] = [];
  for (const { owner, decl } of entries) {
    if ("follows" in decl) continue;
    const base = { owner, table: decl.table, scope: decl.scope, purpose: decl.purpose, classId: decl.class, count: 0 };
    const skip = (reason: string) => out.push({ ...base, status: "skipped", reason });
    if (decl.table === "users") {
      // Konten: Abgang + Karenz bzw. Antrag; Akte und Löschsperre halten das Konto (Konto-Lebenszyklus)
      const ids = (await planAccountDeletion(db, todayYmd, heldUsers)).filter((a) => !a.blocked).map((a) => a.id);
      out.push({
        ...base,
        scope: "Konten nach Abgang",
        status: "due",
        count: ids.length,
        userIds: ids,
        where: ids.length ? sql`id in (${sql.join(
          ids.map((u) => sql`${u}`),
          sql`, `,
        )})` : sql`false`,
      });
      continue;
    }
    if (HANDLED_ELSEWHERE[decl.class]) {
      skip(HANDLED_ELSEWHERE[decl.class]!);
      continue;
    }
    if (decl.table === "audit_log") {
      // Nachweis der Rechtmäßigkeit: nach Ablauf pseudonymisieren statt löschen (B-06); Sperren halten Klarnamen
      const cutoff = cutoffFor(decl.class, todayYmd, endedYears)!;
      const parts: SQL[] = [sql`created_at < ${cutoff}`, sql`pseudonymized_at is null`];
      if (heldUsers.length) {
        const list = sql.join(
          heldUsers.map((u) => sql`${u}`),
          sql`, `,
        );
        parts.push(sql`(actor_id is null or actor_id not in (${list}))`, sql`(target is null or target not in (${list}))`);
      }
      const where = sql.join(parts, sql` and `);
      const res = await db.execute(sql`select count(*)::int as n from audit_log where ${where}`);
      const n = rowsOf<{ n: number }>(res)[0]?.n ?? 0;
      out.push({ ...base, scope: "pseudonymisieren", status: "due", mode: "pseudonymize", count: Number(n), where });
      continue;
    }
    if (decl.scope && !decl.where) {
      skip("Teilmenge ohne eigene Löschregel");
      continue;
    }
    const cols = types.get(decl.table);
    const startType = cols?.get(decl.start);
    if (!cols || !startType) {
      skip("Tabelle oder Spalte unbekannt");
      continue;
    }
    const parts: SQL[] = [];
    if (decl.start === "school_year_id") {
      parts.push(sql`${id(decl.start)} in (select id from school_years where ends_on < ${yearBoundFor(decl.class, todayYmd)})`);
    } else if (startType === "PgTimestamp" || startType === "PgDate" || startType === "PgTimestampString" || startType === "PgDateString") {
      // DS-15: von der Schule eingestellte Frist (Tage, innerhalb der Klassengrenzen) statt der Regelfrist
      const days = decl.period ? periods.get(decl.period) : undefined;
      const cutoff = days ? addDays(todayYmd, -days) : cutoffFor(decl.class, todayYmd, endedYears);
      if (!cutoff) {
        skip("noch kein abgeschlossenes Schuljahr");
        continue;
      }
      const col = decl.fallback ? sql`coalesce(${id(decl.start)}, ${id(decl.fallback)})` : id(decl.start);
      parts.push(sql`${col} < ${cutoff}`);
    } else {
      skip(`Startspalte „${decl.start}“ ist kein Zeitpunkt`);
      continue;
    }
    let cond = decl.where;
    if (cond && decl.setting) {
      // Q5-26: Wert der Moduleinstellung einsetzen (nur Zahlen – die Optionen stehen fest im Manifest)
      const st = moduleSetting(decl.setting);
      const value = st ? await readModuleSetting(db, st) : null;
      if (!value || !/^\d+$/.test(value)) {
        skip(`Einstellung „${decl.setting}“ unbekannt`);
        continue;
      }
      cond = cond.replaceAll("{setting}", value);
    }
    const condPart = cond ? sql.raw(`(${cond})`) : null;
    if (condPart) parts.push(condPart);
    // Löschsperren: Zeilen gesperrter Personen/Gruppen bleiben
    const personCols = [...PERSON_COLUMNS.filter((c) => cols.has(c)), ...(decl.table === "users" ? ["id"] : [])];
    const groupCols = [...GROUP_COLUMNS.filter((c) => cols.has(c)), ...(decl.table === "groups" ? ["id"] : [])];
    if (heldUsers.length)
      for (const c of personCols)
        parts.push(
          sql`(${id(c)} is null or ${id(c)} not in (${sql.join(
            heldUsers.map((u) => sql`${u}`),
            sql`, `,
          )}))`,
        );
    if (heldGroups.length)
      for (const c of groupCols)
        parts.push(
          sql`(${id(c)} is null or ${id(c)} not in (${sql.join(
            heldGroups.map((g) => sql`${g}`),
            sql`, `,
          )}))`,
        );
    if (decl.table === "groups") {
      // Die Akte (Klassenbuch) hängt per Kaskade an der Gruppe: erst löschen, wenn ihr Archivexport übergeben ist (§3.6)
      for (const t of recordTables())
        if (types.get(t)?.has("group_id"))
          parts.push(
            sql`(id not in (select group_id from ${id(t)} where group_id is not null) or id in (select group_id from record_archives where handed_over_at is not null and group_id is not null))`,
          );
    }
    const where = sql.join(parts, sql` and `);
    const res = await db.execute(sql`select count(*)::int as n from ${id(decl.table)} where ${where}`);
    const n = rowsOf<{ n: number }>(res)[0]?.n ?? 0;
    out.push({ ...base, status: "due", count: Number(n), where, ...(decl.clear?.length ? { mode: "clear" as const, clear: decl.clear } : {}) });
    if (cond && decl.held) {
      // G4D-S01: Frist abgelaufen, aber von der Bedingung zurückgehalten – als Hinweis zählen statt still aufzubewahren
      const heldWhere = sql.join([...parts.filter((x) => x !== condPart), sql.raw(`not (${cond})`)], sql` and `);
      const held = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from ${id(decl.table)} where ${heldWhere}`))[0]?.n ?? 0;
      if (Number(held)) out.push({ ...base, scope: "zurückgehalten", status: "skipped", count: Number(held), reason: `${held} ${decl.held}` });
    }
  }
  return out;
}

export interface RunResult {
  id: string;
  total: number;
  items: { table: string; scope?: string; deleted: number; error?: string }[];
}

/** Führt den Löschlauf aus (je Tabelle eine eigene Transaktion) und protokolliert die Anzahlen. */
export async function runDeletion(
  db: Db,
  actorId: string | null,
  todayYmd: string,
  opts: { storage?: FileStorage; now?: Date } = {},
): Promise<RunResult> {
  const plan = await planDeletion(db, todayYmd);
  const items: RunResult["items"] = [];
  for (const p of plan) {
    if (p.status !== "due" || !p.count || !p.where) continue;
    try {
      if (p.mode === "pseudonymize") {
        items.push({ table: p.table, scope: p.scope, deleted: await pseudonymizeAudit(db, p.where) });
        continue;
      }
      if (p.mode === "clear" && p.clear?.length) {
        const set = sql.join(
          p.clear.map((c) => sql`${id(c)} = null`),
          sql`, `,
        );
        const cleared = await db.transaction(async (tx) => tx.execute(sql`update ${id(p.table)} set ${set} where ${p.where!} returning 1`));
        items.push({ table: p.table, scope: p.scope, deleted: rowsOf<unknown>(cleared).length });
        continue;
      }
      if (p.userIds) {
        // DS-21: Konten nur über die gemeinsame Kontolöschung – Verweise ohne Fremdschlüssel, Solver-Läufe, Audit-Log sofort pseudonymisiert
        items.push({ table: p.table, scope: p.scope, deleted: await deleteAccounts(db, p.userIds) });
        continue;
      }
      const res = await db.transaction(async (tx) => tx.execute(sql`delete from ${id(p.table)} where ${p.where!} returning 1`));
      items.push({ table: p.table, scope: p.scope, deleted: rowsOf<unknown>(res).length });
    } catch (err) {
      items.push({ table: p.table, scope: p.scope, deleted: 0, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  }
  // Dateispeicher: Dateien, auf die kein Datensatz mehr verweist (gelöschte Abgaben, Ordner, Konten)
  if (opts.storage) {
    try {
      const removed = await sweepOrphanFiles(db, opts.storage, opts.now ?? new Date());
      if (removed) items.push({ table: "Dateispeicher", deleted: removed });
    } catch (err) {
      items.push({ table: "Dateispeicher", deleted: 0, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  }
  const total = items.reduce((s, i) => s + i.deleted, 0);
  const [row] = await db
    .insert(privacyDeletionRuns)
    .values({ triggeredBy: actorId, result: items, total, finishedAt: new Date() })
    .returning({ id: privacyDeletionRuns.id });
  if (actorId) await audit(db, actorId, "datenschutz.loeschlauf", null, { run: row!.id, total });
  return { id: row!.id, total, items };
}

export async function listRuns(db: Db, limit = 10) {
  return db.select().from(privacyDeletionRuns).orderBy(desc(privacyDeletionRuns.startedAt)).limit(limit);
}

// ---------------------------------------------------------------- Löschsperren

export interface HoldInput {
  userId: string | null;
  groupId: string | null;
  reason: string;
  until: string;
}

export async function createHold(db: Db, actorId: string, input: HoldInput, todayYmd: string): Promise<string> {
  const fe: Record<string, string> = {};
  if (Boolean(input.userId) === Boolean(input.groupId)) fe.target = "Person oder Gruppe wählen";
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 200) fe.reason = "Begründung mit 5 bis 200 Zeichen";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.until) || input.until < todayYmd) fe.until = "Ende der Sperre angeben (heute oder später)";
  else if (input.until > minusYears(todayYmd, -3)) fe.until = "höchstens 3 Jahre – danach neu begründen";
  if (input.userId && !(await db.select({ id: users.id }).from(users).where(eq(users.id, input.userId))).length) fe.target = "Person gibt es nicht";
  if (input.groupId && !(await db.select({ id: groups.id }).from(groups).where(eq(groups.id, input.groupId))).length) fe.target = "Gruppe gibt es nicht";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const [row] = await db
    .insert(privacyHolds)
    .values({ userId: input.userId, groupId: input.groupId, reason, until: input.until, createdBy: actorId })
    .returning({ id: privacyHolds.id });
  await audit(db, actorId, "datenschutz.sperre.anlegen", input.userId ?? input.groupId, { until: input.until });
  return row!.id;
}

export async function endHold(db: Db, actorId: string, holdId: string): Promise<void> {
  const [old] = await db
    .delete(privacyHolds)
    .where(and(eq(privacyHolds.id, holdId)))
    .returning();
  if (old) await audit(db, actorId, "datenschutz.sperre.aufheben", old.userId ?? old.groupId, {});
}

export const CLASS_LABEL = (c: RetentionClassId | null) => (c ? RETENTION_CLASSES[c].label : "–");
