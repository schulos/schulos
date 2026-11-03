// GT-13 (Projektleitung 2026-11-03, hebt GANZTAG-Entscheidung 9 auf): externe Anbieter leiten ein Angebot mit einem befristeten
// Konto der Rolle `personal` – nur als Gruppenleitung der eigenen Gruppe, 2FA sofort Pflicht (`users.expires_on`, siehe
// core/permissions), Ablauf zum Angebotsende, Hinweis vor Ablauf, danach gesperrt (Abgang, Löschung nach der Karenz). Die Schule
// verpflichtet die Person auf Vertraulichkeit (Häkchen beim Anlegen). Zugang ohne Konto bleibt ausgeschlossen, Papierliste Fallback.
import { and, asc, eq, gte, isNull, lt, lte, max } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { ganztagExternalLeaders, ganztagSeries, groups, sessions, users } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { notify } from "@/core/notifications";
import { endLiveStreams } from "@/core/notifications/bus";
import { ForbiddenError, hasPermission, usersWithPermission, type PermissionSet } from "@/core/permissions";
import { addDays, isCalendarDate, toBerlinDate } from "@/core/time";
import { addMembers } from "@/modules/verwaltung/groups";
import { createUser, ValidationError } from "@/modules/verwaltung/users";
import { canManage, currentYear, loadOffer, MANAGE } from "./service";

/** Hinweis vor Ablauf: so viele Tage vorher (an die Person und an „Ganztag verwalten“) */
export const WARN_DAYS = 14;
export const MAX_PROVIDER = 80;
/** Befristung höchstens ein Jahr ab heute */
export const MAX_DAYS = 366;

/** Anlegen/Verlängern: „Ganztag verwalten“ **und** „Benutzer verwalten“ (Konten anlegen ist Verwaltungsrecht). */
export const canManageExternal = (p: PermissionSet) => canManage(p) && hasPermission(p, "verwaltung.users");

const fmt = (ymd: string) => ymd.split("-").reverse().join(".");

/** Vorgabe für das Ablaufdatum: Ende der letzten Serie des Angebots, sonst Schuljahresende, sonst in einem halben Jahr. */
export async function defaultExpiry(db: Db, groupId: string, today: string): Promise<string> {
  const [s] = await db.select({ to: max(ganztagSeries.validTo) }).from(ganztagSeries).where(eq(ganztagSeries.groupId, groupId));
  if (s?.to && s.to >= today) return s.to;
  const year = await currentYear(db, today);
  return year && year.endsOn >= today ? year.endsOn : addDays(today, 180);
}

export interface ExternalInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  provider: string;
  groupId: string;
  expiresOn: string;
  /** Verpflichtung auf Vertraulichkeit liegt der Schule vor */
  confidentiality: boolean;
}

function checkExpiry(expiresOn: string, today: string, errors: Record<string, string>) {
  if (!isCalendarDate(expiresOn)) errors.expiresOn = "Ablaufdatum angeben";
  else if (expiresOn < today) errors.expiresOn = "Das Ablaufdatum liegt in der Vergangenheit";
  else if (expiresOn > addDays(today, MAX_DAYS)) errors.expiresOn = "Höchstens ein Jahr – danach verlängern";
}

/**
 * Konto für eine externe Leitung anlegen: Rolle `personal`, befristet, Leitung genau dieses Angebots. Liefert Benutzername und
 * Startpasswort (einmal anzeigen, wie beim Anlegen in der Verwaltung).
 */
