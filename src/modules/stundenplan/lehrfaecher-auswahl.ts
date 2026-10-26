// SP2-12: Lehrervorschläge passend zum Fach – rein, ohne DB (auch im Browser: Auswahlfeld der Zuweisung).

export interface PickTeacher {
  id: string;
  code: string | null;
  name: string;
  /** Lehrfächer; leer = keine gepflegt */
  subjectIds: string[];
  /** Restdeputat: Soll − Wochenstunden in Lehraufträgen (negativ = Überhang) */
  rest: number;
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

const byRestThenName = (a: PickTeacher, b: PickTeacher) => b.rest - a.rest || a.name.localeCompare(b.name, "de") || a.id.localeCompare(b.id);

/** Rein: Lehrkräfte für die Zuweisung eines Fachs ordnen. Ohne Fach (noch nicht gewählt) stehen alle in `matching`. */
export function rankTeachers(list: readonly PickTeacher[], subjectId: string | null): RankedTeachers {
  const sorted = [...list].sort(byRestThenName);
  if (!subjectId) return { matching: sorted, unmaintained: [], others: [] };
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
