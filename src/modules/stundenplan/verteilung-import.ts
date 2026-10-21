// SP2-06 (Q-SP-14): CSV-Import der Unterrichtsverteilung – nur Lehraufträge (kein Plan, kein fremdes Austauschformat).
// Ablauf: Datei lesen (UTF-8 oder Windows-1252) → Plan mit Fehlern je Zeile (Vorschau) → Übernehmen nur ohne Fehler, alles in einer
// Transaktion. Zuordnung über Kürzel bzw. Namen; Bänder werden ergänzt, nie aufgelöst.
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { detectSeparator, splitCsvLine, toCsv } from "@/core/csv";
import { groups, rooms, subjects, timetableAssignmentGroups, timetableAssignments, timetableAssignmentTeachers, timetableBands, users } from "@/core/db/schema";
import { listAssignments, listBands, PLANNED_GROUP_KINDS } from "./verteilung";

/** höchstens 512 KB – eine große Schule hat wenige tausend Lehraufträge */
export const MAX_ASSIGNMENT_CSV_BYTES = 512 * 1024;
export const MAX_ASSIGNMENT_CSV_ROWS = 5000;

type Column = "group" | "subject" | "hours" | "teacher" | "doubles" | "room" | "band";

/** Spalten der Vorlage in dieser Reihenfolge (ohne Kopfzeile gilt sie auch für die Datei) */
export const ASSIGNMENT_CSV_HEADER = ["Klasse/Kurs", "Fach", "Stunden", "Lehrkraft", "Doppelstunden", "Raumwunsch", "Band"] as const;
const POSITIONAL: Column[] = ["group", "subject", "hours", "teacher", "doubles", "room", "band"];

const ALIASES: Record<string, Column> = {
  klassekurs: "group",
  klasse: "group",
  kurs: "group",
  gruppe: "group",
  lerngruppe: "group",
  fach: "subject",
  stunden: "hours",
  wochenstunden: "hours",
  lehrkraft: "teacher",
  lehrkraefte: "teacher",
  lehrkräfte: "teacher",
  lehrer: "teacher",
  doppelstunden: "doubles",
  raumwunsch: "room",
  raum: "room",
  band: "band",
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-zäöüß]/g, "");
const key = (s: string) => s.trim().toLocaleLowerCase("de");

export interface ParsedRow {
  line: number;
  group: string;
  subject: string;
  hours: string;
  teachers: string[];
  doubles: string;
  room: string;
  band: string;
}

/** Zerlegt die Datei; die Kopfzeile ist optional (ohne sie gilt die Reihenfolge der Vorlage). */
export function parseAssignmentCsv(text: string): { rows: ParsedRow[]; errors: string[] } {
  const sep = detectSeparator(text);
  const lines = text.split(/\r?\n/);
  const rows: ParsedRow[] = [];
  const errors: string[] = [];
  let columns: Column[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const cells = splitCsvLine(raw, sep);
    if (cells.every((c) => !c)) continue;
    if (!columns) {
      const mapped = cells.map((c) => ALIASES[norm(c)]);
      if (mapped.some(Boolean)) {
        const missing = (["group", "subject", "hours"] as const).filter((c) => !mapped.includes(c));
        if (missing.length) {
          const names = { group: "Klasse/Kurs", subject: "Fach", hours: "Stunden" };
          errors.push(`Kopfzeile: Spalte ${missing.map((m) => `„${names[m]}“`).join(", ")} fehlt`);
          return { rows: [], errors };
        }
        columns = mapped.map((c) => c ?? ("" as Column));
        continue;
      }
      columns = POSITIONAL;
    }
    const get = (c: Column) => {
      const idx = columns!.indexOf(c);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };
    if (rows.length >= MAX_ASSIGNMENT_CSV_ROWS) {
      errors.push(`höchstens ${MAX_ASSIGNMENT_CSV_ROWS} Zeilen je Datei`);
      break;
    }
    rows.push({
      line: i + 1,
      group: get("group"),
      subject: get("subject"),
      hours: get("hours"),
      teachers: get("teacher")
        .split(/[/+,]/)
        .map((t) => t.trim())
        .filter(Boolean),
      doubles: get("doubles"),
      room: get("room"),
      band: get("band").replace(/\s+/g, " "),
    });
  }
  if (!rows.length && !errors.length) errors.push("Keine Lehraufträge in der Datei");
  return { rows, errors };
}

