// Mails des Elternsprechtags (P4-51/P4-52): Gesprächswunsch und Erinnerung am Vortag – nur Text, ohne Gesprächsinhalte.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { users } from "@/core/db/schema";
import { realEmail } from "@/core/auth/email";
import { mailFooter, type MailContent } from "@/core/mail-templates";

export function sprechtagInviteMail(p: { school: string; teacher: string; child: string; day: string; link: string }): MailContent {
  return {
    subject: `${p.school}: Gesprächswunsch zum Elternsprechtag`,
    text: [
      "Guten Tag,",
      "",
      `${p.teacher} möchte am Elternsprechtag (${p.day}) gern mit Ihnen über ${p.child} sprechen.`,
      "Bitte buchen Sie in SchulOS einen Termin:",
      "",
      p.link,
      mailFooter(p.school),
    ].join("\n"),
  };
}

export function sprechtagReminderMail(p: { school: string; day: string; lines: string[]; link: string }): MailContent {
  return {
    subject: `${p.school}: Erinnerung an Ihre Termine am Elternsprechtag`,
    text: [
      "Guten Tag,",
      "",
      `morgen (${p.day}) ist Elternsprechtag. Ihre Termine:`,
      "",
      ...p.lines.map((l) => `- ${l}`),
      "",
      "Falls Sie nicht kommen können, sagen Sie bitte in SchulOS ab – dann wird die Zeit für andere Familien frei:",
      p.link,
      mailFooter(p.school),
    ].join("\n"),
  };
}

/** Bestätigte, echte Adressen der Personen (Platzhalter und unbestätigte Adressen bekommen keine Mail). */
export async function verifiedEmails(db: Db, userIds: readonly string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(inArray(users.id, [...userIds]), eq(users.emailVerified, true), eq(users.status, "active")));
  return new Map(rows.flatMap((r) => (realEmail(r.email) ? [[r.id, r.email] as [string, string]] : [])));
}
