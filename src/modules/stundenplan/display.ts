// Wie eine Stunde angezeigt wird – inkl. Vertretung, Entfall, Raumänderung (rein, testbar).
import type { LessonSlot } from "./service";

/** Wessen Plan: Schüler:in/Eltern, Lehrkraft, Gruppe oder Raum */
export type PlanView = "student" | "teacher" | "group" | "room";

export interface SlotDisplay {
  tone: "normal" | "sub" | "off";
  tag: string | null;
  detail: string;
  note: string | null;
  struck: boolean;
}

const room = (id: string | null | undefined) => (id ? `R ${id}` : null);
const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" · ");

/** SP-12: „Mathe statt Sport“ – Fach mit dem regulären Fach, wenn die Vertretung ein anderes gibt. */
export function subjectLabel(name: string, insteadOf: string | null | undefined): string {
  return insteadOf ? `${name} statt ${insteadOf}` : name;
}

/** Art einer Änderung (Vertretungsplan, Monitor, Druck, Gong). */
export const CHANGE_KIND_LABEL = { cancel: "Entfall", substitute: "Vertretung", room: "Raumänderung", move: "Verlegung", merge: "Zusammenlegung" } as const;

/** Eintrag im Vertretungsplan, soweit für die Anzeige nötig (DaySubstitution). */
export interface ChangeEntry {
  kind: keyof typeof CHANGE_KIND_LABEL;
  movedFrom: number | null;
  movedTo: number | null;
  mergeWith: { groupName: string; teacherCode: string | null; roomId: string | null } | null;
  substituteCode: string | null;
  substituteName?: string | null;
  roomId: string | null;
  newRoomId: string | null;
}

/** SP2-07: fällt die Stunde hier aus (Entfall, verlegt in eine andere Stunde)? */
export const changeOff = (e: Pick<ChangeEntry, "kind" | "movedTo">) => e.kind === "cancel" || (e.kind === "move" && e.movedTo !== null);

/** SP2-07: Art mit Einzelheiten – „Verlegung aus der 3. Std.“, „verlegt in die 1. Std.“, „Zusammenlegung mit 7b“. */
export function changeLabel(e: Pick<ChangeEntry, "kind" | "movedFrom" | "movedTo" | "mergeWith">): string {
  if (e.kind === "move" && e.movedTo !== null) return `verlegt in die ${e.movedTo}. Std.`;
  if (e.kind === "move" && e.movedFrom !== null) return `Verlegung aus der ${e.movedFrom}. Std.`;
  if (e.kind === "merge") return e.mergeWith ? `Zusammenlegung mit ${e.mergeWith.groupName.replace(/^Klasse /, "")}` : "Zusammenlegung aufgehoben";
  return CHANGE_KIND_LABEL[e.kind];
}

/** Lehrkraft, die die Stunde hält: Vertretung bzw. Mitbetreuung (SP2-07); sonst null. */
export function changeTeacher(e: ChangeEntry, long = false): string | null {
  if (e.kind === "substitute") return (long ? (e.substituteName ?? e.substituteCode) : (e.substituteCode ?? e.substituteName)) ?? null;
  if (e.kind === "merge") return e.mergeWith?.teacherCode ?? null;
  return null;
}

/** Raum, in dem die Stunde stattfindet; null, wenn sie hier ausfällt. */
export function changeRoom(e: ChangeEntry): string | null {
  if (changeOff(e)) return null;
  if (e.kind === "merge") return e.mergeWith?.roomId ?? null;
  return e.newRoomId ?? e.roomId;
}