export async function createExternalLeader(db: Db, viewer: PermissionSet, input: ExternalInput, now = new Date()): Promise<{ userId: string; username: string; password: string }> {
  if (!canManageExternal(viewer)) throw new ForbiddenError(MANAGE);
  const today = toBerlinDate(now);
  const errors: Record<string, string> = {};
  const provider = input.provider.trim().replace(/\s+/g, " ");
  if (!provider) errors.provider = "Anbieter angeben (Verein, Musikschule …)";
  else if (provider.length > MAX_PROVIDER) errors.provider = `Höchstens ${MAX_PROVIDER} Zeichen`;
  checkExpiry(input.expiresOn, today, errors);
  if (!input.confidentiality) errors.confidentiality = "Ohne Verpflichtung auf Vertraulichkeit kein Konto – sonst Papierliste";
  const offer = await loadOffer(db, input.groupId);
  if (!offer) errors.groupId = "Angebot mit Anwesenheitsliste wählen";
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const created = await createUser(db, viewer.userId, { firstName: input.firstName, lastName: input.lastName, email: input.email ?? null, role: "personal" });
  await db.update(users).set({ expiresOn: input.expiresOn }).where(eq(users.id, created.id));
  await addMembers(db, viewer.userId, input.groupId, [created.id], "leader");
  await db.insert(ganztagExternalLeaders).values({ userId: created.id, groupId: input.groupId, provider, confidentialityAt: now, createdBy: viewer.userId, createdAt: now });
  await audit(db, viewer.userId, "ganztag.extern.create", created.id, { groupId: input.groupId, expiresOn: input.expiresOn });
  return { userId: created.id, username: created.username, password: created.password };
}

export interface ExternalRow {
  userId: string;
  name: string;
  username: string | null;
  provider: string;
  group: { id: string; name: string };
  expiresOn: string | null;
  /** aktiv, läuft bald ab (Hinweis verschickt), abgelaufen/gesperrt */
  state: "aktiv" | "bald" | "abgelaufen";
  twoFactor: boolean;
}

/** Übersicht der externen Leitungen (nur „Ganztag verwalten“ + „Benutzer verwalten“). */
export async function listExternalLeaders(db: Db, viewer: PermissionSet, now = new Date()): Promise<ExternalRow[]> {
  if (!canManageExternal(viewer)) throw new ForbiddenError(MANAGE);
  const today = toBerlinDate(now);
  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      username: users.username,
      status: users.status,
      expiresOn: users.expiresOn,
      twoFactor: users.twoFactorEnabled,
      provider: ganztagExternalLeaders.provider,
      groupId: groups.id,
      groupName: groups.name,
    })
    .from(ganztagExternalLeaders)
    .innerJoin(users, eq(users.id, ganztagExternalLeaders.userId))
    .innerJoin(groups, eq(groups.id, ganztagExternalLeaders.groupId))
    .orderBy(asc(users.expiresOn), de(users.lastName), de(users.firstName));
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    username: r.username,
    provider: r.provider,
    group: { id: r.groupId, name: r.groupName },
    expiresOn: r.expiresOn,
    twoFactor: r.twoFactor,
    state: r.status === "locked" || (r.expiresOn !== null && r.expiresOn < today) ? "abgelaufen" : r.expiresOn !== null && r.expiresOn <= addDays(today, WARN_DAYS) ? "bald" : "aktiv",
  }));
}

/** Befristung verlängern (auch nach Ablauf: das Konto wird wieder aktiv, der Abgang zurückgenommen). */
export async function extendExternal(db: Db, viewer: PermissionSet, userId: string, expiresOn: string, now = new Date()): Promise<void> {
  if (!canManageExternal(viewer)) throw new ForbiddenError(MANAGE);
  const errors: Record<string, string> = {};
  checkExpiry(expiresOn, toBerlinDate(now), errors);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const [row] = await db
    .select({ leftOn: users.leftOn, expiresOn: users.expiresOn, erasure: users.erasureRequestedOn })
    .from(ganztagExternalLeaders)
    .innerJoin(users, eq(users.id, ganztagExternalLeaders.userId))
    .where(eq(ganztagExternalLeaders.userId, userId));
  if (!row) throw new ValidationError({ userId: "Keine externe Leitung" });
  if (row.erasure) throw new ValidationError({ expiresOn: "Für dieses Konto ist die Löschung beantragt" });
  // nur den Abgang zurücknehmen, den der Ablauf gesetzt hat
  const reopen = row.leftOn !== null && row.leftOn === row.expiresOn;
  await db
    .update(users)
    .set({ expiresOn, ...(reopen ? { status: "active" as const, leftOn: null } : {}) })
    .where(eq(users.id, userId));
  await db.update(ganztagExternalLeaders).set({ warnedAt: null }).where(eq(ganztagExternalLeaders.userId, userId));
  await audit(db, viewer.userId, "ganztag.extern.extend", userId, { expiresOn, reopened: reopen });
}

