// Statusmonitor: Bildschirme verwalten (Token) und die Daten für die Kiosk-Seite zusammenstellen.
import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { monitorScreens, newsPosts, newsTargets, type MonitorProfile, type MonitorScreen } from "@/core/db/schema";
import { dayOffLabel, loadSchoolCalendar } from "@/core/school/calendar";
import { cachedSchoolSettings } from "@/core/settings";
import { addDays, toBerlinDate } from "@/core/time";
import { timeRange } from "@/modules/kalender/format";
import { schoolOccurrences } from "@/modules/kalender/service";
import { weekOf } from "@/modules/stundenplan/service";
import { planDays, substitutionsOn } from "@/modules/stundenplan/vertretung";
import { dutiesOn } from "@/modules/stundenplan/aufsichten";
import { ValidationError } from "@/modules/verwaltung/users";
import { boardForMonitor, monitorBoards } from "@/modules/pinnwaende/service";
import { nextEvent, teacherBoards, formatEventDay } from "@/modules/sprechtag/service";
import sprechtagManifest from "@/modules/sprechtag/manifest";
import manifest from "./manifest";
import { MONITOR_PROFILES } from "./schema";

/** Gespeichert wird nur der SHA-256 des Tokens */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(24).toString("base64url");

export async function listScreens(db: Db): Promise<MonitorScreen[]> {
  return db.select().from(monitorScreens).orderBy(asc(monitorScreens.name));
}

export interface ScreenInput {
  name: string;
  location: string;
  profile: string;
  /** optional eine Pinnwand, deren Leitung die Anzeige erlaubt (P3-09) */
  boardId?: string;
}

async function validate(db: Db, input: ScreenInput) {
  const fe: Record<string, string> = {};
  if (!input.name.trim()) fe.name = "Name angeben";
  if (!(MONITOR_PROFILES as readonly string[]).includes(input.profile)) fe.profile = "Profil wählen";
  const boardId = input.boardId?.trim() || null;
  if (boardId && !(await monitorBoards(db)).some((b) => b.id === boardId)) fe.boardId = "Diese Pinnwand ist nicht für Monitore freigegeben";
  if (Object.keys(fe).length) throw new ValidationError(fe);
  return { name: input.name.trim(), location: input.location.trim() || null, profile: input.profile as MonitorProfile, boardId };
}

/** Legt einen Monitor an und gibt den Token zurück – er wird nur dieses eine Mal im Klartext gezeigt. */
export async function createScreen(db: Db, actorId: string, input: ScreenInput): Promise<{ id: string; token: string }> {
  const values = await validate(db, input);
  const token = newToken();
  const [row] = await db.insert(monitorScreens).values({ ...values, tokenHash: hashToken(token) }).returning({ id: monitorScreens.id });
  await audit(db, actorId, "monitor.create", row!.id, { name: values.name, profile: values.profile });
  return { id: row!.id, token };
}

export async function updateScreen(db: Db, actorId: string, id: string, input: ScreenInput): Promise<void> {
  const values = await validate(db, input);
  await db.update(monitorScreens).set(values).where(eq(monitorScreens.id, id));
  await audit(db, actorId, "monitor.update", id, { name: values.name, profile: values.profile });
}

/** Neue Adresse: die alte wird sofort ungültig. */
export async function renewToken(db: Db, actorId: string, id: string): Promise<string> {
  const token = newToken();
  await db.update(monitorScreens).set({ tokenHash: hashToken(token), lastSeenAt: null }).where(eq(monitorScreens.id, id));
  await audit(db, actorId, "monitor.renew", id, {});
  return token;
}

/** Sperrt den Monitor, bis eine neue Adresse erzeugt wird. */
export async function revokeToken(db: Db, actorId: string, id: string): Promise<void> {
  await db.update(monitorScreens).set({ tokenHash: null }).where(eq(monitorScreens.id, id));
  await audit(db, actorId, "monitor.revoke", id, {});
}

export async function deleteScreen(db: Db, actorId: string, id: string): Promise<void> {
  await db.delete(monitorScreens).where(eq(monitorScreens.id, id));
  await audit(db, actorId, "monitor.delete", id, {});
}

/** Monitor zur Adresse; merkt sich den Abruf („zuletzt gesehen“). Unbekannt oder widerrufen → null. */
export async function screenByToken(db: Db, token: string, now = new Date()): Promise<MonitorScreen | null> {
  if (!/^[\w-]{20,64}$/.test(token)) return null;
  const [screen] = await db.select().from(monitorScreens).where(eq(monitorScreens.tokenHash, hashToken(token)));
  if (!screen) return null;
  await db.update(monitorScreens).set({ lastSeenAt: now }).where(eq(monitorScreens.id, screen.id));
  return { ...screen, lastSeenAt: now };
}

export interface MonitorEntry {
  group: string;
  period: number;
  subject: string;
  kind: "cancel" | "substitute" | "room";
  room: string | null;
  note: string | null;
  /** vertretende Lehrkraft (Kürzel) */
  substitute: string | null;
  /** nur Lehrerzimmer: vertretene Lehrkraft (Kürzel) und Name der Vertretung */
  absent?: string | null;
  substituteName?: string | null;
}

