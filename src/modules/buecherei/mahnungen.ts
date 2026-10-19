// Schulbücherei – Erinnerung und Mahnstufen (BU-04). Ein täglicher Lauf erinnert vor Fristende und mahnt überfällige Ausleihen in
// drei Stufen (1. am ersten Schultag nach der Fälligkeit, 2. und 3. jeweils nach dem eingestellten Abstand, nur an Schultagen).
// Ab der 2. Stufe werden bei Minderjährigen auch die Eltern benachrichtigt (Entscheidung 4, docs/BUECHEREI.md) – über die
// Eltern-Kind-Zuordnung „handelt für“ (nicht bei eigenständigen Schüler:innen). Datenschutz: Benachrichtigungen und Mails nennen
// keinen Titel (was jemand liest, steht nur nach der Anmeldung unter „Meine Ausleihen“); die Mahnstufe lebt nur in der offenen
// Ausleihe – Rückgabe löscht sie mit, Verlängern setzt sie zurück. Es bleibt nur ein Zähler je Monat und Medienart.
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { buechereiCopies, buechereiLoans, buechereiStats, buechereiTitles, users } from "@/core/db/schema";
import { appUrl, enqueueMail } from "@/core/mail";
import { mailFooter, type MailContent } from "@/core/mail-templates";
import { readModuleSetting } from "@/core/modules/settings";
import { notifyBundled } from "@/core/notifications";
import { ForbiddenError, type PermissionSet } from "@/core/permissions";
import { parentLinks } from "@/core/school/majority";
import { addDays } from "@/core/time";
import { verifiedEmails } from "@/modules/sprechtag/mails";
import { isOpenDay } from "./dates";
import type { MediaType } from "./labels";
import { canDesk, classNamesOf } from "./loans";
import { fmtDay } from "./reservations";
import { DUNNING_DAYS, DUNNING_MAIL, REMIND_DAYS } from "./settings";

export const MAX_DUNNING_LEVEL = 3;
/** Ab dieser Stufe erfahren es die Eltern Minderjähriger (Entscheidung 4: Bücherei ab der 2. Mahnstufe). */
export const PARENT_DUNNING_LEVEL = 2;

/**
 * Rein: Welche Mahnstufe ist heute fällig – oder null? 1. Stufe sobald überfällig, jede weitere frühestens `intervalDays` nach
 * der vorigen; höchstens Stufe 3, je Lauf höchstens eine Stufe weiter.
 */
export function nextDunningLevel(l: { dueOn: string; dunningLevel: number; dunnedOn: string | null }, today: string, intervalDays: number): number | null {
  if (l.dueOn >= today || l.dunningLevel >= MAX_DUNNING_LEVEL) return null;
  if (l.dunningLevel === 0) return 1;
  if (!l.dunnedOn || addDays(l.dunnedOn, intervalDays) <= today) return l.dunningLevel + 1;
  return null;
}

const childName = (first: string | undefined) => first?.trim() || "Ihrem Kind";

const loansText = (n: number) => (n === 1 ? "Eine Ausleihe ist" : `${n} Ausleihen sind`);

/** Mail einer Mahnung – ohne Titel, nur mit Link zur Anmeldung. `child` = Vorname, wenn die Mail an Eltern geht. */
export function dunningMail(p: { school: string; level: number; count: number; since: string; link: string; child?: string }): MailContent {
  const what = p.child
    ? `${p.count === 1 ? "eine Ausleihe" : `${p.count} Ausleihen`} von ${p.child} in der Schulbücherei ${p.count === 1 ? "ist" : "sind"}`
    : `${p.count === 1 ? "eine Ihrer Ausleihen" : `${p.count} Ihrer Ausleihen`} in der Schulbücherei ${p.count === 1 ? "ist" : "sind"}`;
  return {
    subject: `${p.school}: ${p.level}. Mahnung der Schulbücherei`,
    text: [
      "Guten Tag,",
      "",
      `${what} seit dem ${fmtDay(p.since)} überfällig (${p.level}. Mahnung).`,
      "Bitte in der Bücherei zurückgeben oder verlängern lassen. Um welche Medien es geht, steht nach der Anmeldung unter „Bücherei“:",
      "",
      p.link,
      mailFooter(p.school),
    ].join("\n"),
  };
}

export interface DunningRunOptions {
  /** Mailversand eingerichtet (bzw. in Entwicklung lesbar) */
  mail: boolean;
  school: string;
}

interface Bucket {
  level: number;
  count: number;
  since: string;
}

function add(map: Map<string, Bucket>, key: string, level: number, dueOn: string) {
  const b = map.get(key);
  if (!b) map.set(key, { level, count: 1, since: dueOn });
  else map.set(key, { level: Math.max(b.level, level), count: b.count + 1, since: dueOn < b.since ? dueOn : b.since });
}