export type ImportRowStatus = "neu" | "aendern" | "gleich" | "fehler";

/** Zeile der Vorschau (ohne interne Kennungen) */
export interface ImportRowView {
  line: number;
  group: string;
  subject: string;
  hours: string;
  teachers: string;
  doubles: string;
  room: string;
  band: string;
  status: ImportRowStatus;
  /** Fehler (status „fehler“) bzw. Änderungen (status „aendern“) */
  notes: string[];
}

export interface ImportPreview {
  rows: ImportRowView[];
  /** Fehler, die keiner Zeile gehören (Kopfzeile, leere Datei) */
  fileErrors: string[];
  /** Bänder, die neu angelegt werden */
  newBands: string[];
  counts: Record<ImportRowStatus, number>;
  /** Übernehmen möglich: keine Fehler und etwas zu tun */
  ok: boolean;
}

interface Resolved {
  groupId: string;
  subjectId: string;
  hours: number;
  /** null = Spalte leer (neu: 0, vorhanden: bleibt) */
  doubles: number | null;
  teacherIds: string[];
  /** undefined = Spalte leer (neu: kein Wunsch, vorhanden: bleibt) */
  roomId: string | undefined;
  /** vorhandenes Band (id) bzw. neues (Name) */
  band: { id: string } | { name: string } | null;
  /** passender vorhandener Lehrauftrag */
  existingId: string | null;
}

interface Planned extends ImportRowView {
  resolved?: Resolved;
}

export interface ImportPlan {
  preview: ImportPreview;
  ops: Resolved[];
  newBands: { name: string; hours: number; doubleLessons: number }[];
}

/** Lookup-Tabelle mit „mehrdeutig“-Markierung */
function index<T>(entries: [string, T][]): Map<string, T | "mehrdeutig"> {
  const m = new Map<string, T | "mehrdeutig">();
  for (const [k, v] of entries) {
    if (!k) continue;
    const prev = m.get(k);
    m.set(k, prev !== undefined && prev !== v ? "mehrdeutig" : v);
  }
  return m;
}

/**
 * Prüft die Datei gegen die Stammdaten und die vorhandene Verteilung des Schuljahrs. Ein vorhandener Lehrauftrag passt, wenn Gruppe
 * und Fach gleich sind und eine Lehrkraft übereinstimmt (bzw. beide ohne Lehrkraft) – dieselbe Regel wie beim Anlegen von Hand.
 */