/** `long`: ausgeschriebene Namen statt Kürzel (Tagesleiste). */
export function slotDisplay(s: LessonSlot, view: PlanView, long = false): SlotDisplay {
  const teacher = long ? (s.teacherName ?? s.teacherCode) : (s.teacherCode ?? s.teacherName);
  const c = s.change;
  const substitute = c ? (long ? (c.substituteName ?? c.substituteCode) : (c.substituteCode ?? c.substituteName)) : null;
  const effRoom = c?.roomId ?? s.roomId;
  const note = c?.note ?? null;
  // SP-12: Fachtausch – der Slot trägt schon das tatsächliche Fach, die Zeile darunter nennt das reguläre
  const instead = c?.kind === "substitute" && c.insteadOf ? `statt ${c.insteadOf}` : null;
  const regular = view === "teacher" ? join(s.groupName, room(s.roomId)) : view === "room" ? join(s.groupName, teacher) : join(teacher, room(s.roomId));

  if (c?.kind === "cancel") return { tone: "off", tag: "Entfällt", detail: regular, note, struck: true };
  // SP2-07 Verlegung: bisherige Stunde fällt hier aus, neue Stunde ist eine Änderung
  if (s.moved === "from") return { tone: "off", tag: "Verlegt", detail: join(view === "teacher" ? s.groupName : teacher, c?.targetPeriod ? `→ ${c.targetPeriod}. Std.` : null), note, struck: true };
  if (s.moved === "to") return { tone: "sub", tag: "Verlegt hierher", detail: join(view === "teacher" ? s.groupName : teacher, room(effRoom), s.movedFrom ? `aus der ${s.movedFrom}. Std.` : null), note, struck: false };
  // SP2-07 Zusammenlegung: die Gruppe geht zur anderen Stunde; Lehrkraft und Raum sehen sie als „abgegeben“
  if (c?.kind === "merge") {
    const w = c.mergeWith;
    // R1b/A10: aufnehmende Stunde gelöscht – die Zusammenlegung steht ohne Ziel, bis sie neu geregelt ist
    if (!w) return { tone: "sub", tag: "Zusammenlegung aufgehoben", detail: s.perspective === "away" ? s.groupName : regular, note, struck: false };
    return s.perspective === "away"
      ? { tone: "off", tag: "Zusammengelegt", detail: join(s.groupName, w && `→ ${coupledGroupLabel([w.groupName])} bei ${w.teacherCode ?? "–"}`), note: null, struck: true }
      : { tone: "sub", tag: "Zusammenlegung", detail: join(w && `mit ${coupledGroupLabel([w.groupName])}`, w?.teacherCode, room(w?.roomId)), note, struck: false };
  }
  if (s.perspective === "away") {
    return view === "room"
      ? { tone: "off", tag: "Verlegt", detail: join(s.groupName, `→ ${room(effRoom)}`), note: null, struck: true }
      : { tone: "off", tag: "Vertreten", detail: join(s.groupName, substitute && `durch ${substitute}`), note: null, struck: true };
  }
  if (s.perspective === "covering") {
    return view === "room"
      ? { tone: "sub", tag: "Verlegt hierher", detail: join(instead, s.groupName, c?.kind === "substitute" ? substitute : teacher), note, struck: false }
      : { tone: "sub", tag: "Vertretung", detail: join(instead, s.groupName, room(effRoom), teacher && `für ${s.teacherCode ?? teacher}`), note, struck: false };
  }
  if (c?.kind === "substitute") {
    const who = view === "teacher" || view === "room" ? s.groupName : substitute;
    return { tone: "sub", tag: "Vertretung", detail: join(instead, who, room(effRoom)), note, struck: false };
  }
  if (c?.kind === "room") {
    return { tone: "sub", tag: "Raumänderung", detail: view === "teacher" ? join(s.groupName, room(effRoom)) : join(teacher, room(effRoom)), note, struck: false };
  }
  // SP2-07: Gruppen, die zu dieser Stunde zusammengelegt sind (Mitbetreuung)
  if (s.joined?.length) return { tone: "sub", tag: "Mitbetreuung", detail: join(regular, `+ ${coupledGroupLabel(s.joined)}`), note: null, struck: false };
  return { tone: "normal", tag: null, detail: regular, note: null, struck: false };
}

/** „Klasse 7a“, „Klasse 7b“ → „7a, 7b“ */
export function coupledGroupLabel(names: string[]): string {
  return names.map((n) => n.replace(/^Klasse /, "")).join(", ");
}

/**
 * Lehrkraft- und Raumsicht: Teile einer Kopplung mit gleicher Lehrkraft, gleichem Raum und gleicher Änderung
 * erscheinen als eine Stunde mit allen Gruppen (Religion für 7a und 7b ist eine Stunde, nicht zwei).
 */
export function mergeCoupled(slots: LessonSlot[]): LessonSlot[] {
  const out: LessonSlot[] = [];
  const byKey = new Map<string, LessonSlot>();
  for (const s of slots) {
    if (!s.couplingId) {
      out.push(s);
      continue;
    }
    const c = s.change;
    const key = [s.couplingId, s.date, s.periodNr, s.teacherId, s.roomId, s.subjectId, c?.kind, c?.substituteId, c?.roomId, s.perspective, s.moved].join("|");
    const hit = byKey.get(key);
    if (!hit) {
      const first = { ...s, coupledGroups: [{ id: s.groupId, name: s.groupName }] };
      byKey.set(key, first);
      out.push(first);
      continue;
    }
    hit.coupledGroups!.push({ id: s.groupId, name: s.groupName });
    hit.groupName = coupledGroupLabel(hit.coupledGroups!.map((g) => g.name));
  }
  return out;
}
