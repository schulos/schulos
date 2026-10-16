// Notenbuch (P5-17, F5-14): Datenschutzhinweis beim ersten Öffnen. Wer das Notenbuch als Lehrkraft, Klassen-/Schulleitung oder
// mit einem Notenbuch-Recht nutzt, bestätigt einmal, den Hinweis gelesen zu haben – erst danach zeigen Seiten Inhalte, Actions und
// Export laufen erst danach. Gespeichert je Konto mit der Fassung des Hinweises (`notenbuch_notice_acks`); ändert sich der Text
// wesentlich, hebt `NOTICE_VERSION` die Bestätigung auf und der Hinweis kommt erneut. Q-5A-22 (Projektleitung 2026-10-14): außerdem
// **je Schuljahr neu** – eine Bestätigung vor dem Beginn des laufenden Schuljahres gilt nicht mehr. Schüler:innen und Eltern
// (Lesesicht P5-14) sehen keinen Hinweis – sie lesen nur eigene Daten.
import { eq } from "drizzle-orm";
import { schoolYears } from "@/core/db/schema";
import { toBerlinDate } from "@/core/time";
import type { Db } from "@/core/db/client";
import { notenbuchNoticeAcks } from "@/core/db/schema";
import { accessBlocked, ForbiddenError, type PermissionSet } from "@/core/permissions";
import { notenbuchAccess } from "./service";
import { IDLE_MINUTES } from "./sitzung";

/** Fassung des Hinweises – bei wesentlichen Änderungen am Text erhöhen (alle bestätigen neu). */
export const NOTICE_VERSION = 1;

export const NOTICE_TITLE = "Datenschutzhinweis zum Notenbuch";

/** Der Hinweis in Punkten (Seite beim ersten Öffnen und zum Nachlesen auf `/notenbuch`). */
export const NOTICE_POINTS: readonly string[] = [
  "Das Notenbuch ist eine Datensammlung der Schule (Notenliste der Lehrkraft, Anlage 2 II Nr. 4 VO-DV I). Verantwortlich ist die Schule; die Daten gehören nicht der einzelnen Lehrkraft und bleiben bei Abgang oder Ausfall erhalten.",
  "Teilnoten und Kommentare sehen nur die Lehrkräfte des Notenbuchs. Klassen- und Schulleitung sehen nur Halbjahreswerte, jeder Abruf wird protokolliert; Verwaltung und Admin-Konten sehen keine Noten.",
  "Nutze das Notenbuch auf dienstlichen Geräten. Ein privates Gerät nur mit schriftlicher Genehmigung der Schulleitung (§ 2 Abs. 2 VO-DV I) – auch, wenn nur im Browser gearbeitet wird.",
  "Keine Kopien außerhalb von SchulOS: keine Bildschirmfotos, keine Ablage von Exporten in privaten Cloud-Speichern oder Apps ohne Vertrag mit der Schule. SchulOS selbst legt nichts im Browser ab.",
  "Kommentare kurz und sachlich – keine Angaben zu Gesundheit, Familie oder Verhalten.",
  `Gerät beim Verlassen sperren und nach der Arbeit abmelden. Nach ${IDLE_MINUTES} Minuten ohne Eingabe sperrt sich das Notenbuch selbst.`,
  "Amtliche Zeugnisnoten stehen weiter in der Schulverwaltungssoftware; das Notenbuch liefert nur Vorschläge und den Export.",
];

/**
 * Rein: ist eine gespeicherte Bestätigung noch gültig? Aktuelle Fassung **und** (Q-5A-22) nicht vor dem Beginn des laufenden
 * Schuljahres (`yearStart`, YYYY-MM-DD; ohne laufendes Schuljahr zählt nur die Fassung).
 */
export function noticeCurrent(version: number | null | undefined, acknowledgedAt?: Date | null, yearStart?: string | null): boolean {
  if (typeof version !== "number" || version < NOTICE_VERSION) return false;
  if (!yearStart) return true;
  return Boolean(acknowledgedAt && toBerlinDate(acknowledgedAt) >= yearStart);
}

/** Hat die Person den aktuellen Hinweis in diesem Schuljahr bestätigt? */
export async function noticeAcknowledged(db: Db, userId: string): Promise<boolean> {
  const [[row], [year]] = await Promise.all([
    db.select({ version: notenbuchNoticeAcks.version, at: notenbuchNoticeAcks.acknowledgedAt }).from(notenbuchNoticeAcks).where(eq(notenbuchNoticeAcks.userId, userId)),
    db.select({ startsOn: schoolYears.startsOn }).from(schoolYears).where(eq(schoolYears.isCurrent, true)),
  ]);
  return noticeCurrent(row?.version, row?.at, year?.startsOn);
}

/** Bestätigung speichern (bzw. auf die aktuelle Fassung heben) – nur, wer das Notenbuch überhaupt nutzen darf. */
export async function acknowledgeNotice(db: Db, perms: PermissionSet, now = new Date()): Promise<void> {
  if (accessBlocked(perms) || !(await notenbuchAccess(db, perms)).any) throw new ForbiddenError("notenbuch.own");
  await db
    .insert(notenbuchNoticeAcks)
    .values({ userId: perms.userId, version: NOTICE_VERSION, acknowledgedAt: now })
    .onConflictDoUpdate({ target: notenbuchNoticeAcks.userId, set: { version: NOTICE_VERSION, acknowledgedAt: now } });
}
