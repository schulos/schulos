// Kursraum (P3-01): je Gruppe eine Übersicht aus den vorhandenen Modulen; eigene Tabelle nur für den Konferenzlink (V-01).
// Abschnitte erscheinen nur, wenn das Modul an ist (und das Gruppenmerkmal aktiv); Gruppenordner, Termine und Chat
// lesen über die Services der Module und sind damit nur für Mitglieder sichtbar.
import { and, asc, count, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { GROUP_KINDS, type GroupKind, groupMembers, groups, kurseLinks, subjects, taskGroups, taskSubmissions, tasks, users } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { isEnabled, type ModuleStateMap } from "@/core/modules/registry";
import { readModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { addDays, toBerlinDate, toBerlinLocal } from "@/core/time";
import { MODULES } from "@/modules";
import { statusOf, type TaskStatus } from "@/modules/aufgaben/service";
import { GROUP_FOLDER_FEATURE, listFolder } from "@/modules/dateien/service";
import { FORUM_FEATURE, listTopics } from "@/modules/foren/service";
import { GROUP_CALENDAR_FEATURE, listOccurrences, type Occurrence } from "@/modules/kalender/service";
import { recentHomeworkOfGroup, type HomeworkItem } from "@/modules/klassenbuch/homework";
import { GROUP_ROOM_FEATURE, groupRoomId, listMessages } from "@/modules/messenger/service";
import { activeQuickPolls, canStartQuickPoll } from "@/modules/umfragen/schnell";
import { listSlots, type LessonSlot } from "@/modules/stundenplan/service";
import { availableGroupFeatures, getGroup, listGroups, setGroupFeature } from "@/modules/verwaltung/groups";
import { ValidationError } from "@/modules/verwaltung/users";
import { KONFERENZ_SETTING } from "./settings";

const STAFF = ["lehrkraft", "verwaltung", "admin"];
/** Gruppenarten mit Stundenplan – dort erscheint „Nächste Stunden“ auch ohne Treffer */
const TAUGHT: GroupKind[] = ["klasse", "kurs", "wahlpflicht", "foerderkurs"];
const LESSON_DAYS = 14;
const EVENT_DAYS = 28;

export interface CourseCard {
  id: string;
  name: string;
  kind: GroupKind;
  kindLabel: string;
  color: string | null;
  subjectName: string | null;
  members: number;
  leaders: string[];
  /** Betrachter leitet die Gruppe */
  leader: boolean;
}

/** Eigene Gruppen (Mitglied oder Leitung), nicht archiviert; Klassen vor Kursen vor AGs … */
export async function myCourses(db: Db, viewer: PermissionSet): Promise<CourseCard[]> {
  if (viewer.memberOf.size === 0) return [];
  const ids = [...viewer.memberOf];
  const rows = await db
    .select({ id: groups.id, name: groups.name, kind: groups.kind, gradeLevel: groups.gradeLevel, color: subjects.color, subjectName: subjects.name })
    .from(groups)
    .leftJoin(subjects, eq(subjects.id, groups.subjectId))
    .where(and(inArray(groups.id, ids), isNull(groups.archivedAt)))
    .orderBy(asc(groups.gradeLevel), de(groups.name));
  const [counts, leaders] = await Promise.all([
    db.select({ groupId: groupMembers.groupId, n: count() }).from(groupMembers).where(inArray(groupMembers.groupId, ids)).groupBy(groupMembers.groupId),
    db
      .select({ groupId: groupMembers.groupId, name: users.name, shortCode: users.shortCode })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(inArray(groupMembers.groupId, ids), eq(groupMembers.role, "leader"))),
  ]);
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      kindLabel: GROUP_KIND_LABELS[r.kind],
      color: r.color,
      subjectName: r.subjectName,
      members: counts.find((c) => c.groupId === r.id)?.n ?? 0,
      leaders: leaders.filter((l) => l.groupId === r.id).map((l) => l.shortCode ?? l.name),
      leader: viewer.leaderOf.has(r.id),
    }))
    .sort((a, b) => GROUP_KINDS.indexOf(a.kind) - GROUP_KINDS.indexOf(b.kind));
}

/** Gruppensuche für Konten mit `kurse.view_all` (Verwaltung öffnet Kursräume ohne Mitgliedschaft). */
export async function searchCourses(db: Db, viewer: PermissionSet, q: string) {
  if (!hasPermission(viewer, "kurse.view_all") || !q.trim()) return [];
  return (await listGroups(db, { q })).slice(0, 30);
}

