// Wie eine Stunde angezeigt wird – inkl. Vertretung, Entfall, Raumänderung (rein, testbar).
import type { LessonSlot } from "./service";
import type { SubstitutionReason } from "./schema";
import { fromBerlinLocal, toBerlinLocal } from "@/core/time";

/** Wessen Plan: Schüler:in/Eltern, Lehrkraft, Gruppe oder Raum */
export type PlanView = "student" | "teacher" | "group" | "room";

export interface SlotDisplay {
  tone: "normal" | "sub" | "off";
  tag: string | null;
  detail: string;
  note: string | null;
  struck: boolean;
  /** VT-02 (F-10-8): öffentliche Grund-Kategorie der Änderung („Lehrkraft abwesend“), sonst null */
  reason?: string | null;
}

/** VT-01 (F-10-8): Anzeige der öffentlichen Grund-Kategorie – grob, nie krank/Fortbildung/dienstlich. */
export const SUBSTITUTION_REASON_LABELS: Record<SubstitutionReason, string> = {
  lehrkraft_abwesend: "Lehrkraft abwesend",
  klassenfahrt: "Klassenfahrt",
  exkursion: "Exkursion",
  praktikum: "Praktikum",
  pruefung: "Prüfung",
  veranstaltung: "Veranstaltung",
  raum_gesperrt: "Raum gesperrt",
  organisatorisch: "organisatorisch",
  sonstiges: "sonstiger Grund",
};

/** VT-02: Anzeige der Kategorie (leer = ohne Angabe). */
export function reasonLabel(reason: SubstitutionReason | null | undefined): string | null {
  return reason ? SUBSTITUTION_REASON_LABELS[reason] : null;
}

/**
 * VT-02: Raum einheitlich „alt → neu“ (Vertretungsplan, Monitor, Druck, Wochenplan, Planung). Gleicher oder fehlender neuer Raum →
 * nur der Raum; ohne bisherigen Raum → nur der neue. Ohne Präfix (die Spalte heißt „Raum“), `prefix` z. B. „R “ im Wochenplan.
 */
export function roomShift(before: string | null | undefined, after: string | null | undefined, prefix = ""): string | null {
  if (!after || after === before) return before ? `${prefix}${before}` : null;
  return before ? `${prefix}${before} → ${after}` : `${prefix}${after}`;
}

/** VT-02: „neu“/„geändert“ seit dem letzten Stichzeitpunkt (Marker aus der Historie). */
export type ChangeMarker = "neu" | "geaendert";
export const CHANGE_MARKER_LABEL: Record<ChangeMarker, string> = { neu: "neu", geaendert: "geändert" };

/** Uhrzeit, zu der am Vortag die Vertretungsnachricht rausgeht (bis VT-04 fest; dann Moduleinstellung `notify_eve_time`). */
export const MARKER_HOUR = 18;

/**
 * VT-02: Stichzeitpunkt der Marker – der letzte Vortags-Versand (18:00 Berliner Zeit) vor `now`. Was danach angelegt oder geändert
 * wurde, ist „neu“/„geändert“. Rein (Berliner Ortszeit wird vom Aufrufer als „YYYY-MM-DDTHH:MM“ übergeben).
 */
