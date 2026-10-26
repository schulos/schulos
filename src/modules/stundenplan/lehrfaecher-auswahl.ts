// SP2-12: Lehrervorschläge passend zum Fach – rein, ohne DB (auch im Browser: Auswahlfeld der Zuweisung).

export interface PickTeacher {
  id: string;
  code: string | null;
  name: string;
  /** Lehrfächer; leer = keine gepflegt */
  subjectIds: string[];
  /** Restdeputat: Soll − Wochenstunden in Lehraufträgen (negativ = Überhang); `null` = kein Deputat bekannt (Stundenplanmodul aus) */
  rest: number | null;
  /** R2-P2: Konto nicht aktiv (gesperrt/ausgeschieden) – nicht vorschlagen, nur als schon gewählter Wert zeigen */
  inactive?: boolean;
}

/**
 * R2-P7: Greift der Fachfilter? Nur wenn für die (aktiven) Lehrkräfte überhaupt Lehrfächer gepflegt sind. Die Liste kommt ohne
 * Lehrfächer, wenn das Stundenplanmodul aus ist (`loadPickList`) – dann ebenfalls kein Filter: alle normal wählbar, kein Hinweis.
 */
export function subjectFilterOn(list: readonly Pick<PickTeacher, "subjectIds" | "inactive">[]): boolean {
  return list.some((t) => !t.inactive && t.subjectIds.length > 0);
}

/** R2-P2: wählbare Lehrkräfte – aktive, dazu eine schon gewählte nicht aktive (sonst ginge sie beim Bearbeiten still verloren). */
export function selectableTeachers<T extends Pick<PickTeacher, "id" | "inactive">>(list: readonly T[], currentId: string): T[] {
  return list.filter((t) => !t.inactive || t.id === currentId);
}

/** R2-P3: Name des Häkchens „Trotzdem zuweisen“ je Lehrkraft-Feld; der Wert ist die bestätigte Lehrkraft. */
export const offSubjectKey = (field: string) => `offSubjectOk:${field}`;

/** R2-P3: Ist die fachfremde Lehrkraft in genau diesem Feld bestätigt? (Ein Häkchen gilt nie für andere Felder.) */
export function offSubjectConfirmed(form: { get(name: string): unknown }, field: string, teacherId: string | null | undefined): boolean {
  return !!teacherId && form.get(offSubjectKey(field)) === teacherId;
}

/** Passt die Lehrkraft zum Fach? `unmaintained` = keine Lehrfächer gepflegt (Hinweis, keine Sperre). */
export type SubjectFit = "fits" | "unmaintained" | "off";

export function subjectFit(subjectIds: readonly string[] | undefined, subjectId: string): SubjectFit {
  if (!subjectIds?.length) return "unmaintained";
  return subjectIds.includes(subjectId) ? "fits" : "off";
}

export interface RankedTeachers {
  /** unterrichten das Fach (ohne Fach: alle) – Restdeputat absteigend, dann Name */
  matching: PickTeacher[];
  /** ohne gepflegte Lehrfächer – nur über „alle anzeigen“, mit Hinweis */
  unmaintained: PickTeacher[];
  /** unterrichten das Fach laut Stammdaten nicht – nur über „alle anzeigen“, mit Warnhinweis */
  others: PickTeacher[];
}

const byRestThenName = (a: PickTeacher, b: PickTeacher) => (b.rest ?? 0) - (a.rest ?? 0) || a.name.localeCompare(b.name, "de") || a.id.localeCompare(b.id);

/**
 * Rein: Lehrkräfte für die Zuweisung eines Fachs ordnen. Ohne Fach (noch nicht gewählt) oder ohne Fachfilter (R2-P7, keine Lehrfächer
 * gepflegt) stehen alle in `matching`.
 */
export function rankTeachers(list: readonly PickTeacher[], subjectId: string | null): RankedTeachers {
  const sorted = [...list].sort(byRestThenName);
  if (!subjectId || !subjectFilterOn(list)) return { matching: sorted, unmaintained: [], others: [] };
  const out: RankedTeachers = { matching: [], unmaintained: [], others: [] };
  for (const t of sorted) {
    const fit = subjectFit(t.subjectIds, subjectId);
    (fit === "fits" ? out.matching : fit === "unmaintained" ? out.unmaintained : out.others).push(t);
  }
  return out;
}

/** Rein: welche der gewählten Lehrkräfte passen nicht zum Fach (fachfremd bzw. ohne gepflegte Lehrfächer)? */
export function subjectMismatch(map: ReadonlyMap<string, readonly string[]>, subjectId: string, teacherIds: readonly string[]): { off: string[]; unmaintained: string[] } {
  const off: string[] = [];
  const unmaintained: string[] = [];
  for (const id of new Set(teacherIds)) {
    const fit = subjectFit(map.get(id), subjectId);
    if (fit === "off") off.push(id);
    else if (fit === "unmaintained") unmaintained.push(id);
  }
  return { off, unmaintained };
}

/** Warnhinweis für fachfremde Lehrkräfte: „LIN unterrichtet Physik laut Stammdaten nicht“ */
export function offSubjectText(codes: readonly string[], subjectName: string): string {
  return `${codes.join(", ")} ${codes.length === 1 ? "unterrichtet" : "unterrichten"} ${subjectName} laut Stammdaten nicht`;
}
