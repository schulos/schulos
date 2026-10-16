// Wer darf mit wem einen Direktchat führen – über die Sichtbarkeit im Adressbuch hinaus (Moduleinstellungen, Q5-14).
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groupMembers, groups } from "@/core/db/schema";
import { readModuleSetting } from "@/core/modules/settings";
import type { Role } from "@/core/roles";
import { COUNSELING_CHAT, STUDENT_DIRECT } from "./settings";

export interface ChatParty {
  id: string;
  role: Role;
}

/** Haben beide eine gemeinsame (nicht archivierte) Klasse? */
async function shareClass(db: Db, a: string, b: string): Promise<boolean> {
  const rows = await db
    .select({ userId: groupMembers.userId, groupId: groupMembers.groupId })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(inArray(groupMembers.userId, [a, b]), eq(groups.kind, "klasse"), isNull(groups.archivedAt)));
  const ofA = new Set(rows.filter((r) => r.userId === a).map((r) => r.groupId));
  return rows.some((r) => r.userId === b && ofA.has(r.groupId));
}

/** Schüler:innen und Eltern ↔ Beratung: die heikle Paarung aus Q5-17 */
export function isCounselingPair(a: Role, b: Role): boolean {
  const client = (r: Role) => r === "schueler" || r === "eltern";
  return (a === "beratung" && client(b)) || (b === "beratung" && client(a));
}

export const COUNSELING_NOTICE = "Nur zur Terminabsprache – bitte keine Beratungsinhalte im Chat. der Chat wird 90 Tage nach der letzten Nachricht gelöscht";

/**
 * Grund, warum zwischen `self` und `other` kein Direktchat (mehr) möglich ist, sonst null. Gilt beim Öffnen und beim
 * Senden – eine geänderte Einstellung wirkt so auch auf bestehende Chats (Lesen bleibt möglich).
 * `initiating`: es gibt noch keinen Chat – `self` würde ihn beginnen.
 */
export async function directChatBlock(db: Db, self: ChatParty, other: ChatParty, opts: { initiating?: boolean } = {}): Promise<string | null> {
  if (isCounselingPair(self.role, other.role)) {
    if ((await readModuleSetting(db, COUNSELING_CHAT)) !== "an") return "Chats mit der Schulsozialarbeit sind an dieser Schule nicht freigeschaltet – bitte die Sprechzeiten im Adressbuch nutzen";
    if (opts.initiating && self.role === "beratung") return "Die Schulsozialarbeit beginnt keine Chats mit Schüler:innen oder Eltern – sie schreiben zuerst";
  }
  if (self.role === "schueler" && other.role === "schueler") {
    const mode = await readModuleSetting(db, STUDENT_DIRECT);
    if (mode === "aus") return "Direktchats unter Schüler:innen sind an dieser Schule ausgeschaltet";
    if (mode === "klasse" && !(await shareClass(db, self.id, other.id))) return "Direktchats unter Schüler:innen nur innerhalb der eigenen Klasse";
  }
  return null;
}
