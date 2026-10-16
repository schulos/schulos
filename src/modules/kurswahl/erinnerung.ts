// Kurswahlen (P4-62): Erinnerung an Nichtwähler – ein Gong an alle, die für eine Person der Zielgruppe noch wählen
// (bzw. bei Eltern-Bestätigung noch bestätigen) müssen. Die Verwaltung löst sie im Wahlzeitraum von Hand aus; dazu (P4-66)
// automatisch zwei Tage vor Wahlende, einmal je Verfahren (Hintergrundjob wie die Sprechtag-Erinnerung, keine Mail).
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { kurswahlVerfahren, kurswahlWahlen, type KurswahlVerfahren } from "@/core/db/schema";
import { notify } from "@/core/notifications";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { parentLinks, selfResponsibleIds } from "@/core/school/majority";
import { addDays, toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { MANAGE, choosersOf, getVerfahren, targetStudents, verfahrenState } from "./service";

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", timeZone: "UTC" });
const day = (ymd: string) => dayFmt.format(new Date(`${ymd}T12:00:00Z`));

/** P4-66: so viele Tage vor dem Wahlende erinnert der Job */
export const AUTO_REMIND_DAYS_BEFORE = 2;
/** P4-66: hat die Verwaltung in diesem Abstand schon von Hand erinnert, entfällt die automatische Erinnerung (Q-4E-14) */
export const MANUAL_GRACE_MS = 24 * 3_600_000;

export interface Missing {
  /** ohne abgegebene Wahl */
  notChosen: string[];
  /** gewählt, aber (bei Eltern-Bestätigung) noch nicht bestätigt */
  notConfirmed: string[];
}

/** Wer in der Zielgruppe noch nicht gewählt bzw. (Eltern-Häkchen) noch nicht bestätigt ist. */
export async function missing(db: Db, verfahrenId: string): Promise<Missing> {
  const v = await getVerfahren(db, verfahrenId);
  if (!v) return { notChosen: [], notConfirmed: [] };
  const [target, wahlen] = await Promise.all([targetStudents(db, v), db.select().from(kurswahlWahlen).where(eq(kurswahlWahlen.verfahrenId, v.id))]);
  // P4-67: Abgabe und Bestätigung stehen in der Zeile des 1. Platzes
  const byStudent = new Map(wahlen.filter((w) => w.place === 1).map((w) => [w.studentId, w]));
  const notChosen = target.filter((t) => !byStudent.get(t.id)?.submittedAt).map((t) => t.id);
  let notConfirmed: string[] = [];
  if (v.chooser === "schueler" && v.parentConfirm) {
    const chosen = target.filter((t) => byStudent.get(t.id)?.submittedAt && !byStudent.get(t.id)?.confirmedAt).map((t) => t.id);
    const self = await selfResponsibleIds(db, chosen);
    notConfirmed = chosen.filter((s) => !self.has(s));
  }
  return { notChosen, notConfirmed };
}

/** Gong an alle, die noch wählen bzw. bestätigen müssen (Text je nach Fall). Gibt die Zahl der Empfänger:innen zurück. */
async function sendReminder(db: Db, v: KurswahlVerfahren): Promise<number> {
  const m = await missing(db, v.id);
  const choosers = await choosersOf(db, v, m.notChosen);
  const confirmers = [...new Set((await parentLinks(db, m.notConfirmed, "act")).map((l) => l.parentId))].filter((p) => !choosers.includes(p));
  const until = day(v.closesOn);
  await notify(db, choosers, { moduleId: "kurswahl", title: `Erinnerung: ${v.title}`, body: `Bitte bis ${until} wählen.`, href: "/kurswahl" });
  await notify(db, confirmers, { moduleId: "kurswahl", title: `Erinnerung: ${v.title}`, body: `Ihr Kind hat gewählt – bitte bis ${until} bestätigen.`, href: "/kurswahl" });
  return choosers.length + confirmers.length;
}

/** Erinnerung von Hand (Verwaltung, P4-62). */
export async function remindNonVoters(db: Db, perms: PermissionSet, verfahrenId: string, today: string, now = new Date()): Promise<number> {
  if (!hasPermission(perms, MANAGE)) throw new ForbiddenError(MANAGE);
  const v = await getVerfahren(db, verfahrenId);
  if (!v) throw new ValidationError({ remind: "Dieses Wahlverfahren gibt es nicht mehr" });
  if (verfahrenState(v, today) !== "offen") throw new ValidationError({ remind: "Erinnern geht nur, solange die Wahl offen ist" });
  const n = await sendReminder(db, v);
  await db.update(kurswahlVerfahren).set({ remindedAt: now }).where(and(eq(kurswahlVerfahren.id, v.id)));
  await audit(db, perms.userId, "kurswahl.remind", v.id, { recipients: n });
  return n;
}

/** Rein: Ist für dieses Verfahren heute die automatische Erinnerung dran? (ab zwei Tage vor Wahlende bis zum letzten Tag – holt einen verpassten Lauf nach) */
export function autoReminderDue(v: Pick<KurswahlVerfahren, "opensOn" | "closesOn" | "transferredAt" | "autoRemindedOn">, today: string): boolean {
  if (v.autoRemindedOn || verfahrenState(v, today) !== "offen") return false;
  return today >= addDays(v.closesOn, -AUTO_REMIND_DAYS_BEFORE);
}

/**
 * P4-66: Hintergrundjob – alle offenen Verfahren, deren Wahl in zwei Tagen endet, einmal erinnern. Vermerken und verschicken in
 * einer Transaktion (wie beim Sprechtag, G4D-C11): das bedingte UPDATE sperrt gegen einen zweiten Prozess, scheitert der Versand,
 * ist auch der Vermerk weg. Gibt die Zahl der Empfänger:innen zurück.
 */
export async function runKurswahlReminders(db: Db, now: Date): Promise<number> {
  const today = toBerlinDate(now);
  const due = await db
    .select()
    .from(kurswahlVerfahren)
    .where(
      and(
        isNull(kurswahlVerfahren.autoRemindedOn),
        isNull(kurswahlVerfahren.transferredAt),
        lte(kurswahlVerfahren.opensOn, today),
        gte(kurswahlVerfahren.closesOn, today),
        lte(kurswahlVerfahren.closesOn, addDays(today, AUTO_REMIND_DAYS_BEFORE)),
      ),
    );
  let sent = 0;
  for (const v of due) {
    if (!autoReminderDue(v, today)) continue;
    sent += await db.transaction(async (tx) => {
      const claimed = await tx
        .update(kurswahlVerfahren)
        .set({ autoRemindedOn: today })
        .where(and(eq(kurswahlVerfahren.id, v.id), isNull(kurswahlVerfahren.autoRemindedOn)))
        .returning({ id: kurswahlVerfahren.id });
      if (!claimed.length) return 0;
      // eben erst von Hand erinnert → keine zweite Erinnerung so kurz danach
      if (v.remindedAt && now.getTime() - v.remindedAt.getTime() < MANUAL_GRACE_MS) {
        await audit(tx, null, "kurswahl.remind.auto", v.id, { recipients: 0, grund: "von Hand erinnert" });
        return 0;
      }
      const n = await sendReminder(tx, v);
      await audit(tx, null, "kurswahl.remind.auto", v.id, { recipients: n });
      return n;
    });
  }
  return sent;
}
