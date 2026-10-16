// Schulanmeldung im Sekretariat (P4-36): Antragsliste mit Filtern, Antrag (Lesezugriff protokolliert), Notizen, Termin
// verschieben (Mail an die Eltern), Tagesliste für den Druck, Kennzahlen fürs Widget und gesammelter Gong bei neuen Anträgen.
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, ne } from "drizzle-orm";
import { audit, auditRead } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { anmeldungAntraege, anmeldungEreignisse, anmeldungSlots, anmeldungVerfahren, notifications, rooms, schoolYears, users } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { enqueueMail } from "@/core/mail";
import { notify } from "@/core/notifications";
import { ForbiddenError, usersWithPermission, type PermissionSet } from "@/core/permissions";
import { fromBerlinLocal, addDays, isCalendarDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { ANTRAG_STATUSES, type AntragStatus } from "./labels";
import { anmeldungSlotMail, slotText } from "./mails";
import { antragNumber, canManage, canView, OPEN_STATUSES, setAntragSlot } from "./service";

/** P4-78b: Wert des Stand-Filters für „Spam-Verdacht“ */
export const SPAM_SUSPECT_FILTER = "spamverdacht";

function assertView(v: PermissionSet) {
  if (!canView(v)) throw new ForbiddenError("anmeldung.view");
}
function assertManage(v: PermissionSet) {
  if (!canManage(v)) throw new ForbiddenError("anmeldung.manage");
}

export const NOTE_MAX = 1000;
export const SORTS = ["name", "nummer", "termin", "eingang"] as const;
export type AntragSort = (typeof SORTS)[number];

export interface AntragFilter {
  status?: string;
  slotId?: string;
  school?: string;
  sibling?: string;
  q?: string;
  sort?: string;
}

export interface AntragListRow {
  id: string;
  number: string;
  childFirstName: string;
  childLastName: string;
  childBirthDate: string;
  primarySchool: string | null;
  sibling: boolean;
  status: AntragStatus;
  slotId: string | null;
  slotStartsAt: Date | null;
  createdAt: Date;
  viaAccount: boolean;
  /** P4-78: als Spam abgelehnt */
  spam: boolean;
  /** P4-78b: als Spam-Verdacht markiert (nur bei offenen Anträgen) */
  spamSuspect: boolean;
}

/**
 * Anträge eines Verfahrens. Unbestätigte nur mit Filter „E-Mail nicht bestätigt“ (sie sind noch keine Anmeldung). Suche über
 * Namen von Kind und Eltern, Vorgangsnummer und Grundschule; Sortierung nach Name (deutsch), Nummer, Termin oder Eingang.
 */
export async function listAntraege(db: Db, viewer: PermissionSet, verfahrenId: string, f: AntragFilter = {}): Promise<AntragListRow[]> {
  assertView(viewer);
  const status = (ANTRAG_STATUSES as readonly string[]).includes(f.status ?? "") ? (f.status as AntragStatus) : null;
  const conds = [eq(anmeldungAntraege.verfahrenId, verfahrenId), status ? eq(anmeldungAntraege.status, status) : ne(anmeldungAntraege.status, "unbestaetigt")];
  // P4-78b: Filter „Spam-Verdacht“ – markierte offene Anträge
  if (f.status === SPAM_SUSPECT_FILTER) conds.push(isNotNull(anmeldungAntraege.spamSuspectedAt), inArray(anmeldungAntraege.status, [...OPEN_STATUSES]));
  if (f.slotId === "ohne") conds.push(isNull(anmeldungAntraege.slotId));
  else if (f.slotId) conds.push(eq(anmeldungAntraege.slotId, f.slotId.slice(0, 64)));
  if (f.sibling === "ja") conds.push(eq(anmeldungAntraege.sibling, true));
  if (f.sibling === "nein") conds.push(eq(anmeldungAntraege.sibling, false));
  const rows = await db
    .select({ a: anmeldungAntraege, slotStartsAt: anmeldungSlots.startsAt })
    .from(anmeldungAntraege)
    .leftJoin(anmeldungSlots, eq(anmeldungSlots.id, anmeldungAntraege.slotId))
    .where(and(...conds))
    .orderBy(de(anmeldungAntraege.childLastName), de(anmeldungAntraege.childFirstName), asc(anmeldungAntraege.seq));
  const q = (f.q ?? "").trim().toLowerCase().slice(0, 100);
  const school = (f.school ?? "").trim().toLowerCase().slice(0, 120);
  const out = rows
    .filter(({ a }) => !school || (a.primarySchool ?? "").toLowerCase() === school)
    .filter(
      ({ a }) =>
        !q ||
        [a.childFirstName, a.childLastName, `${a.childFirstName} ${a.childLastName}`, a.parent1Name, a.parent2Name ?? "", a.primarySchool ?? "", antragNumber(a.year, a.seq)].some((s) =>
          s.toLowerCase().includes(q),
        ),
    )
    .map(({ a, slotStartsAt }) => ({
      id: a.id,
      number: antragNumber(a.year, a.seq),
      childFirstName: a.childFirstName,
      childLastName: a.childLastName,
      childBirthDate: a.childBirthDate,
      primarySchool: a.primarySchool,
      sibling: a.sibling,
      status: a.status,
      slotId: a.slotId,
      slotStartsAt,
      createdAt: a.createdAt,
      viaAccount: a.parentUserId !== null,
      spam: a.rejectedAsSpam,
      spamSuspect: a.spamSuspectedAt !== null,
    }));
  const sort = (SORTS as readonly string[]).includes(f.sort ?? "") ? (f.sort as AntragSort) : "name";
  if (sort === "nummer") out.sort((x, y) => x.number.localeCompare(y.number));
  if (sort === "termin") out.sort((x, y) => (x.slotStartsAt?.getTime() ?? Infinity) - (y.slotStartsAt?.getTime() ?? Infinity));
  if (sort === "eingang") out.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
  return out;
}

/** Grundschulen der Anträge (für den Filter). */
export async function primarySchools(db: Db, viewer: PermissionSet, verfahrenId: string): Promise<string[]> {
  assertView(viewer);
  const rows = await db
    .selectDistinct({ s: anmeldungAntraege.primarySchool })
    .from(anmeldungAntraege)
    .where(and(eq(anmeldungAntraege.verfahrenId, verfahrenId), ne(anmeldungAntraege.status, "unbestaetigt")));
  return rows
    .flatMap((r) => (r.s ? [r.s] : []))
    .sort((a, b) => a.localeCompare(b, "de"));
}

/** Ein Antrag mit Verlauf und Termin – Lesezugriff wird protokolliert (`lesen.anmeldung`, wie bei sensiblen Daten). */
export async function getAntrag(db: Db, viewer: PermissionSet, antragId: string, now = new Date()) {
  assertView(viewer);
  const [r] = await db
    .select({ a: anmeldungAntraege, verfahrenName: anmeldungVerfahren.name, verfahrenStatus: anmeldungVerfahren.status, schoolYearStartsOn: schoolYears.startsOn })
    .from(anmeldungAntraege)
    .innerJoin(anmeldungVerfahren, eq(anmeldungVerfahren.id, anmeldungAntraege.verfahrenId))
    .innerJoin(schoolYears, eq(schoolYears.id, anmeldungVerfahren.targetSchoolYearId))
    .where(eq(anmeldungAntraege.id, antragId));
  if (!r) return null;
  await auditRead(db, viewer.userId, "lesen.anmeldung", antragId, { verfahren: r.a.verfahrenId }, now);
  const [slot] = r.a.slotId
    ? await db
        .select({ id: anmeldungSlots.id, startsAt: anmeldungSlots.startsAt, endsAt: anmeldungSlots.endsAt, room: rooms.name })
        .from(anmeldungSlots)
        .leftJoin(rooms, eq(rooms.id, anmeldungSlots.roomId))
        .where(eq(anmeldungSlots.id, r.a.slotId))
    : [];
  const events = await db
    .select({ id: anmeldungEreignisse.id, at: anmeldungEreignisse.at, kind: anmeldungEreignisse.kind, text: anmeldungEreignisse.text, actorName: users.name })
    .from(anmeldungEreignisse)
    .leftJoin(users, eq(users.id, anmeldungEreignisse.actorId))
    .where(eq(anmeldungEreignisse.antragId, antragId))
    .orderBy(desc(anmeldungEreignisse.at), desc(anmeldungEreignisse.id));
  // Hashes der geheimen Links gehören nicht in die Oberfläche
  const antrag: Omit<typeof r.a, "confirmTokenHash" | "accessTokenHash"> & Partial<Pick<typeof r.a, "confirmTokenHash" | "accessTokenHash">> = { ...r.a };
  delete antrag.confirmTokenHash;
  delete antrag.accessTokenHash;
  return {
    antrag,
    number: antragNumber(r.a.year, r.a.seq),
    verfahrenName: r.verfahrenName,
    verfahrenStatus: r.verfahrenStatus,
    schoolYearStartsOn: r.schoolYearStartsOn,
    slot: slot ?? null,
    events,
    checklist: (r.a.checklist ?? {}) as Record<string, boolean>,
  };
}

/** Interne Notiz (Hinweis: keine Gesundheitsdaten) – erscheint nur im Verlauf, nie bei den Eltern. */
export async function addNote(db: Db, viewer: PermissionSet, antragId: string, text: string, now = new Date()): Promise<void> {
  assertManage(viewer);
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t) throw new ValidationError({ note: "Notiz eingeben" });
  if (t.length > NOTE_MAX) throw new ValidationError({ note: `Bitte kürzer (höchstens ${NOTE_MAX} Zeichen)` });
  const [a] = await db.select({ id: anmeldungAntraege.id }).from(anmeldungAntraege).where(eq(anmeldungAntraege.id, antragId));
  if (!a) throw new ValidationError({ note: "Antrag gibt es nicht" });
  await db.insert(anmeldungEreignisse).values({ antragId, actorId: viewer.userId, kind: "notiz", text: t, at: now });
  await audit(db, viewer.userId, "anmeldung.antrag.notiz", antragId);
}

