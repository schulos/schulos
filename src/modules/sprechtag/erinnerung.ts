// Erinnerung am Vortag (P4-52): ein gebündelter Gong je Person mit allen eigenen Terminen (Familien und Lehrkräfte),
// dazu eine Mail an Familien mit bestätigter Adresse. Läuft als Hintergrundjob einmal je Sprechtag.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { sprechtagAppointments, sprechtagEvents, users, type SprechtagEvent } from "@/core/db/schema";
import { appUrl, enqueueMail } from "@/core/mail";
import { notifyBundled } from "@/core/notifications";
import { addDays, toBerlinDate } from "@/core/time";
import { sprechtagReminderMail, verifiedEmails } from "./mails";
import { familyRecipients, formatEventDay } from "./service";
import { slotEnd } from "./slots";

export interface ReminderOptions {
  mail: boolean;
  school: string;
}

/** Erinnert an die Termine aller Sprechtage von morgen; gibt die Zahl der Gong-Nachrichten zurück. */
export async function runSprechtagReminders(db: Db, now: Date, opts: ReminderOptions): Promise<number> {
  const today = toBerlinDate(now);
  const tomorrow = addDays(today, 1);
  const events = await db
    .select()
    .from(sprechtagEvents)
    .where(and(eq(sprechtagEvents.date, tomorrow), isNull(sprechtagEvents.remindedOn)));
  let sent = 0;
  for (const e of events) sent += await db.transaction((tx) => remindEvent(tx, e, today, now, opts));
  return sent;
}

/**
 * Ein Sprechtag: vermerken und verschicken in **einer** Transaktion (G4D-C11). Das bedingte UPDATE sperrt gegen einen
 * zweiten Prozess; scheitert danach der Versand (Gong und Mail landen beide in der DB), ist auch der Vermerk weg und der
 * nächste Lauf erinnert erneut.
 */
async function remindEvent(db: Db, e: SprechtagEvent, today: string, now: Date, opts: ReminderOptions): Promise<number> {
  const claimed = await db
    .update(sprechtagEvents)
    .set({ remindedOn: today })
    .where(and(eq(sprechtagEvents.id, e.id), isNull(sprechtagEvents.remindedOn)))
    .returning({ id: sprechtagEvents.id });
  if (!claimed.length) return 0;
  const appts = await db
    .select({ slot: sprechtagAppointments.slot, teacherId: sprechtagAppointments.teacherId, studentId: sprechtagAppointments.studentId })
    .from(sprechtagAppointments)
    .where(eq(sprechtagAppointments.eventId, e.id))
    .orderBy(sprechtagAppointments.slot);
  if (!appts.length) return 0;
  const ids = [...new Set(appts.flatMap((a) => [a.teacherId, a.studentId]))];
  const names = new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
  const day = formatEventDay(e.date);
  const family = new Map<string, string[]>();
  const teachers = new Map<string, string[]>();
  for (const a of appts) {
    const time = `${a.slot}–${slotEnd(a.slot, e.slotMinutes)}`;
    // G4D-C05: nur wer (noch) für das Kind handelt – nicht pauschal die buchende Person (eigenständig, Verknüpfung gelöst)
    for (const p of await familyRecipients(db, [a.studentId])) family.set(p, [...(family.get(p) ?? []), `${time} ${names.get(a.teacherId) ?? "Lehrkraft"} (${names.get(a.studentId) ?? ""})`]);
    teachers.set(a.teacherId, [...(teachers.get(a.teacherId) ?? []), `${time} ${names.get(a.studentId) ?? ""}`]);
  }
  const count = (n: number) => (n === 1 ? "1 Termin" : `${n} Termine`);
  const familyHref = `/sprechtag/buchen?e=${e.id}`;
  const sent = await notifyBundled(
    db,
    [
      ...[...family].map(([userId, lines]) => ({ userId, title: `Morgen Elternsprechtag: ${count(lines.length)}`, body: lines.join(" · "), href: familyHref })),
      ...[...teachers].map(([userId, lines]) => ({ userId, title: `Morgen Elternsprechtag: ${count(lines.length)}`, body: lines.join(" · "), href: `/sprechtag/${e.id}` })),
    ],
    { moduleId: "sprechtag", bundleKey: `sprechtag:erinnerung:${e.id}` },
  );
  if (opts.mail) {
    const emails = await verifiedEmails(db, [...family.keys()]);
    for (const [userId, to] of emails) {
      await enqueueMail(db, { to, ...sprechtagReminderMail({ school: opts.school, day, lines: family.get(userId)!, link: appUrl(familyHref) }), purpose: "sprechtag-erinnerung" }, now);
    }
  }
  return sent;
}
