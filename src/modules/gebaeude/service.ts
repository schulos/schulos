// Gebäude & Technik (P4-11…P4-14): Mängel und Störungen melden und abarbeiten – Status-Maschine, Sichtbarkeit
// (Melder:in sieht eigene Meldungen, „manage“/„view_all“ alle), Zuständigkeit je Kategorie (Q-22), Fotos ohne Metadaten
// (Q-24), Raumsperre aus dem Ticket über stundenplan/raumsperren.ts. Keine Auswertung je Person (DATENSCHUTZ §5).
import { scanUpload } from "@/modules/upload-scan";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, max, ne, or, sql, type SQL } from "drizzle-orm";
import type { MailConfig, MailMessage, Sender } from "@schulos/server/mail";
import { smtpSender } from "@schulos/server/mail";
import type { Db } from "@/core/db/client";
import {
  bookingResources,
  bookings,
  gebaeudeResponsibilities,
  gebaeudeTicketEvents,
  gebaeudeTicketPhotos,
  gebaeudeTickets,
  groupMembers,
  groups,
  rooms,
  timetableRoomBlocks,
  users,
} from "@/core/db/schema";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import { cleanImage, type ImageRules } from "@/core/images";
import { notify } from "@/core/notifications";
import { consumeRate, RATE_RULES } from "@/core/rate-limit";
import { ForbiddenError, hasPermission, loadPermissions, usersWithPermission, type PermissionSet } from "@/core/permissions";
import { TZ, addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { createRoomBlock, endRoomBlock } from "@/modules/stundenplan/raumsperren";
import { ValidationError } from "@/modules/verwaltung/users";
import {
  CATEGORY_LABELS,
  MAX_PHOTO_MB,
  MAX_PHOTOS,
  OPEN_STATUSES,
  STATUS_LABELS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TRANSITIONS,
  isClosed,
  ticketNumber,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from "./labels";

export * from "./labels";

const MODULE = "gebaeude";
/** Offene Meldung gilt ab so vielen Tagen ohne Abschluss als überfällig (Widget „Überfällig“). */
export const OVERDUE_DAYS = 14;

// ---------------------------------------------------------------- Rechte

export const canReport = (p: PermissionSet) => hasPermission(p, "gebaeude.report");
export const canManage = (p: PermissionSet) => hasPermission(p, "gebaeude.manage");
export const canViewAll = (p: PermissionSet) => canManage(p) || hasPermission(p, "gebaeude.view_all");
/** Darf das Modul überhaupt benutzen (Seiten, Suche)? Auch wer nur einrichtet (Prüfarten, Anlagen). */
export const canUse = (p: PermissionSet) => canReport(p) || canViewAll(p) || hasPermission(p, "gebaeude.configure");

/** Rein: erlaubter Statuswechsel? */
export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Sichtbarkeit: „manage“/„view_all“ alles, sonst nur eigene Meldungen. */
function visibleWhere(viewer: PermissionSet): SQL | undefined {
  return canViewAll(viewer) ? undefined : eq(gebaeudeTickets.reporterId, viewer.userId);
}

// ---------------------------------------------------------------- Fotos

/** Fotos einer Meldung (Q-24): höchstens 5 MB, nur JPEG/PNG/WebP, Metadaten (EXIF mit Aufnahmeort) fallen weg. */
const PHOTO_RULES: ImageRules = {
  field: "photos",
  maxBytes: MAX_PHOTO_MB * 1024 * 1024,
  types: ["image/jpeg", "image/png", "image/webp"],
  empty: "Foto ist leer",
  tooBig: `Ein Foto ist zu groß (höchstens ${MAX_PHOTO_MB} MB)`,
  wrongType: "Nur Fotos im Format JPEG, PNG oder WebP",
};

function cleanPhotos(photos: readonly Uint8Array[], already = 0) {
  const list = photos.filter((p) => p.length > 0);
  if (already + list.length > MAX_PHOTOS) throw new ValidationError({ photos: `Höchstens ${MAX_PHOTOS} Fotos je Meldung` });
  return list.map((b) => cleanImage(b, PHOTO_RULES));
}

async function storePhotos(db: Db, storage: FileStorage, ticketId: string, actorId: string, cleaned: ReturnType<typeof cleanPhotos>) {
  // P4-72: Virenscan vor dem Speichern (alle Fotos, dann erst schreiben)
  for (const [i, p] of cleaned.entries()) await scanUpload(p.data, `Foto ${i + 1}`, "photos");
  for (const p of cleaned) {
    const key = newStorageKey();
    await storage.put(key, p.data);
    await db.insert(gebaeudeTicketPhotos).values({
      ticketId,
      storageKey: key,
      mime: p.mime,
      size: p.data.length,
      width: p.size?.width ?? null,
      height: p.size?.height ?? null,
      createdBy: actorId,
    });
  }
}

// ---------------------------------------------------------------- Zuständigkeit

/** Wer bekommt den Gong für eine Kategorie? Gruppe der Kategorie, sonst die der Kategorie „gebaeude“, sonst alle mit „manage“. */
export async function responsibleUsers(db: Db, category: TicketCategory): Promise<string[]> {
  const rows = await db.select().from(gebaeudeResponsibilities).where(inArray(gebaeudeResponsibilities.category, [category, "gebaeude"]));
  const row = rows.find((r) => r.category === category) ?? rows.find((r) => r.category === "gebaeude");
  if (!row) return usersWithPermission(db, "gebaeude.manage");
  const members = await db
    .select({ id: groupMembers.userId })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, row.groupId), eq(users.status, "active")));
  return members.map((m) => m.id);
}

