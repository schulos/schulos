// SP2-07: Wann und wo eine Stunde an einem Tag tatsächlich liegt – nach Entfall, Vertretung, Raumänderung, Verlegung und
// Zusammenlegung (rein, testbar). Grundlage für „Lehrkraft/Raum/Gruppe belegt?“ in Vertretung, Vorschlägen und Raumplan.

export interface SlotLesson {
  periodNr: number;
  groupId: string;
  teacherId: string | null;
  roomId: string | null;
}

export interface SlotSub {
  kind: "cancel" | "substitute" | "room" | "move" | "merge";
  substituteId: string | null;
  roomId: string | null;
  targetPeriod: number | null;
}

/** Stunde, in der die eigene Lehrkraft die Stunde hält – `null`: gar nicht (Entfall, vertreten, zusammengelegt). */
export function ownTeacherPeriod(l: Pick<SlotLesson, "periodNr">, s: SlotSub | undefined): number | null {
  if (!s || s.kind === "room") return l.periodNr;
  if (s.kind === "move") return s.targetPeriod;
  return null;
}

/**
 * Stunde, in der die Gruppe in dieser Stunde ist – `null` bei Entfall. Zusammengelegt ist die Gruppe zur selben Zeit bei der
 * anderen Stunde (also beschäftigt), verlegt in der neuen Stunde.
 */
export function groupPeriod(l: Pick<SlotLesson, "periodNr">, s: SlotSub | undefined): number | null {
  if (s?.kind === "cancel") return null;
  if (s?.kind === "move") return s.targetPeriod;
  return l.periodNr;
}

/** Raum, den die Stunde belegt, mit Stunde – `null` bei Entfall oder Zusammenlegung (die Gruppe ist im Raum der anderen Stunde). */
export function roomUse(l: Pick<SlotLesson, "periodNr" | "roomId">, s: SlotSub | undefined): { periodNr: number; roomId: string } | null {
  if (s?.kind === "cancel" || s?.kind === "merge") return null;
  const roomId = s?.roomId ?? l.roomId;
  const periodNr = s?.kind === "move" ? s.targetPeriod : l.periodNr;
  return roomId && periodNr !== null ? { periodNr, roomId } : null;
}

/** Findet die Stunde zu ihrer regulären Zeit statt (Vertretung, Raumänderung oder ohne Änderung)? */
export const takesPlaceAsUsual = (s: Pick<SlotSub, "kind"> | undefined) => !s || s.kind === "substitute" || s.kind === "room";