export async function planAssignmentImport(db: Db, year: { id: string }, text: string): Promise<ImportPlan> {
  const { rows, errors: fileErrors } = parseAssignmentCsv(text);
  const [groupRows, subjectRows, teacherRows, roomRows, existing, bands] = await Promise.all([
    db
      .select({ id: groups.id, name: groups.name, slug: groups.slug })
      .from(groups)
      .where(and(inArray(groups.kind, [...PLANNED_GROUP_KINDS]), isNull(groups.archivedAt), or(eq(groups.schoolYearId, year.id), isNull(groups.schoolYearId)))),
    db.select({ id: subjects.id, name: subjects.name }).from(subjects),
    db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(and(eq(users.role, "lehrkraft"), eq(users.status, "active"))),
    db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(eq(rooms.active, true)),
    listAssignments(db, year.id),
    listBands(db, year.id),
  ]);
  const groupBy = index([...groupRows.map((g): [string, string] => [key(g.name), g.id]), ...groupRows.map((g): [string, string] => [key(g.slug), g.id])]);
  const subjectBy = index([...subjectRows.map((s): [string, string] => [key(s.id), s.id]), ...subjectRows.map((s): [string, string] => [key(s.name), s.id])]);
  const teacherBy = index([...teacherRows.map((t): [string, string] => [key(t.code ?? ""), t.id]), ...teacherRows.map((t): [string, string] => [key(t.name), t.id])]);
  const roomBy = index([...roomRows.map((r): [string, string] => [key(r.id), r.id]), ...roomRows.map((r): [string, string] => [key(r.name), r.id])]);
  const bandBy = new Map(bands.map((b) => [key(b.name), b]));
  const bandName = new Map(bands.map((b) => [b.id, b.name]));
  const teacherCode = new Map(teacherRows.map((t) => [t.id, t.code ?? t.name]));
  const newBands = new Map<string, { name: string; hours: number; doubleLessons: number; line: number }>();
  /** vorhandene Lehraufträge, die schon eine Zeile beansprucht */
  const claimed = new Map<string, number>();
  const seen: { line: number; groupId: string; subjectId: string; teacherIds: string[] }[] = [];

  const planned: Planned[] = rows.map((r) => {
    const errors: string[] = [];
    const view: Planned = {
      line: r.line,
      group: r.group,
      subject: r.subject,
      hours: r.hours,
      teachers: r.teachers.join("/"),
      doubles: r.doubles,
      room: r.room,
      band: r.band,
      status: "fehler",
      notes: errors,
    };
    const look = (m: Map<string, string | "mehrdeutig">, raw: string, what: string, missing: string): string | null => {
      if (!raw) {
        errors.push(missing);
        return null;
      }
      const hit = m.get(key(raw));
      if (hit === "mehrdeutig") errors.push(`${what} „${raw}“ ist mehrdeutig`);
      else if (!hit) errors.push(`${what} „${raw}“ gibt es nicht`);
      return hit && hit !== "mehrdeutig" ? hit : null;
    };
    const groupId = look(groupBy, r.group, "Klasse/Kurs", "Klasse oder Kurs fehlt");
    const subjectId = look(subjectBy, r.subject, "Fach", "Fach fehlt");
    const teacherIds: string[] = [];
    for (const t of r.teachers) {
      const id = look(teacherBy, t, "Lehrkraft", "");
      if (id && !teacherIds.includes(id)) teacherIds.push(id);
    }
    if (r.teachers.length > 2) errors.push("höchstens zwei Lehrkräfte (Teamteaching) – weitere Gruppen über ein Band");
    const roomId = r.room ? look(roomBy, r.room, "Raum", "") : undefined;
    const hours = /^\d+$/.test(r.hours) ? Number(r.hours) : NaN;
    if (!r.hours) errors.push("Stunden fehlen");
    else if (!(hours >= 1 && hours <= 12)) errors.push("Stunden: 1 bis 12 Wochenstunden");
    const doubles = r.doubles ? (/^\d+$/.test(r.doubles) ? Number(r.doubles) : NaN) : null;
    if (doubles !== null && (Number.isNaN(doubles) || (hours >= 1 && doubles * 2 > hours)))
      errors.push(`Doppelstunden: höchstens ${hours >= 1 ? Math.floor(hours / 2) : "die Hälfte der Stunden"}`);
    if (r.band.length > 60) errors.push("Band: höchstens 60 Zeichen");
    if (errors.length || !groupId || !subjectId) return view;

    // doppelt in der Datei?
    const twin = seen.find((s) => s.groupId === groupId && s.subjectId === subjectId && (s.teacherIds.length === 0 && teacherIds.length === 0 ? true : s.teacherIds.some((t) => teacherIds.includes(t))));
    if (twin) {
      errors.push(`steht schon in Zeile ${twin.line}`);
      return view;
    }
    seen.push({ line: r.line, groupId, subjectId, teacherIds });

    const match = existing.find(
      (a) =>
        a.subjectId === subjectId &&
        a.groups.some((g) => g.id === groupId) &&
        (a.teachers.length === 0 && teacherIds.length === 0 ? true : a.teachers.some((t) => teacherIds.includes(t.id))),
    );
    if (match && claimed.has(match.id)) {
      errors.push(`betrifft denselben Lehrauftrag wie Zeile ${claimed.get(match.id)}`);
      return view;
    }
    if (match) claimed.set(match.id, r.line);

    // Band: vorhandenes, neues oder das bisherige des Lehrauftrags (wird nie aufgelöst)
    let band: Resolved["band"] = null;
    const effectiveBand = r.band ? bandBy.get(key(r.band)) : match?.bandId ? bands.find((b) => b.id === match.bandId) : undefined;
    if (match?.bandId && r.band && effectiveBand?.id !== match.bandId) {
      errors.push(`steht im Band „${bandName.get(match.bandId)}“ – dort herausnehmen oder dieses Band angeben`);
      return view;
    }
    if (effectiveBand) {
      band = { id: effectiveBand.id };
      if (hours !== effectiveBand.hours) errors.push(`Band „${effectiveBand.name}“ hat ${effectiveBand.hours} Wochenstunden – Stunden am Band ändern`);
      if (doubles !== null && doubles !== effectiveBand.doubleLessons) errors.push(`Band „${effectiveBand.name}“ hat ${effectiveBand.doubleLessons} Doppelstunden`);
    } else if (r.band) {
      const nb = newBands.get(key(r.band));
      if (!nb) newBands.set(key(r.band), { name: r.band, hours, doubleLessons: doubles ?? 0, line: r.line });
      else {
        if (nb.hours !== hours) errors.push(`neues Band „${nb.name}“ hat in Zeile ${nb.line} ${nb.hours} Wochenstunden`);
        if (doubles !== null && doubles !== nb.doubleLessons) errors.push(`neues Band „${nb.name}“ hat in Zeile ${nb.line} ${nb.doubleLessons} Doppelstunden`);
      }
      band = { name: nb?.name ?? r.band };
    }
    if (errors.length) return view;

    const resolved: Resolved = { groupId, subjectId, hours, doubles, teacherIds, roomId: roomId ?? undefined, band, existingId: match?.id ?? null };
    view.resolved = resolved;
    if (!match) {
      view.status = "neu";
      if (band && "name" in band) errors.push(`neues Band „${band.name}“`);
      else if (band) errors.push(`im Band „${bandName.get(band.id)}“`);
      return view;
    }
    const changes = errors;
    if (!match.bandId && hours !== match.hours) changes.push(`Stunden ${match.hours} → ${hours}`);
    if (doubles !== null && !band && doubles !== match.doubleLessons) changes.push(`Doppelstunden ${match.doubleLessons} → ${doubles}`);
    if (roomId !== undefined && roomId !== match.roomId) changes.push(`Raumwunsch ${match.roomId ?? "–"} → ${roomId}`);
    const before = match.teachers.map((t) => t.id).sort();
    if (before.join() !== [...teacherIds].sort().join())
      changes.push(`Lehrkräfte ${match.teachers.map((t) => t.code ?? t.name).join("/") || "–"} → ${teacherIds.map((t) => teacherCode.get(t)).join("/") || "–"}`);
    if (band && !match.bandId) changes.push("name" in band ? `in neues Band „${band.name}“` : `ins Band „${bandName.get(band.id)}“`);
    view.status = changes.length ? "aendern" : "gleich";
    return view;
  });

  const counts: Record<ImportRowStatus, number> = { neu: 0, aendern: 0, gleich: 0, fehler: 0 };
  for (const p of planned) counts[p.status]++;
  const ok = !fileErrors.length && counts.fehler === 0 && counts.neu + counts.aendern > 0;
  return {
    preview: {
      rows: planned.map((p) => {
        const v: Planned = { ...p };
        delete v.resolved;
        return v;
      }),
      fileErrors,
      newBands: [...newBands.values()].map((b) => b.name),
      counts,
      ok,
    },
    ops: planned.filter((p) => p.resolved && (p.status === "neu" || p.status === "aendern")).map((p) => p.resolved!),
    newBands: [...newBands.values()].map(({ name, hours, doubleLessons }) => ({ name, hours, doubleLessons })),
  };
}