/** Zuständigkeitsgruppe je Kategorie setzen (null = Vorgabe). Recht `gebaeude.configure`. */
export async function setResponsibility(db: Db, viewer: PermissionSet, category: TicketCategory, groupId: string | null): Promise<void> {
  if (!hasPermission(viewer, "gebaeude.configure")) throw new ForbiddenError("gebaeude.configure");
  if (!TICKET_CATEGORIES.includes(category)) throw new ValidationError({ category: "Kategorie wählen" });
  if (!groupId) {
    await db.delete(gebaeudeResponsibilities).where(eq(gebaeudeResponsibilities.category, category));
    return;
  }
  const [current] = await db.select().from(gebaeudeResponsibilities).where(eq(gebaeudeResponsibilities.category, category));
  if (current?.groupId === groupId) return; // unverändert (auch eine inzwischen archivierte Gruppe bleibt so stehen)
  const [g] = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId));
  if (!g) throw new ValidationError({ groupId: "Gruppe gibt es nicht" });
  // Gongs nennen Titel und Ort der Meldung – nicht an Gruppen mit Schüler:innen oder Eltern (Security-Review Gate 4a Hinweis 7)
  const [young] = await db
    .select({ n: count() })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), inArray(users.role, ["schueler", "eltern"])));
  if ((young?.n ?? 0) > 0) throw new ValidationError({ [`group-${category}`]: "Gruppe mit Schüler:innen oder Eltern kann nicht zuständig sein" });
  await db.insert(gebaeudeResponsibilities).values({ category, groupId }).onConflictDoUpdate({ target: gebaeudeResponsibilities.category, set: { groupId } });
}

export async function listResponsibilities(db: Db) {
  return db
    .select({ category: gebaeudeResponsibilities.category, groupId: groups.id, groupName: groups.name })
    .from(gebaeudeResponsibilities)
    .innerJoin(groups, eq(groups.id, gebaeudeResponsibilities.groupId));
}

// ---------------------------------------------------------------- Melden

export interface TicketInput {
  category: string;
  priority: string;
  roomId: string | null;
  location: string | null;
  title: string;
  description: string;
  photos: readonly Uint8Array[];
}

/** Alarm-Mail bei „Gefahr“ (B-38-Mechanik): nur mit SMTP-Konfiguration, an die Alarm-Empfänger. */
export interface MailOptions {
  config: MailConfig | null;
  sender?: Sender;
  server?: string;
}

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

const href = (id: string) => `/gebaeude/${id}`;

/**
 * Drossel je Person (Security-Review Gate 4a N3): Meldungen je Stunde, Gefahr-Alarm (Mail + Gong an die Verwaltung) je
 * Stunde – über die Core-Rate-Limits (P4-31, Regeln „gebaeude.meldung“/„gebaeude.gefahr“) statt einer Zählung der Meldungen.
 */
export const MAX_TICKETS_PER_HOUR = RATE_RULES["gebaeude.meldung"].max;
export const MAX_DANGER_ALARMS_PER_HOUR = RATE_RULES["gebaeude.gefahr"].max;

/** Rein: Alarm-Mail ohne Personennamen – Nummer, Kategorie, Ort, Titel. */
export function dangerMessage(server: string, to: string[], t: { number: string; category: TicketCategory; place: string; title: string }): MailMessage {
  return {
    to,
    subject: `[${server}] Gefahr gemeldet: ${t.title} (${t.number})`,
    text: [
      `In ${server} wurde ein Mangel mit Priorität „Gefahr“ gemeldet.`,
      "",
      `Meldung: ${t.number}`,
      `Kategorie: ${CATEGORY_LABELS[t.category]}`,
      `Ort: ${t.place}`,
      `Was: ${t.title}`,
      "",
      "Details stehen in SchulOS unter Gebäude & Technik.",
    ].join("\n"),
  };
}