async function lockExpired(db: Db, userId: string, expiresOn: string) {
  await db.update(users).set({ status: "locked", leftOn: expiresOn }).where(eq(users.id, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  endLiveStreams(userId);
  await audit(db, null, "ganztag.extern.expired", userId, { expiresOn });
}

/** Zugang sofort beenden (z. B. Angebot vorzeitig zu Ende): Ablauf gestern, Konto gesperrt. */
export async function endExternal(db: Db, viewer: PermissionSet, userId: string, now = new Date()): Promise<void> {
  if (!canManageExternal(viewer)) throw new ForbiddenError(MANAGE);
  const [row] = await db.select({ id: ganztagExternalLeaders.userId }).from(ganztagExternalLeaders).where(eq(ganztagExternalLeaders.userId, userId));
  if (!row) throw new ValidationError({ userId: "Keine externe Leitung" });
  const yesterday = addDays(toBerlinDate(now), -1);
  await db.update(users).set({ expiresOn: yesterday }).where(eq(users.id, userId));
  await lockExpired(db, userId, yesterday);
  await audit(db, viewer.userId, "ganztag.extern.end", userId);
}

/**
 * Tageslauf (Job `ganztag-extern`): Hinweis {@link WARN_DAYS} Tage vor Ablauf (einmal) an die Person und an „Ganztag verwalten“;
 * abgelaufene Konten werden gesperrt (Abgang = Ablaufdatum, Sitzungen beendet; gelöscht nach der Karenz wie jeder Abgang).
 */
export async function runExternalExpiry(db: Db, now = new Date()): Promise<{ warned: number; locked: number }> {
  const today = toBerlinDate(now);
  const due = await db
    .select({ userId: users.id, name: users.name, expiresOn: users.expiresOn, provider: ganztagExternalLeaders.provider, groupName: groups.name })
    .from(ganztagExternalLeaders)
    .innerJoin(users, eq(users.id, ganztagExternalLeaders.userId))
    .innerJoin(groups, eq(groups.id, ganztagExternalLeaders.groupId))
    .where(and(eq(users.status, "active"), isNull(ganztagExternalLeaders.warnedAt), lte(users.expiresOn, addDays(today, WARN_DAYS)), gte(users.expiresOn, today)));
  const managers = due.length ? await usersWithPermission(db, MANAGE) : [];
  for (const d of due) {
    await notify(db, [d.userId], { moduleId: "ganztag", title: `Dein Zugang endet am ${fmt(d.expiresOn!)}`, body: `${d.groupName} – zum Verlängern bitte an die Schule wenden.` });
    await notify(
      db,
      managers.filter((m) => m !== d.userId),
      { moduleId: "ganztag", title: `Externe Leitung: Zugang endet am ${fmt(d.expiresOn!)}`, body: `${d.name} (${d.provider}), ${d.groupName}`, href: "/ganztag/extern" },
    );
    await db.update(ganztagExternalLeaders).set({ warnedAt: now }).where(eq(ganztagExternalLeaders.userId, d.userId));
  }
  const expired = await db
    .select({ userId: users.id, expiresOn: users.expiresOn })
    .from(ganztagExternalLeaders)
    .innerJoin(users, eq(users.id, ganztagExternalLeaders.userId))
    .where(and(eq(users.status, "active"), lt(users.expiresOn, today)));
  for (const e of expired) await lockExpired(db, e.userId, e.expiresOn!);
  return { warned: due.length, locked: expired.length };
}