export interface ImportOutcome {
  created: number;
  updated: number;
  bands: number;
}

/** Übernimmt einen fehlerfreien Plan – ganz oder gar nicht. */
export async function executeAssignmentImport(db: Db, actorId: string, year: { id: string }, plan: ImportPlan): Promise<ImportOutcome> {
  if (!plan.preview.ok) throw new Error("Import hat Fehler – nichts übernommen");
  const outcome = await db.transaction(async (tx) => {
    const bandIds = new Map<string, { id: string; hours: number; doubleLessons: number }>();
    for (const b of plan.newBands) {
      const [row] = await tx.insert(timetableBands).values({ schoolYearId: year.id, name: b.name, hours: b.hours, doubleLessons: b.doubleLessons }).returning({ id: timetableBands.id });
      bandIds.set(key(b.name), { id: row!.id, ...b });
    }
    const known = new Map((await tx.select().from(timetableBands).where(eq(timetableBands.schoolYearId, year.id))).map((b) => [b.id, b]));
    let created = 0;
    let updated = 0;
    for (const op of plan.ops) {
      const band = op.band ? ("id" in op.band ? known.get(op.band.id) : bandIds.get(key(op.band.name))) : null;
      if (op.band && !band) throw new Error("Band gibt es nicht mehr – Vorschau neu laden");
      if (op.existingId) {
        const set: Partial<typeof timetableAssignments.$inferInsert> = {};
        if (band) Object.assign(set, { bandId: band.id, hours: band.hours, doubleLessons: band.doubleLessons });
        else {
          set.hours = op.hours;
          if (op.doubles !== null) set.doubleLessons = op.doubles;
        }
        if (op.roomId !== undefined) set.roomId = op.roomId;
        const [cur] = await tx.select({ d: timetableAssignments.doubleLessons }).from(timetableAssignments).where(eq(timetableAssignments.id, op.existingId));
        if (!cur) throw new Error("Lehrauftrag gibt es nicht mehr – Vorschau neu laden");
        // Stunden gesenkt, Doppelstunden aus der Datei leer: bisherige Doppelstunden kappen (Prüfregel der Tabelle)
        if (set.hours !== undefined && set.doubleLessons === undefined && cur.d * 2 > set.hours) set.doubleLessons = Math.floor(set.hours / 2);
        await tx.update(timetableAssignments).set(set).where(eq(timetableAssignments.id, op.existingId));
        await tx.delete(timetableAssignmentTeachers).where(eq(timetableAssignmentTeachers.assignmentId, op.existingId));
        if (op.teacherIds.length) await tx.insert(timetableAssignmentTeachers).values(op.teacherIds.map((teacherId) => ({ assignmentId: op.existingId!, teacherId })));
        updated++;
      } else {
        const [row] = await tx
          .insert(timetableAssignments)
          .values({
            schoolYearId: year.id,
            subjectId: op.subjectId,
            hours: band?.hours ?? op.hours,
            doubleLessons: band?.doubleLessons ?? op.doubles ?? 0,
            roomId: op.roomId ?? null,
            bandId: band?.id ?? null,
          })
          .returning({ id: timetableAssignments.id });
        await tx.insert(timetableAssignmentGroups).values({ assignmentId: row!.id, groupId: op.groupId });
        if (op.teacherIds.length) await tx.insert(timetableAssignmentTeachers).values(op.teacherIds.map((teacherId) => ({ assignmentId: row!.id, teacherId })));
        created++;
      }
    }
    return { created, updated, bands: plan.newBands.length };
  });
  await audit(db, actorId, "stundenplan.assignment.csv_import", null, { ...outcome });
  return outcome;
}

