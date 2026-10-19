// Schulbücherei – Vormerkungen (BU-03). Vormerken lässt sich nur ein Titel, dessen Exemplare alle ausgeliehen sind (oder für
// andere bereitliegen). Kommt ein Exemplar zurück, wird die älteste wartende Vormerkung „bereit“: Abholfrist (Moduleinstellung,
// auf den nächsten Schultag verschoben) und ein Gong ohne Titel (der steht nur unter „Meine Ausleihen“). Die Theke kann ein
// bereitgelegtes Exemplar nur an die vormerkende Person ausleihen – sie erfährt dabei keinen Namen. Erfüllte, verfallene und
// gelöschte Vormerkungen verschwinden sofort (kein Verlauf), spätestens nach LK-90.
import { and, asc, count, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { buechereiCopies, buechereiLoans, buechereiReservations, buechereiTitles } from "@/core/db/schema";
import { readModuleSetting } from "@/core/modules/settings";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { dueDate } from "./dates";
import { BORROWER_ROLES } from "./labels";
import { HOLD_DAYS, MAX_RESERVATIONS } from "./settings";

export const canUse = (p: PermissionSet) => hasPermission(p, "buecherei.use");
/** Selbst vormerken und verlängern: Recht `use` und eine ausleihende Rolle (nie Eltern- oder Admin-Konten, auch nicht über `*`). */
export const canBorrow = (p: PermissionSet) => canUse(p) && BORROWER_ROLES.includes(p.role);

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
export const fmtDay = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));

export interface Availability {
  /** Exemplare im Bestand (nicht ausgesondert) */
  active: number;
  /** davon nicht ausgeliehen */
  free: number;
  /** früheste Fälligkeit der ausgeliehenen Exemplare */
  nextDue: string | null;
  /** Vormerkungen, die noch warten */
  waiting: number;
  /** Vormerkungen mit bereitgelegtem Exemplar */
  ready: number;
}

/** Zahlen je Titel ohne Personenbezug: Bestand, frei, Vormerkungen. */
export async function availability(db: Db, titleIds: readonly string[]): Promise<Map<string, Availability>> {
  const ids = [...new Set(titleIds)];
  const out = new Map<string, Availability>(ids.map((id) => [id, { active: 0, free: 0, nextDue: null, waiting: 0, ready: 0 }]));
  if (!ids.length) return out;
  const [copies, res] = await Promise.all([
    db
      .select({
        titleId: buechereiCopies.titleId,
        active: sql<number>`count(*)::int`,
        free: sql<number>`(count(*) filter (where ${buechereiLoans.id} is null))::int`,
        nextDue: sql<string | null>`min(${buechereiLoans.dueOn})::text`,
      })
      .from(buechereiCopies)
      .leftJoin(buechereiLoans, and(eq(buechereiLoans.copyId, buechereiCopies.id), isNull(buechereiLoans.returnedOn)))
      .where(and(inArray(buechereiCopies.titleId, ids), isNull(buechereiCopies.withdrawnOn)))
      .groupBy(buechereiCopies.titleId),
    db
      .select({
        titleId: buechereiReservations.titleId,
        waiting: sql<number>`(count(*) filter (where ${buechereiReservations.readyOn} is null))::int`,
        ready: sql<number>`(count(*) filter (where ${buechereiReservations.readyOn} is not null))::int`,
      })
      .from(buechereiReservations)
      .where(inArray(buechereiReservations.titleId, ids))
      .groupBy(buechereiReservations.titleId),
  ]);
  for (const c of copies) Object.assign(out.get(c.titleId)!, { active: Number(c.active), free: Number(c.free), nextDue: c.nextDue ?? null });
  for (const r of res) Object.assign(out.get(r.titleId)!, { waiting: Number(r.waiting), ready: Number(r.ready) });
  return out;
}

/** Rein: frei ausleihbar für jemanden ohne bereitliegende Vormerkung (freie Exemplare abzüglich der bereitgelegten). */
export const shelfCount = (a: Availability) => Math.max(0, a.free - a.ready);

async function ownReservation(db: Db, titleId: string, userId: string) {
  const [r] = await db
    .select({ id: buechereiReservations.id, readyOn: buechereiReservations.readyOn })
    .from(buechereiReservations)
    .where(and(eq(buechereiReservations.titleId, titleId), eq(buechereiReservations.userId, userId)));
  return r ?? null;
}