/** Darf der Betrachter den Kursraum öffnen? Mitglieder (nicht archivierte Gruppen) oder `kurse.view_all`. */
export function canOpenCourse(viewer: PermissionSet, group: { id: string; archivedAt: Date | null }): boolean {
  if (hasPermission(viewer, "kurse.view_all")) return true;
  return hasPermission(viewer, "kurse.view") && viewer.memberOf.has(group.id) && !group.archivedAt;
}

/** Bereiche (Gruppenmerkmale) schalten: Leitung der Gruppe (Recht „group.features“ über die Leitung) oder Gruppenverwaltung. */
export function canManageCourse(viewer: PermissionSet, group: { id: string; archivedAt: Date | null }): boolean {
  if (group.archivedAt) return false;
  return hasPermission(viewer, "group.features", { groupId: group.id }) || hasPermission(viewer, "verwaltung.groups");
}

/** Gruppenmerkmale, die sich im Kursraum schalten lassen: nur die aktiver Module, passend zur Gruppenart, ohne `manageOnly` (GT-01). */
export function courseFeatures(states: ModuleStateMap, kind?: GroupKind) {
  return availableGroupFeatures(
    MODULES.filter((m) => isEnabled(m, states)),
    { kind, course: true },
  );
}

/** P3-02: Leitung schaltet einen Bereich ihres Kurses an/aus (protokolliert wie in der Gruppenverwaltung). */
export async function setCourseFeature(db: Db, viewer: PermissionSet, groupId: string, feature: string, enabled: boolean, states: ModuleStateMap) {
  const data = await getGroup(db, groupId);
  if (!data || !canManageCourse(viewer, data.group)) throw new ForbiddenError("group.features");
  if (!courseFeatures(states, data.group.kind).some((f) => f.id === feature)) throw new ValidationError({ feature: "Diesen Bereich gibt es nicht" });
  await setGroupFeature(db, viewer.userId, groupId, feature, enabled);
}

// ---- V-01: Link auf einen externen Konferenzraum ----

export const LINK_LABEL_DEFAULT = "Konferenzraum";
const LINK_URL_MAX = 500;
const LINK_LABEL_MAX = 60;

export interface ConferenceLink {
  url: string;
  label: string;
  /** Rechnername, damit klar ist, wohin der Knopf führt */
  host: string;
}

/** Link setzen/entfernen: wer Bereiche schalten darf, Lehrkräfte der Gruppe und `kurse.view_all` – nie bei archivierten Gruppen. */
export function canEditConferenceLink(viewer: PermissionSet, group: { id: string; archivedAt: Date | null }): boolean {
  if (group.archivedAt) return false;
  if (canManageCourse(viewer, group) || hasPermission(viewer, "kurse.view_all")) return true;
  return viewer.role === "lehrkraft" && viewer.memberOf.has(group.id);
}

/** Prüft und normalisiert die Eingabe: nur `https://` mit Rechnername, ohne Zugangsdaten in der Adresse. */
export function parseConferenceLink(input: { url: string; label?: string }): { url: string; label: string } {
  const raw = input.url.trim();
  const label = (input.label ?? "").trim() || LINK_LABEL_DEFAULT;
  if (label.length > LINK_LABEL_MAX) throw new ValidationError({ label: `Höchstens ${LINK_LABEL_MAX} Zeichen` });
  if (raw.length > LINK_URL_MAX) throw new ValidationError({ url: `Höchstens ${LINK_URL_MAX} Zeichen` });
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ValidationError({ url: "Bitte eine vollständige Adresse eingeben (https://…)" });
  }
  if (u.protocol !== "https:" || !u.hostname) throw new ValidationError({ url: "Nur Adressen mit https:// sind erlaubt" });
  if (u.username || u.password) throw new ValidationError({ url: "Die Adresse darf keinen Benutzernamen oder kein Passwort vor dem Rechnernamen enthalten" });
  return { url: u.toString(), label };
}

/** Link der Gruppe für den Kursraum; `null`, wenn keiner gesetzt ist. Sichtbarkeit (Schalter, Kursraum) prüft der Aufrufer. */
export async function conferenceLink(db: Db, groupId: string): Promise<ConferenceLink | null> {
  const [row] = await db.select({ url: kurseLinks.url, label: kurseLinks.label }).from(kurseLinks).where(eq(kurseLinks.groupId, groupId));
  return row ? { ...row, host: new URL(row.url).hostname } : null;
}

