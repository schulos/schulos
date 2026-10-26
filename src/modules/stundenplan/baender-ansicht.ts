// Review R3 N4: Band-Ansicht der Unterrichtsverteilung **zeitraumunabhängig**. Die Verteilung am Stichtag kennt nur die dann
// gültigen Lehraufträge – ein Band mit Mitgliedern nur im 2. Halbjahr sah im 1. Halbjahr „leer“ aus und ließ sich löschen, wobei
// die Mitglieder still ihr Band verloren. Hier: alle Mitglieder mit Gültigkeit (am Stichtag gültige zuerst), „frei“ über alle
// Zeiträume.
import { activeOn, type Assignment } from "./verteilung";

type Validity = Pick<Assignment, "validFrom" | "validUntil">;

/** Mitglieder eines Bands über alle Zeiträume; `active` = gilt am Stichtag. */
export function bandMembers<A extends Pick<Assignment, "id" | "bandId"> & Validity>(bandId: string, all: readonly A[], refYmd: string): { assignment: A; active: boolean }[] {
  const members = all.filter((a) => a.bandId === bandId).map((assignment) => ({ assignment, active: activeOn(assignment, refYmd) }));
  return [...members.filter((m) => m.active), ...members.filter((m) => !m.active)];
}

/** Lehraufträge ohne Band – auch die aus anderen Zeiträumen. */
export function freeAssignments<A extends Pick<Assignment, "bandId">>(all: readonly A[]): A[] {
  return all.filter((a) => !a.bandId);
}

const de = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

/** „ab 01.02.2027“, „bis 31.01.2027“, „01.08.2026 – 31.01.2027“ bzw. null (ganzes Schuljahr). */
export function validityLabel(a: Validity): string | null {
  if (a.validFrom && a.validUntil) return `${de(a.validFrom)} – ${de(a.validUntil)}`;
  if (a.validFrom) return `ab ${de(a.validFrom)}`;
  if (a.validUntil) return `bis ${de(a.validUntil)}`;
  return null;
}
