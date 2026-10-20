// Schulbücherei – Ausweis-Code (BU-07): je Konto ein pseudonymer, zufälliger Code (keine Namen, keine Kontonummer im Code),
// gedruckt als Code 128 auf Karte oder Etikett. Bei Verlust ersetzt ein neuer Code den alten (der alte ist sofort ungültig).
// Der Code gehört zum Konto (LK-KONTO) und geht mit ihm. Ausweise verwaltet, wer an der Theke ausleihen darf – der Ausweis
// gibt keine zusätzliche Macht: Auch ohne ihn wählt die Theke die Person per Suche.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { de } from "@/core/db/sort";
import { buechereiCards, groupMembers, groups, users } from "@/core/db/schema";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { BORROWER_ROLES } from "./labels";

function requireDesk(p: PermissionSet) {
  if (!hasPermission(p, "buecherei.desk")) throw new ForbiddenError("buecherei.desk");
}

/** Zeichen ohne Verwechslungsgefahr (ohne I, L, O, U) – 10 Zeichen = 50 Bit Zufall. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;

/** Rein: neuer Ausweis-Code `K-XXXXXXXXXX` aus Zufallsbytes (jedes Byte mod 32 – gleichverteilt). */
export function newCardCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return `K-${[...random(CODE_LENGTH)].map((b) => ALPHABET[b % 32]).join("")}`;
}

/** Rein: sieht die Eingabe wie ein Ausweis-Code aus? (Exemplarnummern: `B-000001-8`.) */
export function isCardCode(code: string): boolean {
  return /^K-[0-9A-HJKMNP-TV-Z]{10}$/.test(code);
}

async function insertCard(db: Db, userId: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = newCardCode();
    const [r] = await db.insert(buechereiCards).values({ userId, code }).onConflictDoNothing().returning({ code: buechereiCards.code });
    if (r) return r.code;
    const [mine] = await db.select({ code: buechereiCards.code }).from(buechereiCards).where(eq(buechereiCards.userId, userId));
    if (mine) return mine.code;
  }
  throw new Error("Ausweis-Code: kein freier Zufallscode");
}

async function borrowerIds(db: Db, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), inArray(users.role, [...BORROWER_ROLES])));
  return rows.map((r) => r.id);
}

/** Codes für Personen anlegen, die noch keinen haben (Recht `buecherei.desk`); vorhandene bleiben. Liefert die Zahl neuer Codes. */
export async function ensureCards(db: Db, viewer: PermissionSet, userIds: readonly string[]): Promise<number> {
  requireDesk(viewer);
  const ids = await borrowerIds(db, userIds);
  if (!ids.length) return 0;
  const have = new Set((await db.select({ userId: buechereiCards.userId }).from(buechereiCards).where(inArray(buechereiCards.userId, ids))).map((r) => r.userId));
  let n = 0;
  for (const id of ids) {
    if (have.has(id)) continue;
    await insertCard(db, id);
    n++;
  }
  if (n) await audit(db, viewer.userId, "buecherei.card.create", null, { count: n });
  return n;
}

/** Ausweis ersetzen (Verlust): neuer Code, der alte ist sofort ungültig. */
export async function replaceCard(db: Db, viewer: PermissionSet, userId: string): Promise<string> {
  requireDesk(viewer);
  if (!(await borrowerIds(db, [userId])).length) throw new ValidationError({ card: "Diese Person kann nicht ausleihen" });
  const code = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.delete(buechereiCards).where(eq(buechereiCards.userId, userId));
    return insertCard(tx, userId);
  });
  await audit(db, viewer.userId, "buecherei.card.replace", userId);
  return code;
}

/** Person zum gescannten Ausweis (nur Konten, die ausleihen können); unbekannter oder ersetzter Code → null. */
export async function personByCard(db: Db, viewer: PermissionSet, code: string): Promise<string | null> {
  requireDesk(viewer);
  return cardOwner(db, code);
}

/** Ohne Rechteprüfung – nur für Services, die selbst prüfen (Theke: `desk`, Schulbuchausgabe BU-11: `materials`). */
export async function cardOwner(db: Db, code: string): Promise<string | null> {
  const [r] = await db
    .select({ userId: buechereiCards.userId, role: users.role })
    .from(buechereiCards)
    .innerJoin(users, eq(users.id, buechereiCards.userId))
    .where(eq(buechereiCards.code, code));
  return r && BORROWER_ROLES.includes(r.role) ? r.userId : null;
}