export async function createTicket(
  db: Db,
  storage: FileStorage,
  viewer: PermissionSet,
  input: TicketInput,
  opts: { now?: Date; mail?: MailOptions; /** false: interne Meldungen (Mängel aus Prüfungen) ohne Drossel */ rateLimit?: boolean } = {},
): Promise<{ id: string; number: string; alarm: boolean }> {
  if (!canReport(viewer) && !canManage(viewer)) throw new ForbiddenError("gebaeude.report");
  const fe: Record<string, string> = {};
  const title = input.title.trim();
  const description = input.description.trim();
  const location = input.location?.trim() || null;
  const roomId = input.roomId?.trim() || null;
  if (!(TICKET_CATEGORIES as readonly string[]).includes(input.category)) fe.category = "Kategorie wählen";
  if (!(TICKET_PRIORITIES as readonly string[]).includes(input.priority)) fe.priority = "Priorität wählen";
  if (title.length < 3) fe.title = "Kurz beschreiben, was los ist (mind. 3 Zeichen)";
  else if (title.length > 120) fe.title = "Bitte kürzer (höchstens 120 Zeichen)";
  if (description.length > 4000) fe.description = "Bitte kürzer (höchstens 4000 Zeichen)";
  if (location && location.length > 120) fe.location = "Bitte kürzer (höchstens 120 Zeichen)";
  let roomName: string | null = null;
  if (roomId) {
    const [r] = await db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(eq(rooms.id, roomId));
    if (!r) fe.roomId = "Raum gibt es nicht";
    else roomName = r.id === r.name ? `Raum ${r.id}` : `${r.name} (${r.id})`;
  } else if (!location) fe.roomId = "Raum wählen oder Ort angeben";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  const cleaned = cleanPhotos(input.photos);

  const now = opts.now ?? new Date();
  const limited = opts.rateLimit !== false;
  if (limited && !(await consumeRate(db, "gebaeude.meldung", viewer.userId, now)).allowed)
    throw new ValidationError({ title: `Zu viele Meldungen in kurzer Zeit (höchstens ${MAX_TICKETS_PER_HOUR} je Stunde) – bitte später noch einmal` });
  const year = Number(toBerlinDate(now).slice(0, 4));
  let row: { id: string; seq: number } | undefined;
  for (let attempt = 0; !row; attempt++) {
    const [m] = await db.select({ m: max(gebaeudeTickets.seq) }).from(gebaeudeTickets).where(eq(gebaeudeTickets.year, year));
    try {
      [row] = await db
        .insert(gebaeudeTickets)
        .values({
          year,
          seq: (m?.m ?? 0) + 1,
          category: input.category as TicketCategory,
          priority: input.priority as TicketPriority,
          roomId,
          location,
          title,
          description,
          reporterId: viewer.userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: gebaeudeTickets.id, seq: gebaeudeTickets.seq });
    } catch (err) {
      // zwei Meldungen gleichzeitig: nächste Nummer versuchen
      if (!isUniqueViolation(err) || attempt >= 4) throw err;
    }
  }
  const number = ticketNumber(year, row!.seq);
  const ticketId = row!.id;
  await db.insert(gebaeudeTicketEvents).values({ ticketId, actorId: viewer.userId, kind: "status", statusTo: "neu", at: now });
  await storePhotos(db, storage, ticketId, viewer.userId, cleaned);

  const category = input.category as TicketCategory;
  const danger = input.priority === "gefahr";
  // Alarm (Gong an die Verwaltung, Mail) höchstens MAX_DANGER_ALARMS_PER_HOUR-mal je Person und Stunde; die Meldung selbst
  // und der Gong an die Zuständigen gehen immer raus
  const alarm = danger && (!limited || (await consumeRate(db, "gebaeude.gefahr", viewer.userId, now)).allowed);
  const place = [roomName, location].filter(Boolean).join(", ");
  const recipients = new Set(await responsibleUsers(db, category));
  if (alarm) for (const u of await usersWithPermission(db, "verwaltung.access")) recipients.add(u);
  recipients.delete(viewer.userId);
  await notify(db, [...recipients], {
    moduleId: MODULE,
    title: `${danger ? "Gefahr: " : "Neue Meldung: "}${title}`,
    body: `${number} · ${CATEGORY_LABELS[category]} · ${place}`,
    href: href(ticketId),
  });
  if (alarm && opts.mail?.config) {
    const cfg = opts.mail.config;
    try {
      await (opts.mail.sender ?? smtpSender(cfg))(dangerMessage(opts.mail.server ?? "SchulOS", cfg.to, { number, category, place, title }));
    } catch (err) {
      // die Meldung ist gespeichert und der Gong raus – eine fehlgeschlagene Mail darf das Melden nicht scheitern lassen
      console.error("[gebaeude] Alarm-Mail fehlgeschlagen:", err);
    }
  }
  return { id: ticketId, number, alarm };
}

