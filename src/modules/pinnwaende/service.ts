// Pinnwände (P3-08): je Gruppe (Gruppenmerkmal) oder frei mit Mitgliedern; Spalten und Karten (Text, Link, Datei aus dem
// Gruppenordner), Modus „nur Leitung“ / „alle posten“ / „moderiert“; jede Änderung geht live an alle Mitglieder (SSE).
import { and, asc, eq, inArray, isNull, max, notInArray, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import {
  BOARD_MODES,
  boardCards,
  boardColumns,
  boardMembers,
  boards,
  CARD_KINDS,
  fileNodes,
  groupFeatures,
  groupMembers,
  groups,
  users,
  type BoardMode,
  type CardKind,
} from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { publish } from "@/core/notifications/bus";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";

export const BOARD_FEATURE = "pinnwaende.board";
const STAFF = ["lehrkraft", "verwaltung", "admin"];
export const MODE_LABELS: Record<BoardMode, string> = { leitung: "Nur Leitung postet", alle: "Alle posten", moderiert: "Alle posten, Leitung gibt frei" };

export type BoardRole = "leader" | "member";

/** Rolle des Betrachters auf einer Pinnwand oder null (kein Zugriff). */
async function roleOn(db: Db, viewer: PermissionSet, board: typeof boards.$inferSelect): Promise<BoardRole | null> {
  if (board.groupId) {
    if (!viewer.memberOf.has(board.groupId)) return null;
    const [f] = await db.select().from(groupFeatures).where(and(eq(groupFeatures.groupId, board.groupId), eq(groupFeatures.feature, BOARD_FEATURE)));
    if (!f) return null;
    return viewer.leaderOf.has(board.groupId) || STAFF.includes(viewer.role) ? "leader" : "member";
  }
  if (board.ownerId === viewer.userId) return "leader";
  const [m] = await db.select().from(boardMembers).where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.userId, viewer.userId)));
  return m ? (m.leader ? "leader" : "member") : null;
}

async function access(db: Db, viewer: PermissionSet, boardId: string) {
  const [board] = await db.select().from(boards).where(eq(boards.id, boardId));
  if (!board) return null;
  const role = await roleOn(db, viewer, board);
  return role ? { board, role } : null;
}

async function requireRole(db: Db, viewer: PermissionSet, boardId: string, need: BoardRole) {
  const a = await access(db, viewer, boardId);
  if (!a || (need === "leader" && a.role !== "leader")) throw new ForbiddenError("pinnwaende.write");
  return a;
}

/** Alle, die eine Pinnwand sehen – Empfänger:innen des Live-Ereignisses. */
async function audience(db: Db, board: typeof boards.$inferSelect): Promise<string[]> {
  if (board.groupId) return (await db.select({ id: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, board.groupId))).map((r) => r.id);
  const members = (await db.select({ id: boardMembers.userId }).from(boardMembers).where(eq(boardMembers.boardId, board.id))).map((r) => r.id);
  return board.ownerId ? [...new Set([board.ownerId, ...members])] : members;
}

/** Nach jeder Änderung: Zeitstempel (Löschfrist) und Live-Ereignis an alle Mitglieder. */
async function changed(db: Db, board: typeof boards.$inferSelect, now = new Date()) {
  await db.update(boards).set({ updatedAt: now }).where(eq(boards.id, board.id));
  for (const id of await audience(db, board)) publish(id, { type: "board", boardId: board.id });
}

/** Gruppen, in denen der Betrachter eine Pinnwand anlegen darf: Leitung bzw. Personal, Merkmal aktiv. */
export async function boardGroups(db: Db, viewer: PermissionSet) {
  const ids = STAFF.includes(viewer.role) ? [...viewer.memberOf] : [...viewer.leaderOf];
  if (ids.length === 0) return [];
  return db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .innerJoin(groupFeatures, and(eq(groupFeatures.groupId, groups.id), eq(groupFeatures.feature, BOARD_FEATURE)))
    .where(and(inArray(groups.id, ids), isNull(groups.archivedAt)))
    .orderBy(de(groups.name));
}

