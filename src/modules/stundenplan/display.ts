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
    const key = [s.couplingId, s.date, s.periodNr, s.teacherId, s.roomId, s.subjectId, c?.kind, c?.substituteId, c?.roomId, s.perspective].join("|");
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