/** Link setzen (`url` leer = entfernen); protokolliert ohne die Adresse selbst (sie kann ein Raum-Passwort enthalten). */
export async function setConferenceLink(db: Db, viewer: PermissionSet, groupId: string, input: { url: string; label?: string }) {
  const data = await getGroup(db, groupId);
  if (!data || !canEditConferenceLink(viewer, data.group)) throw new ForbiddenError("kurse.konferenz");
  if ((await readModuleSetting(db, KONFERENZ_SETTING)) !== "an") throw new ValidationError({ url: "Konferenzlinks sind an dieser Schule ausgeschaltet" });
  if (!input.url.trim()) {
    const removed = await db.delete(kurseLinks).where(eq(kurseLinks.groupId, groupId)).returning({ groupId: kurseLinks.groupId });
    if (removed.length) await audit(db, viewer.userId, "kurse.konferenz.entfernen", groupId);
    return null;
  }
  const { url, label } = parseConferenceLink(input);
  await db
    .insert(kurseLinks)
    .values({ groupId, url, label, updatedBy: viewer.userId })
    .onConflictDoUpdate({ target: kurseLinks.groupId, set: { url, label, updatedBy: viewer.userId, updatedAt: new Date() } });
  await audit(db, viewer.userId, "kurse.konferenz.setzen", groupId, { host: new URL(url).hostname });
  return { url, label, host: new URL(url).hostname } satisfies ConferenceLink;
}

/** Abschnitt des Kursraums: `null` = nicht anzeigen (Modul aus/Merkmal inaktiv), `items: null` = nur für Mitglieder. */
export type Section<T> = { items: T[] | null } | null;

export interface CourseTask {
  id: string;
  title: string;
  dueAt: Date;
  /** eigener Stand (Schüler:innen) */
  status?: TaskStatus;
  /** Abgaben insgesamt (Leitung/Personal) */
  submitted?: number;
}

export interface CourseFile {
  id: string;
  kind: "folder" | "file";
  name: string;
  updatedAt: Date;
}

export interface CourseMessage {
  id: string;
  authorName: string | null;
  body: string;
  createdAt: Date;
}

/** Alles für `/kurse/[id]`; null, wenn es die Gruppe nicht gibt oder der Betrachter sie nicht öffnen darf. */
export async function courseHub(db: Db, viewer: PermissionSet, groupId: string, states: ModuleStateMap, now = new Date()) {
  const data = await getGroup(db, groupId);
  if (!data || !canOpenCourse(viewer, data.group)) return null;
  const { group, members, features } = data;
  const member = viewer.memberOf.has(groupId);
  const on = (moduleId: string) => {
    const m = MODULES.find((x) => x.id === moduleId);
    return !!m && isEnabled(m, states);
  };
  const has = (feature: string) => features.includes(feature);
  const today = toBerlinDate(now);
  const subject = group.subjectId ? (await db.select({ name: subjects.name, color: subjects.color }).from(subjects).where(eq(subjects.id, group.subjectId)))[0] : undefined;

  const [lessons, homework, courseTasks, events, files, chat] = await Promise.all([
    on("stundenplan") ? nextLessons(db, groupId, group.kind, now) : null,
    // Q5-02: Hausaufgaben aus dem Klassenbuch – für Mitglieder der Gruppe (Unterrichtsgruppen)
    on("klassenbuch") && TAUGHT.includes(group.kind) ? (member ? { items: await recentHomeworkOfGroup(db, groupId, today) } : { items: null }) : null,
    on("aufgaben") ? openTasks(db, viewer, groupId, now) : null,
    on("kalender") && has(GROUP_CALENDAR_FEATURE)
      ? member
        ? { items: (await listOccurrences(db, viewer, today, addDays(today, EVENT_DAYS), [`group:${groupId}`])).slice(0, 5) }
        : { items: null }
      : null,
    on("dateien") && has(GROUP_FOLDER_FEATURE) ? (member ? { items: await recentFiles(db, viewer, groupId) } : { items: null }) : null,
    on("messenger") && has(GROUP_ROOM_FEATURE) ? (member ? chatPreview(db, viewer, groupId) : { roomId: null, items: null }) : null,
  ]);

  // Forum (P3-06): die drei zuletzt aktiven Themen
  const forum = on("foren") && has(FORUM_FEATURE) ? (member ? { items: await listTopics(db, viewer, groupId, 3) } : { items: null }) : null;
  // Schnellumfragen (P3-05): nur für Mitglieder, live über den SSE-Kanal
  const quickPolls = on("umfragen") && member ? { items: await activeQuickPolls(db, viewer, groupId, now), canStart: canStartQuickPoll(viewer, groupId) } : null;
  // V-01: Konferenzlink nur bei eingeschalteter Moduleinstellung; bearbeiten dürfen Leitung, Lehrkräfte der Gruppe, Verwaltung
  const conference =
    (await readModuleSetting(db, KONFERENZ_SETTING)) === "an"
      ? { link: await conferenceLink(db, groupId), canEdit: canEditConferenceLink(viewer, group) }
      : null;

  return {
    forum,
    quickPolls,
    conference,
    manage: canManageCourse(viewer, group) ? courseFeatures(states, group.kind).map((f) => ({ ...f, enabled: has(f.id) })) : null,
    group: {
      id: group.id,
      name: group.name,
      kind: group.kind,
      kindLabel: GROUP_KIND_LABELS[group.kind],
      description: group.description,
      archived: !!group.archivedAt,
      subjectName: subject?.name ?? null,
      color: subject?.color ?? null,
    },
    member,
    leader: viewer.leaderOf.has(groupId),
    members: members.map((m) => ({ id: m.id, name: m.name, shortCode: m.shortCode, leader: m.memberRole === "leader", role: m.role })),
    lessons: lessons satisfies Section<LessonSlot>,
    homework: homework satisfies Section<HomeworkItem>,
    tasks: courseTasks satisfies Section<CourseTask>,
    events: events satisfies Section<Occurrence>,
    files: files satisfies Section<CourseFile>,
    chat: chat satisfies (Section<CourseMessage> & { roomId: string | null }) | null,
  };
}