export function markerSinceLocal(nowLocal: string): string {
  const day = nowLocal.slice(0, 10);
  const hour = Number(nowLocal.slice(11, 13));
  const at = `T${String(MARKER_HOUR).padStart(2, "0")}:00`;
  if (hour >= MARKER_HOUR) return `${day}${at}`;
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.toISOString().slice(0, 10)}${at}`;
}

/** VT-02: Stichzeitpunkt der Marker zu `now` und der Text dazu („seit gestern, 18:00 Uhr“). */
export function markerSince(now: Date): { since: Date; label: string } {
  const nowLocal = toBerlinLocal(now);
  const local = markerSinceLocal(nowLocal);
  return { since: fromBerlinLocal(local), label: `seit ${local.slice(0, 10) === nowLocal.slice(0, 10) ? "heute" : "gestern"}, ${local.slice(11)} Uhr` };
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
  /** VT-01 (F-10-9): Vertretung nur als Betreuung */
  supervisionOnly?: boolean;
}

/** SP2-07: fällt die Stunde hier aus (Entfall, verlegt in eine andere Stunde)? */
export const changeOff = (e: Pick<ChangeEntry, "kind" | "movedTo">) => e.kind === "cancel" || (e.kind === "move" && e.movedTo !== null);

/**
 * SP2-07: Art mit Einzelheiten – „Verlegung aus der 3. Std.“, „verlegt in die 1. Std.“, „Zusammenlegung mit 7b“; VT-02: „Betreuung“
 * statt „Vertretung“, wenn die Vertretung nur betreut (F-10-9).
 */
export function changeLabel(e: Pick<ChangeEntry, "kind" | "movedFrom" | "movedTo" | "mergeWith" | "supervisionOnly">): string {
  if (e.kind === "move" && e.movedTo !== null) return `verlegt in die ${e.movedTo}. Std.`;
  if (e.kind === "move" && e.movedFrom !== null) return `Verlegung aus der ${e.movedFrom}. Std.`;
  if (e.kind === "merge") return e.mergeWith ? `Zusammenlegung mit ${e.mergeWith.groupName.replace(/^Klasse /, "")}` : "Zusammenlegung aufgehoben";
  if (e.kind === "substitute" && e.supervisionOnly) return "Betreuung";
  return CHANGE_KIND_LABEL[e.kind];
}

/** VT-02: Raum der Änderung einheitlich „alt → neu“ (Zusammenlegung: Raum der anderen Stunde); null, wenn die Stunde hier ausfällt. */
export function changeRoomShift(e: ChangeEntry): string | null {
  if (changeOff(e)) return null;
  return roomShift(e.roomId, changeRoom(e));
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

/**
 * `long`: ausgeschriebene Namen statt Kürzel (Tagesleiste). VT-02: Grund-Kategorie und „Betreuung“ aus der Änderung; ein anderer
 * Raum steht „alt → neu“.
 */
export function slotDisplay(s: LessonSlot, view: PlanView, long = false): SlotDisplay {
  const d = slotDisplayBase(s, view, long);
  const c = s.change;
  if (!c) return d;
  const tag = c.kind === "substitute" && c.supervisionOnly && (d.tag === "Vertretung" || d.tag === "Vertreten") ? (d.tag === "Vertreten" ? "Betreut" : "Betreuung") : d.tag;
  return { ...d, tag, reason: reasonLabel(c.reason) };
}

function slotDisplayBase(s: LessonSlot, view: PlanView, long: boolean): SlotDisplay {
  const teacher = long ? (s.teacherName ?? s.teacherCode) : (s.teacherCode ?? s.teacherName);
  const c = s.change;
  const substitute = c ? (long ? (c.substituteName ?? c.substituteCode) : (c.substituteCode ?? c.substituteName)) : null;
  const effRoom = c?.roomId ?? s.roomId;
  // VT-02: anderer Raum „R 106 → 105“ (eigener Raum ohne Änderung bleibt „R 106“)
  const shifted = c && c.kind !== "cancel" ? roomShift(s.roomId, c.roomId, "R ") : room(s.roomId);
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
      : { tone: "sub", tag: "Vertretung", detail: join(instead, s.groupName, shifted, teacher && `für ${s.teacherCode ?? teacher}`), note, struck: false };
  }
  if (c?.kind === "substitute") {
    const who = view === "teacher" || view === "room" ? s.groupName : substitute;
    return { tone: "sub", tag: "Vertretung", detail: join(instead, who, view === "room" ? room(effRoom) : shifted), note, struck: false };
  }
  if (c?.kind === "room") {
    return { tone: "sub", tag: "Raumänderung", detail: view === "teacher" ? join(s.groupName, shifted) : join(teacher, view === "room" ? room(effRoom) : shifted), note, struck: false };
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