/** Termin verschieben bzw. entfernen (Sekretariat) – bestätigte Anträge bekommen eine Mail. */
export async function moveSlot(db: Db, viewer: PermissionSet, antragId: string, slotId: string | null, ctx: { now?: Date; school: string }): Promise<void> {
  const now = ctx.now ?? new Date();
  const [before] = await db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, antragId));
  if (!before) throw new ValidationError({ slotId: "Antrag gibt es nicht" });
  if ((before.slotId ?? null) === slotId) return;
  await setAntragSlot(db, viewer, antragId, slotId, now);
  if (before.status === "unbestaetigt") return;
  const [s] = slotId
    ? await db
        .select({ startsAt: anmeldungSlots.startsAt, endsAt: anmeldungSlots.endsAt, room: rooms.name })
        .from(anmeldungSlots)
        .leftJoin(rooms, eq(rooms.id, anmeldungSlots.roomId))
        .where(eq(anmeldungSlots.id, slotId))
    : [];
  await enqueueMail(
    db,
    { to: before.parent1Email, ...anmeldungSlotMail({ school: ctx.school, number: antragNumber(before.year, before.seq), slot: s ? slotText(s, s.room) : null, bySchool: true }), purpose: "anmeldung-termin" },
    now,
  );
  await db.insert(anmeldungEreignisse).values({ antragId, actorId: viewer.userId, kind: "mail", text: "Mail: Termin geändert", at: now });
}