// ---------------------------------------------------------------- Lesen

/** Schüler:innen und Eltern sehen keine Namen von Personal (S25) – nur „Schulpersonal“. */
const hidesStaffNames = (viewer: PermissionSet) => viewer.role === "schueler" || viewer.role === "eltern";
function withoutStaffNames<T extends { reporterId: string | null; reporterName: string | null; assigneeId: string | null; assigneeName: string | null }>(viewer: PermissionSet, t: T): T {
  if (!hidesStaffNames(viewer)) return t;
  return { ...t, reporterName: t.reporterId === viewer.userId ? t.reporterName : null, assigneeName: t.assigneeId ? "Schulpersonal" : null };
}

const reporter = sql<string | null>`(select name from users u where u.id = ${gebaeudeTickets.reporterId})`;
const assignee = sql<string | null>`(select name from users u where u.id = ${gebaeudeTickets.assigneeId})`;

const ticketColumns = {
  id: gebaeudeTickets.id,
  year: gebaeudeTickets.year,
  seq: gebaeudeTickets.seq,
  category: gebaeudeTickets.category,
  priority: gebaeudeTickets.priority,
  status: gebaeudeTickets.status,
  roomId: gebaeudeTickets.roomId,
  building: rooms.building,
  location: gebaeudeTickets.location,
  title: gebaeudeTickets.title,
  reporterId: gebaeudeTickets.reporterId,
  reporterName: reporter,
  assigneeId: gebaeudeTickets.assigneeId,
  assigneeName: assignee,
  roomBlockId: gebaeudeTickets.roomBlockId,
  createdAt: gebaeudeTickets.createdAt,
  updatedAt: gebaeudeTickets.updatedAt,
  closedAt: gebaeudeTickets.closedAt,
};

export type TicketRow = Awaited<ReturnType<typeof listTickets>>[number];

export interface TicketFilter {
  /** "open" (Vorgabe), "closed" oder "all" */
  state?: "open" | "closed" | "all";
  category?: TicketCategory;
  priority?: TicketPriority;
  building?: string;
  /** nur eigene Meldungen, auch für „manage“ */
  mine?: boolean;
  /** abgeschlossene nur aus den letzten n Tagen */
  closedWithinDays?: number;
  limit?: number;
}

/** Meldungen, die der Betrachter sehen darf – mit Nummer, Ort und Namen von Melder:in/Bearbeiter:in. */
export async function listTickets(db: Db, viewer: PermissionSet, f: TicketFilter = {}) {
  const parts: (SQL | undefined)[] = [visibleWhere(viewer)];
  const state = f.state ?? "open";
  if (state === "open") parts.push(isNull(gebaeudeTickets.closedAt));
  if (state === "closed") parts.push(sql`${gebaeudeTickets.closedAt} is not null`);
  if (f.closedWithinDays) parts.push(or(isNull(gebaeudeTickets.closedAt), gte(gebaeudeTickets.closedAt, new Date(Date.now() - f.closedWithinDays * 86_400_000))));
  if (f.category) parts.push(eq(gebaeudeTickets.category, f.category));
  if (f.priority) parts.push(eq(gebaeudeTickets.priority, f.priority));
  if (f.building) parts.push(eq(rooms.building, f.building));
  if (f.mine) parts.push(eq(gebaeudeTickets.reporterId, viewer.userId));
  const rows = await db
    .select(ticketColumns)
    .from(gebaeudeTickets)
    .leftJoin(rooms, eq(rooms.id, gebaeudeTickets.roomId))
    .where(and(...parts))
    // Gefahr zuerst, dann neueste
    .orderBy(sql`case ${gebaeudeTickets.priority} when 'gefahr' then 0 when 'hoch' then 1 when 'normal' then 2 else 3 end`, desc(gebaeudeTickets.createdAt))
    .limit(f.limit ?? 500);
  return rows.map((r) => ({ ...withoutStaffNames(viewer, r), number: ticketNumber(r.year, r.seq) }));
}

/** Gebäude der Räume (Filter im Board). */
export async function buildings(db: Db): Promise<string[]> {
  const rows = await db.selectDistinct({ b: rooms.building }).from(rooms).where(sql`${rooms.building} is not null`);
  return rows
    .map((r) => r.b!)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "de"));
}