/**
 * Theke: Darf ein freies Exemplar dieses Titels an `userId` gehen? Nein, wenn alle freien Exemplare für andere bereitliegen.
 * Liefert die eigene Vormerkung (wird mit der Ausleihe erfüllt) bzw. wirft – ohne Namen der anderen Person.
 */
export async function checkoutReservation(db: Db, titleId: string, userId: string, code: string): Promise<{ id: string } | null> {
  const [a, mine] = await Promise.all([availability(db, [titleId]).then((m) => m.get(titleId)!), ownReservation(db, titleId, userId)]);
  const readyForOthers = a.ready - (mine?.readyOn ? 1 : 0);
  if (a.free - readyForOthers <= 0) throw new ValidationError({ code: `${code} ist vorgemerkt und liegt für eine andere Person bereit` });
  return mine;
}

/** Hat jemand anderes als `holderId` den Titel vorgemerkt? Dann lässt sich die Ausleihe nicht verlängern. */
export async function reservedByOthers(db: Db, titleId: string, holderId: string | null): Promise<boolean> {
  const [r] = await db
    .select({ n: count() })
    .from(buechereiReservations)
    .where(and(eq(buechereiReservations.titleId, titleId), holderId ? ne(buechereiReservations.userId, holderId) : undefined));
  return (r?.n ?? 0) > 0;
}

/**
 * Nach einer Rückgabe (oder im täglichen Lauf): so viele wartende Vormerkungen, wie freie Exemplare nicht schon bereitliegen,
 * der Reihe nach „bereit“ setzen und benachrichtigen. Liefert die benachrichtigten Konten.
 */
export async function promoteReservations(db: Db, titleId: string, today: string): Promise<string[]> {
  const a = (await availability(db, [titleId])).get(titleId)!;
  const slots = shelfCount(a);
  if (slots <= 0 || a.waiting === 0) return [];
  const next = await db
    .select({ id: buechereiReservations.id, userId: buechereiReservations.userId })
    .from(buechereiReservations)
    .where(and(eq(buechereiReservations.titleId, titleId), isNull(buechereiReservations.readyOn)))
    .orderBy(asc(buechereiReservations.createdAt), asc(buechereiReservations.id))
    .limit(slots);
  if (!next.length) return [];
  const holdUntil = await dueDate(db, today, Number(await readModuleSetting(db, HOLD_DAYS)));
  const done = await db
    .update(buechereiReservations)
    .set({ readyOn: today, holdUntil })
    .where(
      and(
        inArray(
          buechereiReservations.id,
          next.map((r) => r.id),
        ),
        isNull(buechereiReservations.readyOn),
      ),
    )
    .returning({ userId: buechereiReservations.userId });
  const users = done.map((r) => r.userId);
  // Gong ohne Titel: was jemand liest, steht nicht in der Benachrichtigung (bleibt dort länger als die Vormerkung)
  await notify(db, users, {
    moduleId: "buecherei",
    title: "Deine Vormerkung liegt in der Bücherei bereit",
    body: `Abholen bis ${fmtDay(holdUntil)} – danach rückt die nächste Vormerkung nach. Welcher Titel: unter „Meine Ausleihen“.`,
    href: "/buecherei/meine",
  });
  return users;
}

/**
 * Täglicher Lauf: verfallene Abholfristen löschen (Gong an die Person), dann je Titel mit wartenden Vormerkungen nachrücken
 * lassen – auch wenn inzwischen Exemplare hinzugekommen sind.
 */
export async function runReservations(db: Db, today: string): Promise<{ expired: number; ready: number }> {
  const expired = await db
    .delete(buechereiReservations)
    .where(and(isNotNull(buechereiReservations.holdUntil), lt(buechereiReservations.holdUntil, today)))
    .returning({ userId: buechereiReservations.userId });
  await notify(
    db,
    expired.map((r) => r.userId),
    { moduleId: "buecherei", title: "Vormerkung verfallen", body: "Die Abholfrist ist abgelaufen – die Vormerkung ist gelöscht. Du kannst den Titel im Katalog neu vormerken.", href: "/buecherei/katalog" },
  );
  const titles = await db.selectDistinct({ titleId: buechereiReservations.titleId }).from(buechereiReservations).where(isNull(buechereiReservations.readyOn));
  let ready = 0;
  for (const t of titles) ready += (await promoteReservations(db, t.titleId, today)).length;
  return { expired: expired.length, ready };
}