/** Pinnwände des Betrachters: aus seinen Gruppen (Merkmal aktiv) und freie, auf denen er Mitglied ist. */
export async function listBoards(db: Db, viewer: PermissionSet) {
  const groupIds = viewer.memberOf.size
    ? (
        await db
          .select({ id: groupFeatures.groupId })
          .from(groupFeatures)
          .where(and(eq(groupFeatures.feature, BOARD_FEATURE), inArray(groupFeatures.groupId, [...viewer.memberOf])))
      ).map((r) => r.id)
    : [];
  const memberOf = (await db.select({ id: boardMembers.boardId }).from(boardMembers).where(eq(boardMembers.userId, viewer.userId))).map((r) => r.id);
  const conds = [eq(boards.ownerId, viewer.userId)];
  if (groupIds.length) conds.push(inArray(boards.groupId, groupIds));
  if (memberOf.length) conds.push(inArray(boards.id, memberOf));
  const rows = await db
    .select({ id: boards.id, title: boards.title, mode: boards.mode, groupId: boards.groupId, groupName: groups.name, updatedAt: boards.updatedAt })
    .from(boards)
    .leftJoin(groups, eq(groups.id, boards.groupId))
    .where(or(...conds))
    .orderBy(de(boards.title));
  return rows.filter((b) => b.groupId === null || groupIds.includes(b.groupId));
}

function checkTitle(title: string, field = "title", maxLen = 100) {
  const t = title.trim();
  if (!t) throw new ValidationError({ [field]: "Titel fehlt" });
  if (t.length > maxLen) throw new ValidationError({ [field]: `Höchstens ${maxLen} Zeichen` });
  return t;
}

/** Neue Pinnwand: in einer Gruppe (Leitung/Personal) oder frei (Recht „pinnwaende.create“); startet mit einer Spalte. */
export async function createBoard(db: Db, viewer: PermissionSet, input: { title: string; mode: BoardMode; groupId: string | null }, now = new Date()): Promise<string> {
  if (input.groupId) {
    if (!(await boardGroups(db, viewer)).some((g) => g.id === input.groupId)) throw new ForbiddenError("pinnwaende.create");
  } else if (!hasPermission(viewer, "pinnwaende.create")) throw new ForbiddenError("pinnwaende.create");
  if (!BOARD_MODES.includes(input.mode)) throw new ValidationError({ mode: "Unbekannter Modus" });
  const title = checkTitle(input.title);
  return db.transaction(async (tx) => {
    const [b] = await tx.insert(boards).values({ groupId: input.groupId, ownerId: viewer.userId, title, mode: input.mode, createdAt: now, updatedAt: now }).returning({ id: boards.id });
    await tx.insert(boardColumns).values({ boardId: b!.id, title: "Allgemein", position: 0 });
    return b!.id;
  });
}

/** Auf Monitoren nur Pinnwände, deren Karten die Leitung prüft (SEC-05) – im Modus „alle“ stünde Ungeprüftes im Foyer. */
export const MONITOR_MODES: readonly BoardMode[] = ["leitung", "moderiert"];

/** Wer auf der Pinnwand Leitung ist (wie roleOn): Gruppenleitung bzw. Personal der Gruppe, sonst Eigentümer:in + Leitungen. */
async function leaderIds(db: Db, board: typeof boards.$inferSelect): Promise<string[]> {
  if (board.groupId)
    return (
      await db
        .select({ id: groupMembers.userId })
        .from(groupMembers)
        .innerJoin(users, eq(users.id, groupMembers.userId))
        .where(and(eq(groupMembers.groupId, board.groupId), or(eq(groupMembers.role, "leader"), inArray(users.role, STAFF as (typeof users.$inferSelect.role)[]))))
    ).map((r) => r.id);
  const members = await db.select({ id: boardMembers.userId }).from(boardMembers).where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.leader, true)));
  return [...(board.ownerId ? [board.ownerId] : []), ...members.map((m) => m.id)];
}