export interface DayRow {
  slot: { id: string; startsAt: Date; endsAt: Date; room: string | null; capacity: number };
  antraege: { id: string; number: string; child: string; parent: string; phone: string | null; status: AntragStatus; sibling: boolean }[];
}

/** Gespräche eines Tages (Berliner Datum) für die Tagesliste – nur bestätigte Anträge. Lesezugriff protokolliert. */
export async function dayList(db: Db, viewer: PermissionSet, verfahrenId: string, day: string, now = new Date()): Promise<DayRow[]> {
  assertView(viewer);
  // GATE-4c (Code-M3): echtes Kalenderdatum (2027-02-30 rollte sonst in den März)
  if (!isCalendarDate(day)) throw new ValidationError({ day: "Datum" });
  const from = fromBerlinLocal(`${day}T00:00`);
  const to = fromBerlinLocal(`${addDays(day, 1)}T00:00`);
  const slots = await db
    .select({ id: anmeldungSlots.id, startsAt: anmeldungSlots.startsAt, endsAt: anmeldungSlots.endsAt, room: rooms.name, capacity: anmeldungSlots.capacity })
    .from(anmeldungSlots)
    .leftJoin(rooms, eq(rooms.id, anmeldungSlots.roomId))
    .where(and(eq(anmeldungSlots.verfahrenId, verfahrenId), gte(anmeldungSlots.startsAt, from), lt(anmeldungSlots.startsAt, to)))
    .orderBy(asc(anmeldungSlots.startsAt));
  const ids = slots.map((s) => s.id);
  const rows = ids.length
    ? await db
        .select()
        .from(anmeldungAntraege)
        .where(and(inArray(anmeldungAntraege.slotId, ids), inArray(anmeldungAntraege.status, ["eingegangen", "termin", "vollstaendig", "aufgenommen", "warteliste", "abgelehnt"])))
        .orderBy(de(anmeldungAntraege.childLastName), de(anmeldungAntraege.childFirstName))
    : [];
  await auditRead(db, viewer.userId, "lesen.anmeldung", `${verfahrenId}:${day}`, { tagesliste: true }, now);
  return slots.map((s) => ({
    slot: s,
    antraege: rows
      .filter((a) => a.slotId === s.id)
      .map((a) => ({
        id: a.id,
        number: antragNumber(a.year, a.seq),
        child: `${a.childLastName}, ${a.childFirstName}`,
        parent: a.parent1Name,
        phone: a.parent1Phone,
        status: a.status,
        sibling: a.sibling,
      })),
  }));
}