export interface PrintCard {
  userId: string;
  name: string;
  className: string | null;
  code: string | null;
}

const short = (name: string) => name.replace(/^Klasse /, "");

/** Ausweise zum Drucken (nur lesen): eine Person oder alle Schüler:innen einer Klasse (Recht `buecherei.desk`). */
export async function cardsToPrint(db: Db, viewer: PermissionSet, f: { userId?: string; groupId?: string }): Promise<{ title: string; cards: PrintCard[] } | null> {
  requireDesk(viewer);
  let title: string;
  let people: { id: string; name: string; className: string | null }[];
  if (f.groupId) {
    const [g] = await db
      .select({ name: groups.name })
      .from(groups)
      .where(and(eq(groups.id, f.groupId), eq(groups.kind, "klasse"), isNull(groups.archivedAt)));
    if (!g) return null;
    title = g.name;
    const rows = await db
      .select({ id: users.id, name: users.name })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groupMembers.groupId, f.groupId), eq(groupMembers.role, "member"), eq(users.status, "active"), eq(users.role, "schueler")))
      .orderBy(de(users.lastName), de(users.firstName), users.id);
    people = rows.map((r) => ({ ...r, className: short(g.name) }));
  } else if (f.userId) {
    const [u] = await db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.id, f.userId));
    if (!u || !BORROWER_ROLES.includes(u.role)) return null;
    const [c] = await db
      .select({ name: groups.name })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(and(eq(groupMembers.userId, u.id), eq(groupMembers.role, "member"), eq(groups.kind, "klasse"), isNull(groups.archivedAt)));
    title = u.name;
    people = [{ id: u.id, name: u.name, className: c && u.role === "schueler" ? short(c.name) : null }];
  } else return null;
  const codes = people.length
    ? new Map(
        (await db.select({ userId: buechereiCards.userId, code: buechereiCards.code }).from(buechereiCards).where(inArray(buechereiCards.userId, people.map((p) => p.id)))).map((r) => [
          r.userId,
          r.code,
        ]),
      )
    : new Map<string, string>();
  return { title, cards: people.map((p) => ({ userId: p.id, name: p.name, className: p.className, code: codes.get(p.id) ?? null })) };
}

/** Klassen mit Zahl der Schüler:innen und vorhandener Ausweise (Übersicht „Ausweise“). */
export async function cardClasses(db: Db, viewer: PermissionSet) {
  requireDesk(viewer);
  const rows = await db
    .select({ id: groups.id, name: groups.name, gradeLevel: groups.gradeLevel, code: buechereiCards.code })
    .from(groups)
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, groups.id), eq(groupMembers.role, "member")))
    .innerJoin(users, and(eq(users.id, groupMembers.userId), eq(users.status, "active"), eq(users.role, "schueler")))
    .leftJoin(buechereiCards, eq(buechereiCards.userId, users.id))
    .where(and(eq(groups.kind, "klasse"), isNull(groups.archivedAt)));
  const by = new Map<string, { id: string; name: string; gradeLevel: number | null; members: number; cards: number }>();
  for (const r of rows) {
    const e = by.get(r.id) ?? { id: r.id, name: r.name, gradeLevel: r.gradeLevel, members: 0, cards: 0 };
    e.members++;
    if (r.code) e.cards++;
    by.set(r.id, e);
  }
  return [...by.values()].sort((a, b) => (a.gradeLevel ?? 99) - (b.gradeLevel ?? 99) || a.name.localeCompare(b.name, "de", { numeric: true }));
}

/** IDs der aktiven Schüler:innen einer Klasse (für „Ausweise erzeugen“). */
export async function classMemberIds(db: Db, viewer: PermissionSet, groupId: string): Promise<string[]> {
  requireDesk(viewer);
  const rows = await db
    .select({ id: groupMembers.userId })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, "member"), eq(groups.kind, "klasse"), isNull(groups.archivedAt), eq(users.status, "active"), eq(users.role, "schueler")));
  return rows.map((r) => r.id);
}
