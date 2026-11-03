// GT-11/GT-12 (Projektleitung 2026-11-03, docs/GANZTAG.md „Folge (Runde 14)“): Mittagessen – Speiseplan je Woche von Hand
// (nummerierte Menüs mit Kurzbeschreibung), Anmeldung/Abmeldung je Tag mit Menüwahl bis zur Frist, Zählung und Ausgabeliste für die
// Küche. Keine Abrechnung, keine Allergien, Unverträglichkeiten oder Kostformen (Art. 9) – Hinweis „direkt mit der Küche klären“.
import { and, asc, count, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { audit, auditRead } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { ganztagMealOrders, ganztagMenus, groupMembers, groups, users } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { readModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { childrenOf } from "@/core/school/majority";
import { addDays, isCalendarDate, mondayOf, toBerlinDate, weekdayMon0 } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { actsFor, berlinTime } from "./heimweg";
import { canManage, dateLabel, MANAGE, VIEW_ALL } from "./service";
import { MEAL_DEADLINE } from "./settings";

/** Hinweis an allen Stellen der Anmeldung (Projektleitung 2026-11-03): Gesundheitsdaten bleiben außerhalb von SchulOS. */
export const MEAL_HINT = "Allergien und Unverträglichkeiten bitte direkt mit der Küche bzw. der Ganztagsleitung klären – SchulOS erfasst sie nicht.";
/** Menüs je Tag: Menü 1 … Menü 4 */
export const MAX_MENUS = 4;
export const MAX_TITLE = 80;
/** Familienansicht: Speiseplan der nächsten zwei Wochen */
export const FAMILY_DAYS = 14;

export const canSeeCounts = (p: PermissionSet) => canManage(p) || hasPermission(p, VIEW_ALL);

// ---------------------------------------------------------------- rein

/** Moduleinstellung `ganztag.meal_deadline`: „tag-09“ = am Tag selbst bis 9:00, „vortag-12“ = am Vortag bis 12:00, „zwei-12“ = zwei Tage vorher. */
export function parseDeadline(raw: string): { daysBefore: number; time: string } {
  const m = /^(tag|vortag|zwei)-(\d{2})$/.exec(raw);
  if (!m) return { daysBefore: 1, time: "12:00" };
  return { daysBefore: m[1] === "tag" ? 0 : m[1] === "vortag" ? 1 : 2, time: `${m[2]}:00` };
}

/** Anmeldeschluss eines Tages als { date, time } (Berliner Ortszeit) – „Vortag“ zählt Werktage (für Montag: Freitag). */
export function mealDeadline(date: string, raw: string): { date: string; time: string } {
  const d = parseDeadline(raw);
  let day = date;
  for (let i = 0; i < d.daysBefore; i++) {
    day = addDays(day, -1);
    while (weekdayMon0(day) > 4) day = addDays(day, -1);
  }
  return { date: day, time: d.time };
}

/** Darf die Familie für `date` jetzt noch an- oder abmelden? */
export function mealOpen(date: string, now: Date, raw: string): boolean {
  const dl = mealDeadline(date, raw);
  const today = toBerlinDate(now);
  if (today !== dl.date) return today < dl.date;
  return berlinTime(now) < dl.time;
}

/** „bis Mo, 09.11.2026, 12:00 Uhr“ */
export function deadlineText(date: string, raw: string): string {
  const dl = mealDeadline(date, raw);
  return `bis ${dateLabel(dl.date)}, ${dl.time} Uhr`;
}

// ---------------------------------------------------------------- Speiseplan (GT-11)

export interface DayMenu {
  date: string;
  menus: { number: number; title: string }[];
}

/** Menüs von `from` bis `to` (einschließlich), je Tag sortiert. */
export async function menusBetween(db: Db, from: string, to: string): Promise<DayMenu[]> {
  const rows = await db
    .select({ date: ganztagMenus.date, number: ganztagMenus.number, title: ganztagMenus.title })
    .from(ganztagMenus)
    .where(and(gte(ganztagMenus.date, from), lte(ganztagMenus.date, to)))
    .orderBy(asc(ganztagMenus.date), asc(ganztagMenus.number));
  const out = new Map<string, DayMenu>();
  for (const r of rows) {
    const d = out.get(r.date) ?? { date: r.date, menus: [] };
    d.menus.push({ number: r.number, title: r.title });
    out.set(r.date, d);
  }
  return [...out.values()];
}

export interface WeekPlan {
  monday: string;
  days: (DayMenu & { orders: Record<number, number> })[];
}

/** Woche (Mo–Fr) mit Menüs und Zahl der Anmeldungen je Menü – „Ganztag verwalten“ bzw. „Ganztag auswerten“. */
export async function weekPlan(db: Db, viewer: PermissionSet, anyDay: string): Promise<WeekPlan> {
  if (!canSeeCounts(viewer)) throw new ForbiddenError(MANAGE);
  const monday = mondayOf(isCalendarDate(anyDay) ? anyDay : toBerlinDate(new Date()));
  const friday = addDays(monday, 4);
  const [menus, counts] = await Promise.all([menusBetween(db, monday, friday), countsBetween(db, monday, friday)]);
  const byDate = new Map(menus.map((m) => [m.date, m.menus]));
  const days = [0, 1, 2, 3, 4].map((i) => {
    const date = addDays(monday, i);
    const orders: Record<number, number> = {};
    for (const c of counts.filter((x) => x.date === date)) orders[c.number] = c.count;
    return { date, menus: byDate.get(date) ?? [], orders };
  });
  return { monday, days };
}

/**
 * Menüs eines Tages setzen (nur „Ganztag verwalten“): `titles[i]` = Kurzbeschreibung von Menü i+1, leer = kein Menü. Ein Menü mit
 * Anmeldungen lässt sich nicht entfernen. Keine Kostform-Angaben im Titel erzwingen wir nicht – Hinweis im Formular.
 */
export async function setDayMenus(db: Db, viewer: PermissionSet, date: string, titles: readonly string[]): Promise<number> {
  if (!canManage(viewer)) throw new ForbiddenError(MANAGE);
  if (!isCalendarDate(date)) throw new ValidationError({ date: "Datum angeben" });
  if (weekdayMon0(date) > 4) throw new ValidationError({ date: "Speiseplan nur für Montag bis Freitag" });
  const errors: Record<string, string> = {};
  const items: { number: number; title: string }[] = [];
  titles.slice(0, MAX_MENUS).forEach((raw, i) => {
    const title = raw.trim().replace(/\s+/g, " ");
    if (title.length > MAX_TITLE) errors[`m${i + 1}`] = `Höchstens ${MAX_TITLE} Zeichen`;
    else if (title) items.push({ number: i + 1, title });
  });
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const ordered = await db
    .select({ number: ganztagMealOrders.menuNumber, n: count() })
    .from(ganztagMealOrders)
    .where(eq(ganztagMealOrders.date, date))
    .groupBy(ganztagMealOrders.menuNumber);
  for (const o of ordered)
    if (!items.some((i) => i.number === o.number)) throw new ValidationError({ [`m${o.number}`]: `Für Menü ${o.number} gibt es schon ${o.n === 1 ? "eine Anmeldung" : `${o.n} Anmeldungen`}` });
  await db.transaction(async (tx) => {
    await tx.delete(ganztagMenus).where(eq(ganztagMenus.date, date));
    if (items.length) await tx.insert(ganztagMenus).values(items.map((i) => ({ date, number: i.number, title: i.title })));
    await audit(tx, viewer.userId, "ganztag.menu.set", date, { menus: items.length });
  });
  return items.length;
}

// ---------------------------------------------------------------- Anmeldung (GT-11)

/**
 * An- bzw. abmelden (`menu = null`). Die Familie (Eltern minderjähriger Kinder, eigenständige Schüler:innen selbst) bis zur Frist,
 * „Ganztag verwalten“ jederzeit bis zum Tag selbst. Nur Tage und Menüs aus dem Speiseplan.
 */
export async function setMealOrder(db: Db, viewer: PermissionSet, studentId: string, date: string, menu: number | null, now = new Date()): Promise<void> {
  const family = await actsFor(db, viewer, studentId);
  const manager = canManage(viewer);
  if (!family && !manager) throw new ForbiddenError(MANAGE);
  if (!isCalendarDate(date)) throw new ValidationError({ date: "Datum angeben" });
  const [student] = await db.select({ role: users.role }).from(users).where(eq(users.id, studentId));
  if (student?.role !== "schueler") throw new ValidationError({ studentId: "Nur für Schüler:innen" });
  const deadline = await readModuleSetting(db, MEAL_DEADLINE);
  if (date < toBerlinDate(now)) throw new ValidationError({ date: "Der Tag ist vorbei" });
  if (!manager && !mealOpen(date, now, deadline)) throw new ValidationError({ date: `Anmeldeschluss war ${deadlineText(date, deadline)} – bitte direkt bei der Küche melden` });
  if (menu !== null) {
    const [m] = await db.select({ n: ganztagMenus.number }).from(ganztagMenus).where(and(eq(ganztagMenus.date, date), eq(ganztagMenus.number, menu)));
    if (!m) throw new ValidationError({ menu: "Dieses Menü gibt es an dem Tag nicht" });
    await db
      .insert(ganztagMealOrders)
      .values({ date, studentId, menuNumber: menu, orderedBy: viewer.userId, orderedAt: now })
      .onConflictDoUpdate({ target: [ganztagMealOrders.date, ganztagMealOrders.studentId], set: { menuNumber: menu, orderedBy: viewer.userId, orderedAt: now } });
  } else await db.delete(ganztagMealOrders).where(and(eq(ganztagMealOrders.date, date), eq(ganztagMealOrders.studentId, studentId)));
  await audit(db, viewer.userId, menu === null ? "ganztag.meal.cancel" : "ganztag.meal.order", studentId, { date, menu });
}

export interface FamilyMeals {
  id: string;
  name: string;
  mayAct: boolean;
  days: (DayMenu & { ordered: number | null; open: boolean; deadline: string })[];
}

/** Familienansicht: Speiseplan der nächsten zwei Wochen mit der eigenen Anmeldung je Kind. */
export async function familyMeals(db: Db, viewer: PermissionSet, now = new Date()): Promise<FamilyMeals[]> {
  const targets =
    viewer.role === "schueler" ? [{ id: viewer.userId, name: "" }] : viewer.role === "eltern" ? (await childrenOf(db, viewer.userId, "inform")).map((c) => ({ id: c.id, name: c.name })) : [];
  if (targets.length === 0) return [];
  const today = toBerlinDate(now);
  const menus = await menusBetween(db, today, addDays(today, FAMILY_DAYS - 1));
  if (menus.length === 0) return [];
  const deadline = await readModuleSetting(db, MEAL_DEADLINE);
  const orders = await db
    .select({ studentId: ganztagMealOrders.studentId, date: ganztagMealOrders.date, menu: ganztagMealOrders.menuNumber })
    .from(ganztagMealOrders)
    .where(and(inArray(ganztagMealOrders.studentId, targets.map((t) => t.id)), gte(ganztagMealOrders.date, today)));
  const out: FamilyMeals[] = [];
  for (const t of targets) {
    const mine = new Map(orders.filter((o) => o.studentId === t.id).map((o) => [o.date, o.menu]));
    out.push({
      ...t,
      mayAct: await actsFor(db, viewer, t.id),
      days: menus.map((d) => ({ ...d, ordered: mine.get(d.date) ?? null, open: mealOpen(d.date, now, deadline), deadline: deadlineText(d.date, deadline) })),
    });
  }
  return out;
}

// ---------------------------------------------------------------- Küche (GT-12)

/** Zahl der Anmeldungen je Tag und Menü – ohne Namen. */
export async function countsBetween(db: Db, from: string, to: string): Promise<{ date: string; number: number; title: string; count: number }[]> {
  const rows = await db
    .select({ date: ganztagMealOrders.date, number: ganztagMealOrders.menuNumber, n: count() })
    .from(ganztagMealOrders)
    .where(and(gte(ganztagMealOrders.date, from), lte(ganztagMealOrders.date, to)))
    .groupBy(ganztagMealOrders.date, ganztagMealOrders.menuNumber);
  const menus = await menusBetween(db, from, to);
  const title = new Map(menus.flatMap((d) => d.menus.map((m) => [`${d.date}#${m.number}`, m.title] as const)));
  return rows
    .map((r) => ({ date: r.date, number: r.number, title: title.get(`${r.date}#${r.number}`) ?? "", count: Number(r.n) }))
    .sort((a, b) => (a.date === b.date ? a.number - b.number : a.date < b.date ? -1 : 1));
}

/** CSV-Zeilen der Küchen-Auswertung (Tag, Menü, Beschreibung, Anzahl) – „Ganztag verwalten“ bzw. „auswerten“. */
export async function kitchenCsvRows(db: Db, viewer: PermissionSet, from: string, to: string): Promise<string[][]> {
  if (!canSeeCounts(viewer)) throw new ForbiddenError(MANAGE);
  if (!isCalendarDate(from) || !isCalendarDate(to) || to < from || to > addDays(from, 92)) throw new ValidationError({ from: "Zeitraum bis höchstens drei Monate angeben" });
  const rows = await countsBetween(db, from, to);
  return [["Datum", "Menü", "Beschreibung", "Anmeldungen"], ...rows.map((r) => [r.date, String(r.number), r.title, String(r.count)])];
}

export interface ServingRow {
  name: string;
  className: string | null;
  menu: number;
}

/** Ausgabeliste eines Tages (nur „Ganztag verwalten“): Name, Klasse, Menü-Nr. – sonst nichts. Einsicht wird protokolliert. */
export async function servingList(db: Db, viewer: PermissionSet, date: string): Promise<{ date: string; menus: DayMenu["menus"]; rows: ServingRow[] }> {
  if (!canManage(viewer)) throw new ForbiddenError(MANAGE);
  if (!isCalendarDate(date)) throw new ValidationError({ date: "Datum angeben" });
  const [menus, orders] = await Promise.all([
    menusBetween(db, date, date),
    db
      .select({ id: users.id, name: users.name, menu: ganztagMealOrders.menuNumber })
      .from(ganztagMealOrders)
      .innerJoin(users, eq(users.id, ganztagMealOrders.studentId))
      .where(eq(ganztagMealOrders.date, date))
      .orderBy(de(users.lastName), de(users.firstName)),
  ]);
  const classes = orders.length
    ? await db
        .select({ userId: groupMembers.userId, name: groups.name })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(and(inArray(groupMembers.userId, orders.map((o) => o.id)), eq(groups.kind, "klasse"), isNull(groups.archivedAt), eq(groupMembers.role, "member")))
    : [];
  const classOf = new Map(classes.map((c) => [c.userId, c.name]));
  await auditRead(db, viewer.userId, "lesen.ganztag_essen", date);
  return {
    date,
    menus: menus[0]?.menus ?? [],
    rows: orders
      .map((o) => ({ name: o.name, className: classOf.get(o.id) ?? null, menu: o.menu }))
      .sort((a, b) => a.menu - b.menu || (a.className ?? "~").localeCompare(b.className ?? "~", "de")),
  };
}