export async function updateBoard(db: Db, viewer: PermissionSet, boardId: string, input: { title: string; mode: BoardMode; onMonitor?: boolean }): Promise<void> {
  const { board } = await requireRole(db, viewer, boardId, "leader");
  if (!BOARD_MODES.includes(input.mode)) throw new ValidationError({ mode: "Unbekannter Modus" });
  const title = checkTitle(input.title);
  const onMonitor = input.onMonitor ?? board.onMonitor;
  if (onMonitor && !MONITOR_MODES.includes(input.mode))
    throw new ValidationError({ onMonitor: "Auf Monitoren nur mit „Nur Leitung postet“ oder „Alle posten, Leitung gibt frei“" });
  await db.update(boards).set({ title, mode: input.mode, onMonitor }).where(eq(boards.id, boardId));
  if (board.mode === "alle" && input.mode !== "alle") {
    // Karten aus dem Modus „alle“ waren ungeprüft sofort sichtbar – jetzt prüft die Leitung sie (auch für den Monitor)
    const leaders = await leaderIds(db, board);
    await db
      .update(boardCards)
      .set({ approved: false })
      .where(and(eq(boardCards.boardId, boardId), eq(boardCards.approved, true), leaders.length ? or(isNull(boardCards.authorId), notInArray(boardCards.authorId, leaders)) : undefined));
  }
  await changed(db, board);
}

export async function deleteBoard(db: Db, viewer: PermissionSet, boardId: string): Promise<void> {
  const { board } = await requireRole(db, viewer, boardId, "leader");
  const to = await audience(db, board);
  await db.delete(boards).where(eq(boards.id, boardId));
  for (const id of to) publish(id, { type: "board", boardId });
}

// ------------------------------------------------------------- Spalten (Leitung)

export async function addColumn(db: Db, viewer: PermissionSet, boardId: string, title: string): Promise<void> {
  const { board } = await requireRole(db, viewer, boardId, "leader");
  const t = checkTitle(title, "column", 60);
  const [{ m }] = (await db.select({ m: max(boardColumns.position) }).from(boardColumns).where(eq(boardColumns.boardId, boardId))) as [{ m: number | null }];
  await db.insert(boardColumns).values({ boardId, title: t, position: (m ?? -1) + 1 });
  await changed(db, board);
}

export async function renameColumn(db: Db, viewer: PermissionSet, columnId: string, title: string): Promise<void> {
  const [c] = await db.select().from(boardColumns).where(eq(boardColumns.id, columnId));
  if (!c) throw new ForbiddenError("pinnwaende.write");
  const { board } = await requireRole(db, viewer, c.boardId, "leader");
  await db.update(boardColumns).set({ title: checkTitle(title, "column", 60) }).where(eq(boardColumns.id, columnId));
  await changed(db, board);
}

/** Spalte löschen – nur leere; die letzte Spalte bleibt. */
export async function deleteColumn(db: Db, viewer: PermissionSet, columnId: string): Promise<void> {
  const [c] = await db.select().from(boardColumns).where(eq(boardColumns.id, columnId));
  if (!c) throw new ForbiddenError("pinnwaende.write");
  const { board } = await requireRole(db, viewer, c.boardId, "leader");
  const cols = await db.select({ id: boardColumns.id }).from(boardColumns).where(eq(boardColumns.boardId, c.boardId));
  if (cols.length <= 1) throw new ValidationError({ column: "Die letzte Spalte bleibt" });
  const [card] = await db.select({ id: boardCards.id }).from(boardCards).where(eq(boardCards.columnId, columnId)).limit(1);
  if (card) throw new ValidationError({ column: "Nur leere Spalten lassen sich löschen" });
  await db.delete(boardColumns).where(eq(boardColumns.id, columnId));
  await changed(db, board);
}