/** Eine Meldung mit Fotos und Verlauf – null, wenn es sie nicht gibt oder der Betrachter sie nicht sehen darf. */
export async function getTicket(db: Db, viewer: PermissionSet, id: string) {
  const [t] = await db
    .select({ ...ticketColumns, description: gebaeudeTickets.description, roomName: rooms.name, floor: rooms.floor })
    .from(gebaeudeTickets)
    .leftJoin(rooms, eq(rooms.id, gebaeudeTickets.roomId))
    .where(and(eq(gebaeudeTickets.id, id), visibleWhere(viewer)));
  if (!t) return null;
  const [photos, events] = await Promise.all([
    db
      .select({ id: gebaeudeTicketPhotos.id, mime: gebaeudeTicketPhotos.mime, width: gebaeudeTicketPhotos.width, height: gebaeudeTicketPhotos.height })
      .from(gebaeudeTicketPhotos)
      .where(eq(gebaeudeTicketPhotos.ticketId, id))
      .orderBy(asc(gebaeudeTicketPhotos.createdAt)),
    db
      .select({
        id: gebaeudeTicketEvents.id,
        at: gebaeudeTicketEvents.at,
        kind: gebaeudeTicketEvents.kind,
        statusFrom: gebaeudeTicketEvents.statusFrom,
        statusTo: gebaeudeTicketEvents.statusTo,
        text: gebaeudeTicketEvents.text,
        actorName: users.name,
      })
      .from(gebaeudeTicketEvents)
      .leftJoin(users, eq(users.id, gebaeudeTicketEvents.actorId))
      .where(eq(gebaeudeTicketEvents.ticketId, id))
      .orderBy(asc(gebaeudeTicketEvents.at), asc(gebaeudeTicketEvents.id)),
  ]);
  const manage = canManage(viewer);
  const own = t.reporterId === viewer.userId;
  // Personal ist für Schüler:innen und Eltern nicht sichtbar (S25) – meldet z. B. eine SV-Gruppe, bleiben Namen der
  // Bearbeitung weg (Security-Review Gate 4a Hinweis 5)
  const hideNames = hidesStaffNames(viewer);
  return {
    ticket: { ...withoutStaffNames(viewer, t), number: ticketNumber(t.year, t.seq) },
    photos,
    events: hideNames
      ? events.map((e) => ({ ...e, actorName: null, text: e.kind === "zuweisung" ? (e.text?.startsWith("zugewiesen") ? "zugewiesen" : e.text) : e.text }))
      : events,
    manage,
    canComment: manage || own,
    canAddPhotos: (manage || own) && !isClosed(t.status) && photos.length < MAX_PHOTOS,
    transitions: manage ? TRANSITIONS[t.status] : [],
  };
}

async function loadTicket(db: Db, id: string) {
  const [t] = await db.select().from(gebaeudeTickets).where(eq(gebaeudeTickets.id, id));
  if (!t) throw new ValidationError({ ticket: "Meldung gibt es nicht" });
  return { ...t, number: ticketNumber(t.year, t.seq) };
}

// ---------------------------------------------------------------- Bearbeiten

/** Status weiterziehen (nur „manage“). Gong an Melder:in; „erledigt“ kann die Raumsperre beenden. */
export async function changeStatus(
  db: Db,
  viewer: PermissionSet,
  id: string,
  to: TicketStatus,
  opts: { comment?: string; endBlock?: boolean; todayYmd?: string; now?: Date } = {},
): Promise<void> {
  if (!canManage(viewer)) throw new ForbiddenError("gebaeude.manage");
  const t = await loadTicket(db, id);
  if (!canTransition(t.status, to)) throw new ValidationError({ status: `Von „${STATUS_LABELS[t.status]}“ geht es nicht nach „${STATUS_LABELS[to]}“` });
  const comment = opts.comment?.trim() || null;
  if (comment && comment.length > 2000) throw new ValidationError({ comment: "Bitte kürzer (höchstens 2000 Zeichen)" });
  const now = opts.now ?? new Date();
  await db
    .update(gebaeudeTickets)
    .set({
      status: to,
      closedAt: isClosed(to) ? now : null,
      updatedAt: now,
      // wer annimmt, bearbeitet – solange niemand zugewiesen ist
      ...(to === "angenommen" && !t.assigneeId ? { assigneeId: viewer.userId } : {}),
    })
    .where(eq(gebaeudeTickets.id, id));
  await db.insert(gebaeudeTicketEvents).values({ ticketId: id, actorId: viewer.userId, kind: "status", statusFrom: t.status, statusTo: to, text: comment, at: now });
  if (to === "erledigt" && opts.endBlock && t.roomBlockId) await endTicketBlock(db, viewer, id, opts.todayYmd ?? toBerlinDate(now));
  if (t.reporterId && t.reporterId !== viewer.userId) {
    await notify(db, [t.reporterId], {
      moduleId: MODULE,
      title: `Deine Meldung: ${STATUS_LABELS[to]}`,
      body: `${t.number} · ${t.title}${comment ? ` – ${comment.slice(0, 120)}` : ""}`,
      href: href(id),
    });
  }
}

