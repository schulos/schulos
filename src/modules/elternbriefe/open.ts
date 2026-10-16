// „Offen für dich“ (Q5-07): Eltern – Briefe ohne Bestätigung je Kind; Verfasser:innen – Rücklauf eigener Briefe mit „Erinnern“.
// Nur eigene Vorgänge: Eltern sehen ihre Kinder, Lehrkräfte/Verwaltung nur Briefe, die sie selbst geschrieben haben (auch
// mit `send_all` – sonst bekäme das Sekretariat den Rücklauf aller Kolleg:innen als Liste).
import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { parentChild, parentLetterReceipts, parentLetters, users } from "@/core/db/schema";
import type { OpenItem, OpenItemsProvider } from "@/core/open-items";
import type { PermissionSet } from "@/core/permissions";
import { parentActsSql } from "@/core/school/majority";
import { addDays, toBerlinDate } from "@/core/time";
import { remindAllowed } from "./service";

/** Rücklauf ohne Frist so lange anzeigen */
export const RETURN_WINDOW_DAYS = 21;
const MAX_LETTERS = 3;

async function forParent(db: Db, parentId: string): Promise<OpenItem[]> {
  const rows = await db
    .select({ childName: users.firstName, letterId: parentLetterReceipts.letterId })
    .from(parentChild)
    .innerJoin(users, eq(users.id, parentChild.childId))
    .innerJoin(parentLetterReceipts, eq(parentLetterReceipts.studentId, parentChild.childId))
    // Q5-05: nur Kinder, für die die Eltern handeln – eigenständige bestätigen selbst
    .where(and(eq(parentChild.parentId, parentId), parentActsSql(), isNull(parentLetterReceipts.confirmedAt)));
  return confirmItem(rows);
}

/** Q5-05: eigenständige Schüler:innen bestätigen ihre Briefe selbst. */
async function forSelf(db: Db, studentId: string): Promise<OpenItem[]> {
  const rows = await db
    .select({ letterId: parentLetterReceipts.letterId })
    .from(parentLetterReceipts)
    .innerJoin(users, eq(users.id, parentLetterReceipts.studentId))
    .where(and(eq(parentLetterReceipts.studentId, studentId), eq(users.selfResponsible, true), isNull(parentLetterReceipts.confirmedAt)));
  if (rows.length === 0) return [];
  return [{ id: "elternbriefe:bestaetigen", moduleId: "elternbriefe", label: rows.length === 1 ? "Brief der Schule bestätigen" : "Briefe der Schule bestätigen", count: rows.length, href: "/elternbriefe", tone: "warn" }];
}

function confirmItem(rows: { childName: string }[]): OpenItem[] {
  if (rows.length === 0) return [];
  const perChild = new Map<string, number>();
  for (const r of rows) perChild.set(r.childName, (perChild.get(r.childName) ?? 0) + 1);
  return [
    {
      id: "elternbriefe:bestaetigen",
      moduleId: "elternbriefe",
      label: rows.length === 1 ? "Elternbrief bestätigen" : "Elternbriefe bestätigen",
      count: rows.length,
      detail: perChild.size > 1 ? [...perChild].map(([name, n]) => `${name} ${n}`).join(" · ") : `für ${[...perChild.keys()][0]}`,
      href: "/elternbriefe",
      tone: "warn",
    },
  ];
}

async function forAuthor(db: Db, viewer: PermissionSet, now: Date): Promise<OpenItem[]> {
  const today = toBerlinDate(now);
  const letters = await db
    .select()
    .from(parentLetters)
    .where(
      and(
        eq(parentLetters.authorId, viewer.userId),
        or(gte(parentLetters.dueDate, today), and(isNull(parentLetters.dueDate), gte(parentLetters.createdAt, new Date(now.getTime() - RETURN_WINDOW_DAYS * 86_400_000)))),
      ),
    )
    .orderBy(desc(parentLetters.createdAt));
  if (letters.length === 0) return [];
  const receipts = await db
    .select({ letterId: parentLetterReceipts.letterId, confirmedAt: parentLetterReceipts.confirmedAt })
    .from(parentLetterReceipts)
    .where(inArray(parentLetterReceipts.letterId, letters.map((l) => l.id)));
  const out: OpenItem[] = [];
  for (const l of letters) {
    const mine = receipts.filter((r) => r.letterId === l.id);
    const confirmed = mine.filter((r) => r.confirmedAt).length;
    if (mine.length === 0 || confirmed === mine.length) continue;
    out.push({
      id: `elternbriefe:ruecklauf:${l.id}`,
      moduleId: "elternbriefe",
      label: `Rücklauf „${l.title}“`,
      count: mine.length - confirmed,
      detail: `${confirmed} von ${mine.length} bestätigt${l.dueDate ? ` · bis ${l.dueDate.slice(8)}.${l.dueDate.slice(5, 7)}.` : ""}`,
      href: `/elternbriefe/${l.id}`,
      tone: l.dueDate && l.dueDate <= addDays(today, 1) ? "warn" : "info",
      remindLetterId: remindAllowed(l, now) ? l.id : undefined,
    });
    if (out.length === MAX_LETTERS) break;
  }
  return out;
}

export const elternbriefeOpen: OpenItemsProvider = {
  moduleId: "elternbriefe",
  async collect(db, { perms }, now) {
    if (perms.role === "eltern") return forParent(db, perms.userId);
    if (perms.role === "schueler") return forSelf(db, perms.userId);
    if (["lehrkraft", "verwaltung", "admin"].includes(perms.role)) return forAuthor(db, perms, now);
    return [];
  },
};