// ------------------------------------------------------------- Mitglieder freier Pinnwände (Leitung)

export async function addBoardMember(db: Db, viewer: PermissionSet, boardId: string, username: string): Promise<void> {
  const { board } = await requireRole(db, viewer, boardId, "leader");
  if (board.groupId) throw new ValidationError({ member: "Pinnwände einer Gruppe haben die Mitglieder der Gruppe" });
  const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.username, username.trim().toLowerCase()), eq(users.status, "active")));
  if (!u) throw new ValidationError({ member: "Benutzername nicht gefunden" });
  await db.insert(boardMembers).values({ boardId, userId: u.id }).onConflictDoNothing();
  await changed(db, board);
}

export async function removeBoardMember(db: Db, viewer: PermissionSet, boardId: string, userId: string): Promise<void> {
  const { board } = await requireRole(db, viewer, boardId, "leader");
  await db.delete(boardMembers).where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)));
  await changed(db, board);
}

// ------------------------------------------------------------- Karten

export interface CardInput {
  columnId: string;
  kind: CardKind;
  title: string;
  body: string;
  url?: string;
  fileId?: string;
}

/** Karte anlegen: Modus „leitung“ nur Leitung; „moderiert“ wartet auf Freigabe (außer Leitung). */
export async function addCard(db: Db, viewer: PermissionSet, boardId: string, input: CardInput): Promise<string> {
  const { board, role } = await requireRole(db, viewer, boardId, "member");
  if (board.mode === "leitung" && role !== "leader") throw new ForbiddenError("pinnwaende.write");
  const [col] = await db.select().from(boardColumns).where(and(eq(boardColumns.id, input.columnId), eq(boardColumns.boardId, boardId)));
  if (!col) throw new ValidationError({ columnId: "Spalte fehlt" });
  if (!CARD_KINDS.includes(input.kind)) throw new ValidationError({ kind: "Unbekannte Kartenart" });
  const title = checkTitle(input.title, "title", 120);
  const body = input.body.trim();
  if (body.length > 2000) throw new ValidationError({ body: "Höchstens 2000 Zeichen" });
  let url: string | null = null;
  let fileId: string | null = null;
  if (input.kind === "link") {
    try {
      const u = new URL((input.url ?? "").trim());
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
      url = u.toString();
    } catch {
      throw new ValidationError({ url: "Bitte eine Adresse mit https:// angeben" });
    }
  }
  if (input.kind === "file") {
    // nur Dateien aus dem Ordner der eigenen Gruppe – die sehen alle Mitglieder der Pinnwand
    const [f] = board.groupId
      ? await db.select({ id: fileNodes.id }).from(fileNodes).where(and(eq(fileNodes.id, input.fileId ?? ""), eq(fileNodes.groupId, board.groupId), eq(fileNodes.kind, "file")))
      : [];
    if (!f) throw new ValidationError({ fileId: "Bitte eine Datei aus dem Gruppenordner wählen" });
    fileId = f.id;
  }
  const [{ m }] = (await db.select({ m: max(boardCards.position) }).from(boardCards).where(eq(boardCards.columnId, col.id))) as [{ m: number | null }];
  const [card] = await db
    .insert(boardCards)
    .values({ boardId, columnId: col.id, authorId: viewer.userId, kind: input.kind, title, body, url, fileId, position: (m ?? -1) + 1, approved: board.mode !== "moderiert" || role === "leader" })
    .returning({ id: boardCards.id });
  await changed(db, board);
  return card!.id;
}

async function cardWithRole(db: Db, viewer: PermissionSet, cardId: string) {
  const [card] = await db.select().from(boardCards).where(eq(boardCards.id, cardId));
  if (!card) throw new ForbiddenError("pinnwaende.write");
  const a = await requireRole(db, viewer, card.boardId, "member");
  return { card, ...a };
}