/** Kommentar: „manage“ oder die meldende Person. Gong an die jeweils andere Seite. */
export async function addComment(db: Db, viewer: PermissionSet, id: string, text: string): Promise<void> {
  const t = await loadTicket(db, id);
  const own = t.reporterId === viewer.userId;
  if (!canManage(viewer) && !own) throw new ForbiddenError("gebaeude.manage");
  const body = text.trim();
  if (!body) throw new ValidationError({ comment: "Kommentar eingeben" });
  if (body.length > 2000) throw new ValidationError({ comment: "Bitte kürzer (höchstens 2000 Zeichen)" });
  await db.insert(gebaeudeTicketEvents).values({ ticketId: id, actorId: viewer.userId, kind: "kommentar", text: body });
  await db.update(gebaeudeTickets).set({ updatedAt: new Date() }).where(eq(gebaeudeTickets.id, id));
  const to = own ? (t.assigneeId ? [t.assigneeId] : await responsibleUsers(db, t.category)) : t.reporterId ? [t.reporterId] : [];
  await notify(
    db,
    to.filter((u) => u !== viewer.userId),
    { moduleId: MODULE, title: `Kommentar zu ${t.number}`, body: `${t.title}: ${body.slice(0, 120)}`, href: href(id) },
  );
}

/** Personen, denen man Meldungen zuweisen kann (alle aktiven mit „manage“, ohne Admin-Konten). */
export async function assigneeOptions(db: Db) {
  const ids = await usersWithPermission(db, "gebaeude.manage");
  if (!ids.length) return [];
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(inArray(users.id, ids), ne(users.role, "admin")))
    .orderBy(asc(users.lastName), asc(users.firstName));
}

/** Zuweisen (nur „manage“): an jemanden mit „manage“ oder niemanden. */
export async function assignTicket(db: Db, viewer: PermissionSet, id: string, assigneeId: string | null): Promise<void> {
  if (!canManage(viewer)) throw new ForbiddenError("gebaeude.manage");
  const t = await loadTicket(db, id);
  let name: string | null = null;
  if (assigneeId) {
    const [u] = await db.select({ name: users.name, status: users.status }).from(users).where(eq(users.id, assigneeId));
    if (!u || u.status !== "active" || !hasPermission(await loadPermissions(db, assigneeId), "gebaeude.manage"))
      throw new ValidationError({ assigneeId: "Diese Person bearbeitet keine Meldungen" });
    name = u.name;
  }
  if ((t.assigneeId ?? null) === assigneeId) return;
  await db.update(gebaeudeTickets).set({ assigneeId, updatedAt: new Date() }).where(eq(gebaeudeTickets.id, id));
  await db.insert(gebaeudeTicketEvents).values({ ticketId: id, actorId: viewer.userId, kind: "zuweisung", text: name ? `zugewiesen an ${name}` : "Zuweisung aufgehoben" });
  if (assigneeId && assigneeId !== viewer.userId) {
    await notify(db, [assigneeId], { moduleId: MODULE, title: `Dir zugewiesen: ${t.title}`, body: t.number, href: href(id) });
  }
}