export type CourseHub = NonNullable<Awaited<ReturnType<typeof courseHub>>>;

/** Nächste Stunden der Gruppe (ab jetzt, höchstens 6, zwei Wochen voraus); Entfall bleibt sichtbar. */
async function nextLessons(db: Db, groupId: string, kind: GroupKind, now: Date): Promise<Section<LessonSlot>> {
  const today = toBerlinDate(now);
  const hm = toBerlinLocal(now).slice(11);
  const slots = await listSlots(db, { kind: "group", id: groupId }, today, addDays(today, LESSON_DAYS));
  const items = slots.filter((s) => s.date > today || s.endsAt > hm).slice(0, 6);
  return items.length || TAUGHT.includes(kind) ? { items } : null;
}

/** Offene Aufgaben der Gruppe (Frist nicht vorbei); Schüler:innen nur gestartete, mit eigenem Stand. */
async function openTasks(db: Db, viewer: PermissionSet, groupId: string, now: Date): Promise<Section<CourseTask>> {
  const staff = STAFF.includes(viewer.role) || viewer.leaderOf.has(groupId);
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt })
    .from(tasks)
    .innerJoin(taskGroups, eq(taskGroups.taskId, tasks.id))
    .where(and(eq(taskGroups.groupId, groupId), gte(tasks.dueAt, now), staff ? undefined : lte(tasks.startsAt, now)))
    .orderBy(asc(tasks.dueAt))
    .limit(8);
  if (rows.length === 0) return { items: [] };
  const ids = rows.map((r) => r.id);
  if (staff) {
    const subs = await db
      .select({ taskId: taskSubmissions.taskId, n: sql<number>`count(*)::int` })
      .from(taskSubmissions)
      .where(inArray(taskSubmissions.taskId, ids))
      .groupBy(taskSubmissions.taskId);
    return { items: rows.map((r) => ({ ...r, submitted: subs.find((s) => s.taskId === r.id)?.n ?? 0 })) };
  }
  const own = await db
    .select()
    .from(taskSubmissions)
    .where(and(eq(taskSubmissions.studentId, viewer.userId), inArray(taskSubmissions.taskId, ids)));
  return { items: rows.map((r) => ({ ...r, status: statusOf(r.dueAt, own.find((s) => s.taskId === r.id), now) })) };
}

/** Zuletzt geänderte Einträge der obersten Ebene des Gruppenordners. */
async function recentFiles(db: Db, viewer: PermissionSet, groupId: string): Promise<CourseFile[]> {
  const { items } = await listFolder(db, viewer, `group:${groupId}`, null);
  return [...items]
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 6)
    .map((i) => ({ id: i.id, kind: i.kind, name: i.name, updatedAt: i.updatedAt }));
}

/** Die letzten drei Nachrichten des Gruppenchats. */
async function chatPreview(db: Db, viewer: PermissionSet, groupId: string) {
  const roomId = await groupRoomId(db, viewer, groupId);
  if (!roomId) return { roomId: null, items: [] };
  const messages = (await listMessages(db, viewer, roomId, 3)) ?? [];
  return { roomId, items: messages.map((m): CourseMessage => ({ id: m.id, authorName: m.authorName, body: m.body, createdAt: m.createdAt })) };
}