/** Vormerken (Recht `buecherei.use`, ausleihende Rolle): nur wenn kein Exemplar frei im Regal steht. Liefert den Platz in der Reihe. */
export async function reserve(db: Db, viewer: PermissionSet, titleId: string): Promise<{ title: string; position: number }> {
  if (!canBorrow(viewer)) throw new ForbiddenError("buecherei.use");
  const max = Number(await readModuleSetting(db, MAX_RESERVATIONS));
  if (max === 0) throw new ValidationError({ title: "Vormerken ist ausgeschaltet" });
  const [t] = await db.select({ id: buechereiTitles.id, title: buechereiTitles.title }).from(buechereiTitles).where(eq(buechereiTitles.id, titleId));
  if (!t) throw new ValidationError({ title: "Titel gibt es nicht" });
  const a = (await availability(db, [t.id])).get(t.id)!;
  if (a.active === 0) throw new ValidationError({ title: "Kein Exemplar im Bestand – nicht vormerkbar" });
  if (shelfCount(a) > 0) throw new ValidationError({ title: "Ein Exemplar steht im Regal – einfach an der Theke ausleihen" });
  const [held] = await db
    .select({ n: count() })
    .from(buechereiLoans)
    .innerJoin(buechereiCopies, eq(buechereiCopies.id, buechereiLoans.copyId))
    .where(and(eq(buechereiCopies.titleId, t.id), eq(buechereiLoans.userId, viewer.userId), isNull(buechereiLoans.returnedOn)));
  if ((held?.n ?? 0) > 0) throw new ValidationError({ title: "Du hast diesen Titel gerade ausgeliehen" });
  const [mine] = await db.select({ n: count() }).from(buechereiReservations).where(eq(buechereiReservations.userId, viewer.userId));
  if ((mine?.n ?? 0) >= max) throw new ValidationError({ title: `Höchstens ${max} Vormerkungen gleichzeitig – erst eine löschen` });
  const [r] = await db.insert(buechereiReservations).values({ titleId: t.id, userId: viewer.userId }).onConflictDoNothing().returning({ id: buechereiReservations.id });
  if (!r) throw new ValidationError({ title: "Schon vorgemerkt" });
  return { title: t.title, position: await waitingPosition(db, r.id) };
}

/** Platz in der Reihe der wartenden Vormerkungen eines Titels (1 = als Nächstes dran); bereite zählen nicht. */
export async function waitingPosition(db: Db, reservationId: string): Promise<number> {
  const [me] = await db
    .select({ titleId: buechereiReservations.titleId, createdAt: buechereiReservations.createdAt, id: buechereiReservations.id })
    .from(buechereiReservations)
    .where(eq(buechereiReservations.id, reservationId));
  if (!me) return 0;
  const [r] = await db
    .select({ n: count() })
    .from(buechereiReservations)
    .where(
      and(
        eq(buechereiReservations.titleId, me.titleId),
        isNull(buechereiReservations.readyOn),
        or(lt(buechereiReservations.createdAt, me.createdAt), and(eq(buechereiReservations.createdAt, me.createdAt), lt(buechereiReservations.id, me.id))),
      ),
    );
  return (r?.n ?? 0) + 1;
}

/** Eigene Vormerkung löschen; lag schon ein Exemplar bereit, rückt die nächste nach. */
export async function cancelReservation(db: Db, viewer: PermissionSet, reservationId: string, today: string): Promise<void> {
  if (!canUse(viewer)) throw new ForbiddenError("buecherei.use");
  const [r] = await db
    .delete(buechereiReservations)
    .where(and(eq(buechereiReservations.id, reservationId), eq(buechereiReservations.userId, viewer.userId)))
    .returning({ titleId: buechereiReservations.titleId, readyOn: buechereiReservations.readyOn });
  if (!r) throw new ValidationError({ reservation: "Vormerkung gibt es nicht (mehr)" });
  if (r.readyOn) await promoteReservations(db, r.titleId, today);
}