/** Fotos nachreichen: Melder:in oder „manage“, solange die Meldung offen ist; zusammen höchstens drei. */
export async function addPhotos(db: Db, storage: FileStorage, viewer: PermissionSet, id: string, photos: readonly Uint8Array[]): Promise<number> {
  const t = await loadTicket(db, id);
  if (!canManage(viewer) && t.reporterId !== viewer.userId) throw new ForbiddenError("gebaeude.manage");
  if (isClosed(t.status)) throw new ValidationError({ photos: "Die Meldung ist abgeschlossen" });
  // Zählen und Eintragen atomar (Security-Review Gate 4a N3): parallele Aufrufe warten auf die Sperre der Meldung und sehen
  // den neuen Stand – sonst überschreiten zwei gleichzeitige Uploads die Grenze. Dateien abgebrochener Läufe räumt der
  // Aufräumlauf (sweepOrphanFiles) weg.
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`gebaeude:fotos:${id}`}))`);
    const [existing] = await tx.select({ n: count() }).from(gebaeudeTicketPhotos).where(eq(gebaeudeTicketPhotos.ticketId, id));
    const cleaned = cleanPhotos(photos, existing?.n ?? 0);
    if (!cleaned.length) throw new ValidationError({ photos: "Bitte ein Foto auswählen" });
    await storePhotos(tx, storage, id, viewer.userId, cleaned);
    await tx.insert(gebaeudeTicketEvents).values({ ticketId: id, actorId: viewer.userId, kind: "foto", text: cleaned.length === 1 ? "1 Foto hinzugefügt" : `${cleaned.length} Fotos hinzugefügt` });
    return cleaned.length;
  });
}

/** Foto für die Auslieferung – nur, wenn der Betrachter die Meldung sehen darf. */
export async function photoFor(db: Db, viewer: PermissionSet, photoId: string) {
  const [p] = await db
    .select({ storageKey: gebaeudeTicketPhotos.storageKey, mime: gebaeudeTicketPhotos.mime, size: gebaeudeTicketPhotos.size })
    .from(gebaeudeTicketPhotos)
    .innerJoin(gebaeudeTickets, eq(gebaeudeTickets.id, gebaeudeTicketPhotos.ticketId))
    .where(and(eq(gebaeudeTicketPhotos.id, photoId), visibleWhere(viewer)));
  return p ?? null;
}

// ---------------------------------------------------------------- Raumsperre (P4-14)

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", timeZone: TZ });
const day = (ymd: string) => dayFmt.format(fromBerlinLocal(ymd));

/** Rein: „12.10.–16.10., 3.–4. Std.“ */
export function blockSpan(b: { startsOn: string; endsOn: string; fromPeriod: number | null; toPeriod: number | null }): string {
  const days = b.startsOn === b.endsOn ? day(b.startsOn) : `${day(b.startsOn)}–${day(b.endsOn)}`;
  const hours = b.fromPeriod === null ? "ganzer Tag" : b.fromPeriod === b.toPeriod ? `${b.fromPeriod}. Std.` : `${b.fromPeriod}.–${b.toPeriod}. Std.`;
  return `${days}, ${hours}`;
}

export interface TicketBlockInput {
  startsOn: string;
  endsOn: string;
  fromPeriod: number | null;
  toPeriod: number | null;
}

/**
 * Raum aus der Meldung sperren (nur „manage“): Raumsperre mit Grund „defekt“ über raumsperren.ts – der Stundenplan zeigt
 * die betroffenen Stunden als Vertretungsbedarf mit Ausweichräumen. Ticket und Sperre verweisen aufeinander.
 */
export async function blockRoomFromTicket(db: Db, viewer: PermissionSet, id: string, input: TicketBlockInput, todayYmd: string): Promise<string> {
  if (!canManage(viewer)) throw new ForbiddenError("gebaeude.manage");
  const t = await loadTicket(db, id);
  if (!t.roomId) throw new ValidationError({ roomId: "Die Meldung hat keinen Raum" });
  if (isClosed(t.status)) throw new ValidationError({ status: "Die Meldung ist abgeschlossen" });
  if (t.roomBlockId) {
    const [old] = await db.select({ endsOn: timetableRoomBlocks.endsOn }).from(timetableRoomBlocks).where(eq(timetableRoomBlocks.id, t.roomBlockId));
    if (old && old.endsOn >= todayYmd) throw new ValidationError({ startsOn: "Der Raum ist für diese Meldung schon gesperrt" });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.endsOn || input.startsOn) && (input.endsOn || input.startsOn) < todayYmd) throw new ValidationError({ endsOn: "Der Zeitraum liegt in der Vergangenheit" });
  const blockId = await createRoomBlock(db, viewer.userId, {
    roomId: t.roomId,
    startsOn: input.startsOn,
    endsOn: input.endsOn || input.startsOn,
    fromPeriod: input.fromPeriod,
    toPeriod: input.toPeriod,
    reason: "defekt",
    note: `${t.number}: ${t.title}`.slice(0, 80),
  });
  await db.update(gebaeudeTickets).set({ roomBlockId: blockId, updatedAt: new Date() }).where(eq(gebaeudeTickets.id, id));
  const span = blockSpan({ startsOn: input.startsOn, endsOn: input.endsOn || input.startsOn, fromPeriod: input.fromPeriod, toPeriod: input.toPeriod });
  await db.insert(gebaeudeTicketEvents).values({ ticketId: id, actorId: viewer.userId, kind: "raumsperre", text: `Raum ${t.roomId} gesperrt: ${span}` });
  return blockId;
}

/** Raumsperre der Meldung beenden (nur „manage“): ab heute ist der Raum wieder frei. */
export async function endTicketBlock(db: Db, viewer: PermissionSet, id: string, todayYmd: string): Promise<boolean> {
  if (!canManage(viewer)) throw new ForbiddenError("gebaeude.manage");
  const t = await loadTicket(db, id);
  if (!t.roomBlockId) return false;
  const result = await endRoomBlock(db, viewer.userId, t.roomBlockId, todayYmd);
  if (!result) return false;
  await db.insert(gebaeudeTicketEvents).values({ ticketId: id, actorId: viewer.userId, kind: "raumsperre", text: `Sperre von Raum ${t.roomId} beendet` });
  return true;
}

/**
 * Sperre der Meldung samt Hinweis auf Buchungen im Zeitraum. Buchungen kennen keine Raumsperren – deshalb Hinweis statt
 * Blockade: die Bearbeitung sieht, wen sie informieren sollte. Die Buchungen (mit Namen) nur für „manage“ – Melder:innen
 * sehen nur die Sperre (Security-Review Gate 4a N4, Code-Review N7).
 */
export async function ticketBlock(db: Db, viewer: PermissionSet, roomBlockId: string | null, todayYmd: string) {
  if (!roomBlockId) return null;
  const [b] = await db.select().from(timetableRoomBlocks).where(eq(timetableRoomBlocks.id, roomBlockId));
  if (!b) return null;
  if (!canManage(viewer)) return { block: b, active: b.endsOn >= todayYmd, span: blockSpan(b), bookings: [] };
  const booked = await db
    .select({ date: bookings.date, periodNr: bookings.periodNr, byName: users.name })
    .from(bookings)
    .innerJoin(bookingResources, eq(bookingResources.id, bookings.resourceId))
    .leftJoin(users, eq(users.id, bookings.bookedBy))
    .where(
      and(
        eq(bookingResources.roomId, b.roomId),
        gte(bookings.date, b.startsOn > todayYmd ? b.startsOn : todayYmd),
        lte(bookings.date, b.endsOn),
        b.fromPeriod === null ? undefined : and(gte(bookings.periodNr, b.fromPeriod), lte(bookings.periodNr, b.toPeriod ?? b.fromPeriod)),
      ),
    )
    .orderBy(asc(bookings.date), asc(bookings.periodNr));
  return { block: b, active: b.endsOn >= todayYmd, span: blockSpan(b), bookings: booked };
}

// ---------------------------------------------------------------- Widgets und Suche

/** Eigene offene Meldungen (Widget „Meine Meldungen“). */
export async function myOpenTickets(db: Db, viewer: PermissionSet, limit = 5) {
  return listTickets(db, viewer, { mine: true, state: "open", limit });
}

/** Überblick für die Bearbeitung: offene je Status, Gefahr, überfällig (länger als OVERDUE_DAYS offen). */
export async function openSummary(db: Db, now = new Date()) {
  const rows = await db
    .select({ status: gebaeudeTickets.status, priority: gebaeudeTickets.priority, createdAt: gebaeudeTickets.createdAt })
    .from(gebaeudeTickets)
    .where(isNull(gebaeudeTickets.closedAt));
  const limit = fromBerlinLocal(addDays(toBerlinDate(now), -OVERDUE_DAYS)).getTime();
  const byStatus = Object.fromEntries(OPEN_STATUSES.map((s) => [s, 0])) as Record<(typeof OPEN_STATUSES)[number], number>;
  let danger = 0;
  let overdue = 0;
  for (const r of rows) {
    if (r.status in byStatus) byStatus[r.status as keyof typeof byStatus]++;
    if (r.priority === "gefahr") danger++;
    if (r.createdAt.getTime() < limit) overdue++;
  }
  return { total: rows.length, byStatus, danger, overdue };
}

/** Überfällige offene Meldungen (älteste zuerst). */
export async function overdueTickets(db: Db, viewer: PermissionSet, now = new Date(), limit = 5) {
  const cutoff = fromBerlinLocal(addDays(toBerlinDate(now), -OVERDUE_DAYS));
  const rows = await listTickets(db, viewer, { state: "open" });
  return rows
    .filter((r) => r.createdAt < cutoff)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, limit);
}

/** Suche: Nummer („M-2026-0042“ bzw. „42“), Titel, Ort, Raum – nur sichtbare Meldungen. */
export async function searchTickets(db: Db, viewer: PermissionSet, q: string, limit = 5) {
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const num = /^(?:m-?)?(?:(\d{4})-)?0*(\d{1,6})$/i.exec(term);
  const match = or(
    ilike(gebaeudeTickets.title, like),
    ilike(gebaeudeTickets.location, like),
    ilike(gebaeudeTickets.roomId, like),
    num ? and(eq(gebaeudeTickets.seq, Number(num[2])), num[1] ? eq(gebaeudeTickets.year, Number(num[1])) : undefined) : undefined,
  );
  const rows = await db
    .select(ticketColumns)
    .from(gebaeudeTickets)
    .leftJoin(rooms, eq(rooms.id, gebaeudeTickets.roomId))
    .where(and(match, visibleWhere(viewer)))
    .orderBy(desc(gebaeudeTickets.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...withoutStaffNames(viewer, r), number: ticketNumber(r.year, r.seq) }));
}