/** Erinnerung vor Fristende: je Person ein gebündelter Gong für alle Ausleihen, die in den nächsten Tagen fällig werden. */
async function runReminders(db: Db, today: string): Promise<number> {
  const days = Number(await readModuleSetting(db, REMIND_DAYS));
  if (days <= 0) return 0;
  const rows = await db
    .update(buechereiLoans)
    .set({ remindedDueOn: sql`${buechereiLoans.dueOn}` })
    .where(
      and(
        isNull(buechereiLoans.returnedOn),
        isNotNull(buechereiLoans.userId),
        gte(buechereiLoans.dueOn, today),
        lte(buechereiLoans.dueOn, addDays(today, days)),
        or(isNull(buechereiLoans.remindedDueOn), ne(buechereiLoans.remindedDueOn, buechereiLoans.dueOn)),
      ),
    )
    .returning({ userId: buechereiLoans.userId, dueOn: buechereiLoans.dueOn });
  const per = new Map<string, Bucket>();
  for (const r of rows) add(per, r.userId!, 0, r.dueOn);
  await notifyBundled(
    db,
    [...per].map(([userId, b]) => ({
      userId,
      title: "Bücherei: Rückgabe bald fällig",
      body: `${loansText(b.count)} am ${fmtDay(b.since)} fällig – bitte zurückgeben oder verlängern. Welche: unter „Meine Ausleihen“.`,
      href: "/buecherei/meine",
    })),
    { moduleId: "buecherei", bundleKey: "buecherei:erinnerung" },
  );
  return per.size;
}

/**
 * Täglicher Lauf (Job `buecherei-mahnungen`): erst erinnern, dann – nur an Schultagen – mahnen. Jede Stufe wird mit einem
 * bedingten UPDATE vergeben (zweiter Prozess vergibt sie nicht doppelt). Liefert die Zahl der Erinnerungen, Mahnungen und
 * benachrichtigten Eltern.
 */
export async function runDunning(db: Db, today: string, opts: DunningRunOptions, now = new Date()): Promise<{ reminded: number; dunned: number; parents: number }> {
  const reminded = await runReminders(db, today);
  if (!(await isOpenDay(db, today))) return { reminded, dunned: 0, parents: 0 };
  const interval = Number(await readModuleSetting(db, DUNNING_DAYS));
  const candidates = await db
    .select({
      id: buechereiLoans.id,
      userId: buechereiLoans.userId,
      dueOn: buechereiLoans.dueOn,
      dunningLevel: buechereiLoans.dunningLevel,
      dunnedOn: buechereiLoans.dunnedOn,
      mediaType: buechereiTitles.mediaType,
    })
    .from(buechereiLoans)
    .innerJoin(buechereiCopies, eq(buechereiCopies.id, buechereiLoans.copyId))
    .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiCopies.titleId))
    .where(and(isNull(buechereiLoans.returnedOn), isNotNull(buechereiLoans.userId), lt(buechereiLoans.dueOn, today), lt(buechereiLoans.dunningLevel, MAX_DUNNING_LEVEL)))
    .orderBy(asc(buechereiLoans.dueOn), asc(buechereiLoans.id));
  const per = new Map<string, Bucket>();
  const month = today.slice(0, 7);
  for (const l of candidates) {
    const level = nextDunningLevel(l, today, interval);
    if (level === null) continue;
    const [done] = await db
      .update(buechereiLoans)
      .set({ dunningLevel: level, dunnedOn: today })
      .where(and(eq(buechereiLoans.id, l.id), eq(buechereiLoans.dunningLevel, l.dunningLevel), isNull(buechereiLoans.returnedOn)))
      .returning({ id: buechereiLoans.id });
    if (!done) continue;
    await bumpDunnings(db, month, l.mediaType);
    add(per, l.userId!, level, l.dueOn);
  }
  if (!per.size) return { reminded, dunned: 0, parents: 0 };

  const people = await db
    .select({ id: users.id, role: users.role, firstName: users.firstName, selfResponsible: users.selfResponsible })
    .from(users)
    .where(inArray(users.id, [...per.keys()]));
  const byId = new Map(people.map((u) => [u.id, u]));
  // Eltern nur bei Minderjährigen (Eltern handeln für das Kind, `act`) und erst ab Stufe 2
  const minors = [...per].filter(([id, b]) => b.level >= PARENT_DUNNING_LEVEL && byId.get(id)?.role === "schueler" && !byId.get(id)?.selfResponsible).map(([id]) => id);
  const links = await parentLinks(db, minors, "act");
  const informed = new Set(links.map((l) => l.childId));

  await notifyBundled(
    db,
    [...per].map(([userId, b]) => ({
      userId,
      title: `${b.level}. Mahnung der Bücherei`,
      body: `${loansText(b.count)} seit dem ${fmtDay(b.since)} überfällig – bitte zurückgeben.${informed.has(userId) ? " Deine Eltern werden ebenfalls benachrichtigt." : ""} Welche: unter „Meine Ausleihen“.`,
      href: "/buecherei/meine",
    })),
    { moduleId: "buecherei", bundleKey: "buecherei:mahnung" },
  );
  // je Kind eine eigene Nachricht (Bündel je Kind), damit Geschwister sich nicht gegenseitig überschreiben
  for (const l of links) {
    const b = per.get(l.childId)!;
    const child = childName(byId.get(l.childId)?.firstName);
    await notifyBundled(
      db,
      [
        {
          userId: l.parentId,
          title: `${b.level}. Mahnung der Bücherei für ${child}`,
          body: `${b.count === 1 ? "Eine Ausleihe" : `${b.count} Ausleihen`} von ${child} ${b.count === 1 ? "ist" : "sind"} seit dem ${fmtDay(b.since)} überfällig – bitte an die Rückgabe erinnern. Welche Medien: unter „Bücherei“.`,
          href: "/buecherei/meine",
        },
      ],
      { moduleId: "buecherei", bundleKey: `buecherei:mahnung:${l.childId}` },
    );
  }

  if (opts.mail && (await readModuleSetting(db, DUNNING_MAIL)) === "1") {
    const emails = await verifiedEmails(db, [...per.keys(), ...links.map((l) => l.parentId)]);
    const link = appUrl("/buecherei/meine");
    for (const [userId, b] of per) {
      const to = emails.get(userId);
      if (to) await enqueueMail(db, { to, ...dunningMail({ school: opts.school, level: b.level, count: b.count, since: b.since, link }), purpose: "buecherei-mahnung" }, now);
    }
    for (const l of links) {
      const to = emails.get(l.parentId);
      const b = per.get(l.childId)!;
      if (to) await enqueueMail(db, { to, ...dunningMail({ school: opts.school, level: b.level, count: b.count, since: b.since, link, child: childName(byId.get(l.childId)?.firstName) }), purpose: "buecherei-mahnung" }, now);
    }
  }
  return { reminded, dunned: per.size, parents: links.length };
}