/** Für das Widget: offene Verfahren mit Zahl neuer (bestätigter, noch nicht vollständiger) Anträge und Gesprächen heute. */
export async function widgetSummary(db: Db, viewer: PermissionSet, today: string) {
  assertView(viewer);
  const list = await db
    .select({ id: anmeldungVerfahren.id, name: anmeldungVerfahren.name })
    .from(anmeldungVerfahren)
    .where(inArray(anmeldungVerfahren.status, ["offen", "geschlossen"]))
    .orderBy(asc(anmeldungVerfahren.closesAt));
  const from = fromBerlinLocal(`${today}T00:00`);
  const to = fromBerlinLocal(`${addDays(today, 1)}T00:00`);
  return Promise.all(
    list.map(async (v) => {
      const [neu] = await db
        .select({ n: count() })
        .from(anmeldungAntraege)
        .where(and(eq(anmeldungAntraege.verfahrenId, v.id), inArray(anmeldungAntraege.status, ["eingegangen", "termin"])));
      const [heute] = await db
        .select({ n: count() })
        .from(anmeldungAntraege)
        .innerJoin(anmeldungSlots, eq(anmeldungSlots.id, anmeldungAntraege.slotId))
        .where(and(eq(anmeldungAntraege.verfahrenId, v.id), inArray(anmeldungAntraege.status, ["termin", "vollstaendig"]), gte(anmeldungSlots.startsAt, from), lt(anmeldungSlots.startsAt, to)));
      return { ...v, open: neu?.n ?? 0, today: heute?.n ?? 0 };
    }),
  );
}

/**
 * Gong an alle mit `anmeldung.manage`, gesammelt: liegt noch ein ungelesener Gong zu diesem Verfahren, wird er durch
 * „N neue Anmeldungen“ ersetzt statt einen weiteren zu schicken. Ohne Namen – nur Verfahren und Anzahl.
 */
export async function gongNewAntrag(db: Db, verfahrenId: string): Promise<void> {
  const [v] = await db.select({ name: anmeldungVerfahren.name }).from(anmeldungVerfahren).where(eq(anmeldungVerfahren.id, verfahrenId));
  if (!v) return;
  const href = `/verwaltung/anmeldung/${verfahrenId}/antraege`;
  const ids = await usersWithPermission(db, "anmeldung.manage");
  if (!ids.length) return;
  const unread = await db
    .select({ id: notifications.id, userId: notifications.userId, title: notifications.title })
    .from(notifications)
    .where(and(inArray(notifications.userId, ids), eq(notifications.moduleId, "anmeldung"), eq(notifications.href, href), isNull(notifications.readAt)));
  const byCount = new Map<number, string[]>();
  for (const id of ids) {
    const prev = unread.filter((u) => u.userId === id);
    const before = prev.reduce((m, u) => Math.max(m, Number(/^(\d+)/.exec(u.title)?.[1] ?? "1")), 0);
    const n = before + 1;
    byCount.set(n, [...(byCount.get(n) ?? []), id]);
  }
  if (unread.length) await db.delete(notifications).where(inArray(notifications.id, unread.map((u) => u.id)));
  for (const [n, users] of byCount)
    await notify(db, users, { moduleId: "anmeldung", title: n === 1 ? "1 neue Anmeldung" : `${n} neue Anmeldungen`, body: v.name, href });
}