export async function approveCard(db: Db, viewer: PermissionSet, cardId: string): Promise<void> {
  const { board, role } = await cardWithRole(db, viewer, cardId);
  if (role !== "leader") throw new ForbiddenError("pinnwaende.approve");
  await db.update(boardCards).set({ approved: true }).where(eq(boardCards.id, cardId));
  await changed(db, board);
}

/** Löschen: eigene Karte oder Leitung. */
export async function deleteCard(db: Db, viewer: PermissionSet, cardId: string): Promise<void> {
  const { card, board, role } = await cardWithRole(db, viewer, cardId);
  if (role !== "leader" && card.authorId !== viewer.userId) throw new ForbiddenError("pinnwaende.write");
  await db.delete(boardCards).where(eq(boardCards.id, cardId));
  await changed(db, board);
}

/**
 * Karte verschieben (P3-09): an Position `index` in Spalte `columnId` (gleiche oder andere Spalte). Leitung jede Karte,
 * Mitglieder ihre eigenen. Die Positionen der betroffenen Spalten werden lückenlos neu vergeben.
 */
export async function moveCard(db: Db, viewer: PermissionSet, cardId: string, columnId: string, index: number): Promise<void> {
  const { card, board, role } = await cardWithRole(db, viewer, cardId);
  if (role !== "leader" && card.authorId !== viewer.userId) throw new ForbiddenError("pinnwaende.write");
  const [target] = await db.select().from(boardColumns).where(and(eq(boardColumns.id, columnId), eq(boardColumns.boardId, board.id)));
  if (!target) throw new ValidationError({ columnId: "Spalte fehlt" });
  await db.transaction(async (tx) => {
    const rows = (
      await tx
        .select({ id: boardCards.id, approved: boardCards.approved, authorId: boardCards.authorId })
        .from(boardCards)
        .where(eq(boardCards.columnId, columnId))
        .orderBy(asc(boardCards.position), asc(boardCards.createdAt))
    ).filter((c) => c.id !== cardId);
    // `index` zählt in der Liste, die der Betrachter sieht – Mitglieder sehen fremde, noch nicht freigegebene Karten nicht
    const visible = rows.filter((c) => role === "leader" || c.approved || c.authorId === viewer.userId);
    const at = Math.max(0, Math.min(Number.isInteger(index) ? index : visible.length, visible.length));
    const others = rows.map((c) => c.id);
    const pos = at < visible.length ? others.indexOf(visible[at]!.id) : visible.length ? others.indexOf(visible.at(-1)!.id) + 1 : others.length;
    others.splice(pos, 0, cardId);
    for (const [position, id] of others.entries()) await tx.update(boardCards).set({ columnId, position }).where(eq(boardCards.id, id));
    if (card.columnId !== columnId) {
      const rest = await tx.select({ id: boardCards.id }).from(boardCards).where(eq(boardCards.columnId, card.columnId)).orderBy(asc(boardCards.position), asc(boardCards.createdAt));
      for (const [position, r] of rest.entries()) await tx.update(boardCards).set({ position }).where(eq(boardCards.id, r.id));
    }
  });
  await changed(db, board);
}

/** Pinnwände, die auf Monitoren gezeigt werden dürfen (Auswahl in Verwaltung → Monitore). */
export async function monitorBoards(db: Db) {
  return db
    .select({ id: boards.id, title: boards.title, groupName: groups.name })
    .from(boards)
    .leftJoin(groups, eq(groups.id, boards.groupId))
    .where(and(eq(boards.onMonitor, true), inArray(boards.mode, [...MONITOR_MODES])))
    .orderBy(de(boards.title));
}