async function bumpDunnings(db: Db, month: string, mediaType: MediaType) {
  await db
    .insert(buechereiStats)
    .values({ month, mediaType, dunnings: 1 })
    .onConflictDoUpdate({ target: [buechereiStats.month, buechereiStats.mediaType], set: { dunnings: sql`${buechereiStats.dunnings} + 1` } });
}

// ---------------------------------------------------------------- Mahnliste (Büchereiteam)

/** Mahnstufen anderer sieht das Büchereiteam – Schüler-Helfer:innen nicht (Rechte-Tabelle, docs/BUECHEREI.md). */
export const canSeeDunningLevels = (p: PermissionSet) => canDesk(p) && p.role !== "schueler";

export interface DunningRow {
  loanId: string;
  barcode: string;
  title: string;
  dueOn: string;
  overdueDays: number;
  userId: string | null;
  name: string | null;
  className: string | null;
  /** null = für diese Person nicht sichtbar (Schüler-Helfer:in) */
  dunningLevel: number | null;
  dunnedOn: string | null;
}

/**
 * Mahnliste (Recht `buecherei.desk`): alle überfälligen offenen Ausleihen, am längsten überfällige zuerst – mit Name und Klasse
 * (wie an der Theke), Mahnstufe nur für Erwachsene im Team.
 */
export async function dunningList(db: Db, viewer: PermissionSet, today: string): Promise<DunningRow[]> {
  if (!canDesk(viewer)) throw new ForbiddenError("buecherei.desk");
  const levels = canSeeDunningLevels(viewer);
  const rows = await db
    .select({
      loanId: buechereiLoans.id,
      barcode: buechereiCopies.barcode,
      title: buechereiTitles.title,
      dueOn: buechereiLoans.dueOn,
      userId: buechereiLoans.userId,
      name: users.name,
      dunningLevel: buechereiLoans.dunningLevel,
      dunnedOn: buechereiLoans.dunnedOn,
    })
    .from(buechereiLoans)
    .innerJoin(buechereiCopies, eq(buechereiCopies.id, buechereiLoans.copyId))
    .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiCopies.titleId))
    .leftJoin(users, eq(users.id, buechereiLoans.userId))
    .where(and(isNull(buechereiLoans.returnedOn), lt(buechereiLoans.dueOn, today)))
    .orderBy(asc(buechereiLoans.dueOn), asc(buechereiCopies.barcode));
  const cls = await classNamesOf(
    db,
    rows.map((r) => r.userId).filter((x): x is string => !!x),
  );
  return rows.map((r) => ({
    ...r,
    overdueDays: Math.round((Date.parse(today) - Date.parse(r.dueOn)) / 86_400_000),
    className: r.userId ? (cls.get(r.userId) ?? null) : null,
    dunningLevel: levels ? r.dunningLevel : null,
    dunnedOn: levels ? r.dunnedOn : null,
  }));
}