export interface MonitorData {
  school: string;
  profile: MonitorProfile;
  generatedAt: string;
  today: string;
  week: "A" | "B";
  /** heute kein Unterricht, z. B. „Herbstferien“ */
  todayOff: string | null;
  days: { date: string; entries: MonitorEntry[] }[];
  events: { title: string; time: string }[];
  ticker: string[];
  /** P3-09: freigegebene Pinnwand (nur freigegebene Karten, ohne Namen) */
  board?: NonNullable<Awaited<ReturnType<typeof boardForMonitor>>>;
  /** nur Profil „Sprechtag“ (P4-53): nächster Sprechtag mit Lehrkräften und Räumen – ohne Eltern- und Schülernamen */
  sprechtag?: { title: string; day: string; time: string; rows: { teacher: string; code: string | null; room: string | null }[] } | null;
  /** nur Lehrerzimmer: Pausenaufsichten des ersten angezeigten Tages (offene markiert) */
  duties?: { time: string; area: string; teacher: string; status: "regular" | "open" | "covered" | "dropped" }[];
}

/**
 * Inhalt eines Monitors: Vertretungsplan heute bzw. nächster Schultag und der Tag danach, Termine des Tages,
 * Laufband. Nie Namen von Schüler:innen; im Foyer Lehrkräfte nur als Kürzel.
 */
export async function monitorData(db: Db, screen: Pick<MonitorScreen, "profile"> & { boardId?: string | null }, now = new Date()): Promise<MonitorData> {
  const today = toBerlinDate(now);
  const staffRoom = screen.profile === "lehrerzimmer";
  const [settings, cal] = await Promise.all([cachedSchoolSettings(db), loadSchoolCalendar(db)]);
  const days = planDays(today, cal);
  const [subs, occ, news] = await Promise.all([
    substitutionsOn(db, days),
    schoolOccurrences(db, today, addDays(today, 1)),
    db
      .select({ id: newsPosts.id, title: newsPosts.title, role: newsTargets.role, groupId: newsTargets.groupId })
      .from(newsPosts)
      .leftJoin(newsTargets, eq(newsTargets.postId, newsPosts.id))
      .where(and(eq(newsPosts.onMonitor, true), lte(newsPosts.publishedAt, now), or(isNull(newsPosts.expiresAt), gt(newsPosts.expiresAt, now))))
      .orderBy(desc(newsPosts.pinned), desc(newsPosts.publishedAt)),
  ]);
  // Laufband: Beiträge an alle (keine Zielgruppe); im Lehrerzimmer auch Beiträge, die sich an Lehrkräfte richten
  const ticker = new Map<string, { title: string; ok: boolean }>();
  for (const n of news) {
    const ok = (!n.role && !n.groupId) || (staffRoom && n.role === "lehrkraft");
    const prev = ticker.get(n.id);
    ticker.set(n.id, { title: n.title, ok: (prev?.ok ?? false) || ok });
  }
  const off = cal.dayOff(today);
  const board = screen.boardId ? await boardForMonitor(db, screen.boardId) : null;
  const duties = staffRoom
    ? (await dutiesOn(db, days[0])).map((d) => ({
        time: d.startsAt,
        area: d.areaName,
        teacher: d.status === "covered" ? `${d.change!.substituteCode ?? "?"} für ${d.teacherCode ?? "?"}` : (d.teacherCode ?? "?"),
        status: d.status,
      }))
    : undefined;
  const sprechtag = screen.profile === "sprechtag" ? await sprechtagBoard(db, today) : undefined;
  return {
    ...(sprechtag !== undefined ? { sprechtag } : {}),
    school: settings.name,
    profile: screen.profile,
    generatedAt: now.toISOString(),
    today,
    week: weekOf(days[0]),
    todayOff: off ? dayOffLabel(off) : null,
    days: days.map((date) => ({
      date,
      entries: subs
        .filter((s) => s.date === date)
        .map((s) => ({
          group: s.groupName.replace(/^Klasse /, ""),
          period: s.periodNr,
          // SP-12: Fachtausch „Mathe (statt Sport)“
          subject: s.insteadOf ? `${s.subjectName} (statt ${s.insteadOf})` : s.subjectName,
          kind: s.kind,
          room: s.newRoomId ?? s.roomId,
          note: s.note,
          substitute: s.kind === "substitute" ? s.substituteCode : null,
          ...(staffRoom ? { absent: s.teacherCode, substituteName: s.kind === "substitute" ? s.substituteName : null } : {}),
        })),
    })),
    events: occ.map((o) => ({ title: o.title, time: timeRange(o) })),
    ticker: [...ticker.values()].filter((t) => t.ok).map((t) => t.title),
    ...(duties ? { duties } : {}),
    ...(board ? { board } : {}),
  };
}

/** Monitor „Sprechtag“: der nächste Sprechtag (heute oder später) mit allen teilnehmenden Lehrkräften und Räumen. */
async function sprechtagBoard(db: Db, today: string): Promise<MonitorData["sprechtag"]> {
  if (!isEnabled(sprechtagManifest, await loadModuleStates(db))) return null;
  const e = await nextEvent(db, today);
  if (!e) return null;
  const boards = await teacherBoards(db, e);
  return {
    title: e.title,
    day: e.date === today ? "heute" : formatEventDay(e.date),
    time: `${e.startsAt}–${e.endsAt} Uhr`,
    rows: boards.map((b) => ({ teacher: b.name, code: b.shortCode, room: b.roomName ?? b.roomId })),
  };
}

/** Ist das Modul eingeschaltet? (Abgeschaltete Module entziehen keine Rechte – Kiosk und Verwaltung prüfen selbst.) */
export async function monitorEnabled(db: Db): Promise<boolean> {
  return isEnabled(manifest, await loadModuleStates(db));
}

/** „vor 2 Min.“, „vor 3 Std.“, „vor 5 Tagen“ */
export function seenAgo(at: Date, now = new Date()): string {
  const min = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  return `vor ${d} ${d === 1 ? "Tag" : "Tagen"}`;
}