/** Vorlage zum Herunterladen: Kopfzeile und Beispielzeilen mit Kürzeln der Schule (ohne Personennamen). */
export async function assignmentCsvTemplate(db: Db): Promise<string> {
  const [g] = await db
    .select({ name: groups.name })
    .from(groups)
    .where(and(eq(groups.kind, "klasse"), isNull(groups.archivedAt)))
    .orderBy(asc(groups.gradeLevel), asc(groups.name))
    .limit(1);
  const ss = await db.select({ id: subjects.id }).from(subjects).orderBy(asc(subjects.sortOrder), asc(subjects.id)).limit(2);
  const ts = await db
    .select({ code: users.shortCode })
    .from(users)
    .where(and(eq(users.role, "lehrkraft"), eq(users.status, "active")))
    .orderBy(asc(users.shortCode))
    .limit(2);
  const cls = g?.name ?? "5a";
  const s1 = ss[0]?.id ?? "D";
  const s2 = ss[1]?.id ?? "M";
  const t1 = ts[0]?.code ?? "ABC";
  const t2 = ts[1]?.code ?? "DEF";
  // Zeile 1: mit Doppelstunde · Zeile 2: Teamteaching, im (neuen) Band
  return toCsv([[...ASSIGNMENT_CSV_HEADER], [cls, s1, 4, t1, 1, "", ""], [cls, s2, 2, `${t1}/${t2}`, "", "", `Beispielband ${cls}`]]);
}