/** Inhalt für einen Monitor: nur freigegebene Karten, ohne Namen; Dateien nur mit Namen (Bilder brauchen eine Anmeldung). */
export async function boardForMonitor(db: Db, boardId: string) {
  const [board] = await db.select().from(boards).where(and(eq(boards.id, boardId), eq(boards.onMonitor, true), inArray(boards.mode, [...MONITOR_MODES])));
  if (!board) return null;
  const [columns, cards] = await Promise.all([
    db.select().from(boardColumns).where(eq(boardColumns.boardId, boardId)).orderBy(asc(boardColumns.position)),
    db
      .select({ card: boardCards, fileName: fileNodes.name })
      .from(boardCards)
      .leftJoin(fileNodes, eq(fileNodes.id, boardCards.fileId))
      .where(and(eq(boardCards.boardId, boardId), eq(boardCards.approved, true)))
      .orderBy(asc(boardCards.position), asc(boardCards.createdAt)),
  ]);
  return {
    title: board.title,
    columns: columns.map((col) => ({
      title: col.title,
      cards: cards
        .filter((c) => c.card.columnId === col.id)
        .map(({ card, fileName }) => ({ id: card.id, title: card.title, body: card.body, link: card.url ? new URL(card.url).host : null, file: fileName })),
    })),
  };
}

/** Eine Pinnwand mit Spalten und Karten; nicht freigegebene Karten sehen nur Leitung und Autor:in. */
export async function getBoard(db: Db, viewer: PermissionSet, boardId: string) {
  const a = await access(db, viewer, boardId);
  if (!a) return null;
  const { board, role } = a;
  const [columns, cards, members, [group]] = await Promise.all([
    db.select().from(boardColumns).where(eq(boardColumns.boardId, boardId)).orderBy(asc(boardColumns.position)),
    db
      .select({ card: boardCards, authorName: users.name, fileName: fileNodes.name, fileMime: fileNodes.mime })
      .from(boardCards)
      .leftJoin(users, eq(users.id, boardCards.authorId))
      .leftJoin(fileNodes, eq(fileNodes.id, boardCards.fileId))
      .where(eq(boardCards.boardId, boardId))
      .orderBy(asc(boardCards.position), asc(boardCards.createdAt)),
    board.groupId
      ? Promise.resolve([])
      : db
          .select({ id: users.id, name: users.name, leader: boardMembers.leader })
          .from(boardMembers)
          .innerJoin(users, eq(users.id, boardMembers.userId))
          .where(eq(boardMembers.boardId, boardId))
          .orderBy(de(users.name)),
    board.groupId ? db.select({ name: groups.name }).from(groups).where(eq(groups.id, board.groupId)) : Promise.resolve([]),
  ]);
  const visible = cards.filter((c) => c.card.approved || role === "leader" || c.card.authorId === viewer.userId);
  return {
    board,
    groupName: group?.name ?? null,
    role,
    canPost: board.mode !== "leitung" || role === "leader",
    members,
    columns: columns.map((col) => ({
      ...col,
      cards: visible
        .filter((c) => c.card.columnId === col.id)
        .map((c) => ({ ...c.card, authorName: c.authorName, fileName: c.fileName, fileMime: c.fileMime, mine: c.card.authorId === viewer.userId })),
    })),
  };
}

/** Hängt die Datei an einer Pinnwand-Karte? (Download trotz ausgeschalteter Dateiablage, SEC-05) */
export async function isBoardFile(db: Db, fileId: string): Promise<boolean> {
  const [c] = await db.select({ id: boardCards.id }).from(boardCards).where(eq(boardCards.fileId, fileId)).limit(1);
  return !!c;
}

/** Dateien aus dem Gruppenordner für die Kartenauswahl (nur Pinnwände einer Gruppe). */
export async function groupFiles(db: Db, viewer: PermissionSet, boardId: string) {
  const a = await access(db, viewer, boardId);
  if (!a?.board.groupId) return [];
  return db
    .select({ id: fileNodes.id, name: fileNodes.name })
    .from(fileNodes)
    .where(and(eq(fileNodes.groupId, a.board.groupId), eq(fileNodes.kind, "file")))
    .orderBy(de(fileNodes.name))
    .limit(200);
}
