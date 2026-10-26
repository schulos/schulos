// SP2-10: Drucke und CSV-Exporte der Stundenplanung. Jeder Export ist eine Tabelle (Kopf + Zeilen); Druckseite
// (`/druck/stundenplan/uebersicht`) und CSV-Route (`/api/stundenplan/export/[art]`) zeigen dieselbe Tabelle.
import { eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { groups } from "@/core/db/schema";
import { hasPermission, type PermissionSet } from "@/core/permissions";
import { readSchoolSettings } from "@/core/settings";
import { defaultObligation, deputyAccounts, REDUCTION_LABELS } from "./deputate";
import { dutyPlan, listAreas, schoolBreaks } from "./aufsichten";
import { PLAN_MANAGE, PLAN_SUBSTITUTE } from "./rechte";
import { allRegularSlots, seesAllPlans, type LessonSlot } from "./service";
import { distribution, planningYear } from "./verteilung";
import { substitutionStats } from "./vorschlaege";

export const WEEKDAY_SHORT = ["Mo", "Di", "Mi", "Do", "Fr"] as const;

export const EXPORT_ARTS = ["gesamt-klassen", "gesamt-lehrkraefte", "verteilung", "deputate", "aufsichten", "statistik-lehrkraefte", "statistik-klassen"] as const;
export type ExportArt = (typeof EXPORT_ARTS)[number];

export function isExportArt(x: string): x is ExportArt {
  return (EXPORT_ARTS as readonly string[]).includes(x);
}

export interface ExportTable {
  art: ExportArt;
  title: string;
  subtitle: string;
  /** Dateiname ohne Endung und Datum */
  filename: string;
  head: string[];
  rows: string[][];
  /** Spalten, die in der Druckansicht schmal und mittig stehen (Rasterzellen, Zahlen) */
  numeric?: boolean;
}

/**
 * Rechte-Matrix (Q-SP2-Plan): Gesamtübersichten = alle Pläne sehen (`seesAllPlans`); Verteilung, Deputate und Aufsichtsplan
 * (personenbezogen, Jahresplanung) = `stundenplan.manage`; Vertretungsstatistik = `manage` oder `substitute`.
 */
export function canExport(art: ExportArt, perms: PermissionSet): boolean {
  switch (art) {
    case "gesamt-klassen":
    case "gesamt-lehrkraefte":
      return seesAllPlans(perms);
    case "verteilung":
    case "deputate":
    case "aufsichten":
      return hasPermission(perms, PLAN_MANAGE);
    case "statistik-lehrkraefte":
    case "statistik-klassen":
      return hasPermission(perms, PLAN_MANAGE) || hasPermission(perms, PLAN_SUBSTITUTE);
  }
}

export const EXPORT_LABELS: Record<ExportArt, string> = {
  "gesamt-klassen": "Gesamtübersicht Klassen",
  "gesamt-lehrkraefte": "Gesamtübersicht Lehrkräfte",
  verteilung: "Unterrichtsverteilung",
  deputate: "Deputate",
  aufsichten: "Aufsichtsplan",
  "statistik-lehrkraefte": "Vertretungsstatistik Lehrkräfte",
  "statistik-klassen": "Vertretungsstatistik Klassen und Kurse",
};

const de = (a: string, b: string) => a.localeCompare(b, "de", { numeric: true });
const fmtNum = (x: number) => String(Math.round(x * 10) / 10).replace(".", ",");
const ymdDe = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

/** Kopf der Rasterübersicht: „Mo 1“ … „Fr n“ */
export function gridHead(lastPeriod: number): string[] {
  return WEEKDAY_SHORT.flatMap((d) => Array.from({ length: lastPeriod }, (_, i) => `${d} ${i + 1}`));
}

export interface GridRow {
  key: string;
  label: string;
  slots: LessonSlot[];
}

/**
 * Rein: Raster Zeilen × (Wochentag, Stunde). Mehrere Stunden in einer Zelle (A-/B-Woche, Kurse) stehen mit „ / “ getrennt;
 * `cellText` liefert den Text einer Stunde. Gleiche Texte in einer Zelle erscheinen einmal (Kopplungen).
 */
export function gridRows(rows: GridRow[], lastPeriod: number, cellText: (s: LessonSlot) => string): string[][] {
  return rows.map((r) => {
    const cells = Array.from({ length: 5 * lastPeriod }, () => [] as string[]);
    for (const s of r.slots) {
      if (s.weekday < 0 || s.weekday > 4 || s.periodNr < 1 || s.periodNr > lastPeriod) continue;
      const text = cellText(s) + (s.week === "all" ? "" : ` (${s.week})`);
      const cell = cells[s.weekday * lastPeriod + s.periodNr - 1]!;
      if (!cell.includes(text)) cell.push(text);
    }
    return [r.label, ...cells.map((c) => c.join(" / "))];
  });
}

function lastPeriodOf(slots: LessonSlot[]): number {
  return Math.max(6, ...slots.map((s) => s.periodNr));
}

async function gesamt(db: Db, art: "gesamt-klassen" | "gesamt-lehrkraefte", today: string): Promise<ExportTable> {
  const slots = await allRegularSlots(db, today);
  const last = lastPeriodOf(slots);
  const byClass = art === "gesamt-klassen";
  let rows: GridRow[];
  if (byClass) {
    const klassen = await db.select({ id: groups.id, name: groups.name, level: groups.gradeLevel }).from(groups).where(eq(groups.kind, "klasse"));
    rows = klassen
      .sort((a, b) => (a.level ?? 99) - (b.level ?? 99) || de(a.name, b.name))
      .map((g) => ({ key: g.id, label: g.name, slots: slots.filter((s) => s.groupId === g.id) }))
      .filter((r) => r.slots.length > 0);
  } else {
    const byTeacher = new Map<string, GridRow>();
    for (const s of slots) {
      if (!s.teacherId) continue;
      const row = byTeacher.get(s.teacherId) ?? { key: s.teacherId, label: s.teacherCode ?? s.teacherName ?? "?", slots: [] };
      row.slots.push(s);
      byTeacher.set(s.teacherId, row);
    }
    rows = [...byTeacher.values()].sort((a, b) => de(a.label, b.label));
  }
  // Fächer als Kurzzeichen (Fach-ID), damit das Raster auf A4 quer passt. Klassensicht: Fach (Lehrkraft); Lehrkraftsicht: Fach, Klasse(n) – Kopplungen/Bänder derselben Stunde einmal
  let table: string[][];
  if (byClass) {
    table = gridRows(rows, last, (s) => `${s.subjectId}${s.teacherCode ? ` ${s.teacherCode}` : ""}`);
  } else {
    const merged = rows.map((r) => ({ ...r, slots: mergeByCoupling(r.slots) }));
    table = gridRows(merged, last, (s) => `${s.subjectId} ${s.groupName.replace(/^Klasse /, "")}`);
  }
  return {
    art,
    title: EXPORT_LABELS[art],
    subtitle: `Regelplan · Stand ${ymdDe(today)}`,
    filename: byClass ? "gesamtuebersicht-klassen" : "gesamtuebersicht-lehrkraefte",
    head: [byClass ? "Klasse" : "Lehrkraft", ...gridHead(last)],
    rows: table,
    numeric: true,
  };
}

/** Rein: gekoppelte Stunden (gleiche Kopplung, Slot, Fach, Lehrkraft) einer Lehrkraft zu einer zusammenfassen – Klassennamen aneinander. */
export function mergeByCoupling(slots: LessonSlot[]): LessonSlot[] {
  const out: LessonSlot[] = [];
  const seen = new Map<string, LessonSlot>();
  for (const s of slots) {
    if (!s.couplingId) {
      out.push(s);
      continue;
    }
    const key = [s.couplingId, s.weekday, s.periodNr, s.week, s.subjectId].join("|");
    const hit = seen.get(key);
    if (!hit) {
      const first = { ...s };
      seen.set(key, first);
      out.push(first);
    } else if (!hit.groupName.split(", ").includes(s.groupName)) {
      hit.groupName = `${hit.groupName}, ${s.groupName}`;
    }
  }
  return out;
}

async function verteilung(db: Db, today: string): Promise<ExportTable> {
  const year = await planningYear(db);
  const empty: ExportTable = {
    art: "verteilung",
    title: EXPORT_LABELS.verteilung,
    subtitle: "Kein Schuljahr angelegt",
    filename: "unterrichtsverteilung",
    // dieselben Spalten wie der CSV-Import der Unterrichtsverteilung (SP2-06) – die Datei lässt sich wieder einlesen
    head: ["Klasse/Kurs", "Fach", "Stunden", "Lehrkraft", "Doppelstunden", "Raumwunsch", "Band"],
    rows: [],
    numeric: false,
  };
  if (!year) return empty;
  const d = await distribution(db, year, today);
  const bandName = new Map(d.bands.map((b) => [b.id, b.name]));
  const rows = d.assignments
    .map((a) => [
      a.groups.map((g) => g.name).join(", "),
      a.subjectName,
      fmtNum(a.hours),
      a.teachers.map((t) => t.code ?? t.name).join("/"),
      a.doubleLessons ? String(a.doubleLessons) : "",
      a.roomId ?? "",
      a.bandId ? (bandName.get(a.bandId) ?? "") : "",
    ])
    .sort((a, b) => de(a[0]!, b[0]!) || de(a[1]!, b[1]!));
  return { ...empty, subtitle: `Schuljahr ${year.name} · Stand ${ymdDe(d.refYmd)}`, rows };
}

async function deputate(db: Db, today: string): Promise<ExportTable> {
  const year = await planningYear(db);
  const head = ["Kürzel", "Name", "Pflichtstunden", "Ermäßigungen/Anrechnungen", "Soll", "Lehraufträge", "verplant", "Saldo", "max. Std./Tag", "max. Anwesenheitstage"];
  if (!year) return { art: "deputate", title: EXPORT_LABELS.deputate, subtitle: "Kein Schuljahr angelegt", filename: "deputate", head, rows: [] };
  const [d, school] = await Promise.all([distribution(db, year, today), readSchoolSettings(db)]);
  const accounts = await deputyAccounts(db, year.id, d.teachers, defaultObligation(school.profile.form));
  const rows = accounts
    .map((a) => [
      a.code ?? "",
      a.name,
      fmtNum(a.obligation),
      a.reductions.map((r) => `${REDUCTION_LABELS[r.reason]} ${fmtNum(r.hours)}`).join("; "),
      fmtNum(a.target),
      fmtNum(a.assigned),
      fmtNum(a.planned),
      fmtNum(a.balance),
      a.dayRule?.maxPerDay != null ? String(a.dayRule.maxPerDay) : "",
      a.dayRule?.maxDays != null ? String(a.dayRule.maxDays) : "",
    ])
    .sort((a, b) => de(a[0]!, b[0]!) || de(a[1]!, b[1]!));
  return { art: "deputate", title: EXPORT_LABELS.deputate, subtitle: `Schuljahr ${year.name} · Stand ${ymdDe(d.refYmd)}`, filename: "deputate", head, rows };
}

async function aufsichten(db: Db): Promise<ExportTable> {
  const [year, areas, breaks, plan] = await Promise.all([planningYear(db), listAreas(db), schoolBreaks(db), dutyPlan(db)]);
  const rows: string[][] = [];
  for (const a of areas) {
    for (const b of breaks) {
      rows.push([
        a.name,
        `${b.label} (${b.startsAt}–${b.endsAt})`,
        ...WEEKDAY_SHORT.map((_, wd) =>
          plan
            .filter((p) => p.areaId === a.id && p.weekday === wd && p.afterPeriod === b.afterPeriod)
            .map((p) => p.teacherCode ?? "?")
            .join(", "),
        ),
      ]);
    }
  }
  return {
    art: "aufsichten",
    title: EXPORT_LABELS.aufsichten,
    subtitle: year ? `Schuljahr ${year.name}` : "Kein Schuljahr angelegt",
    filename: "aufsichtsplan",
    head: ["Bereich", "Pause", ...WEEKDAY_SHORT],
    rows,
    numeric: false,
  };
}

export interface StatistikZeitraum {
  from: string;
  to: string;
}

/** Zeitraum der Statistik: ganzes Schuljahr oder laufender Monat (wie die Seite Vertretungsstatistik). */
export async function statistikZeitraum(db: Db, today: string, monat: boolean): Promise<StatistikZeitraum & { yearName: string | null }> {
  const year = await planningYear(db);
  return {
    from: monat ? `${today.slice(0, 8)}01` : (year?.startsOn ?? `${today.slice(0, 4)}-01-01`),
    to: monat ? today : (year?.endsOn ?? today),
    yearName: year?.name ?? null,
  };
}

async function statistik(db: Db, art: "statistik-lehrkraefte" | "statistik-klassen", today: string, monat: boolean): Promise<ExportTable> {
  const z = await statistikZeitraum(db, today, monat);
  const stats = await substitutionStats(db, z.from, z.to);
  const subtitle = `${monat ? "Dieser Monat" : `Schuljahr ${z.yearName ?? ""}`.trim()} · ${ymdDe(z.from)} – ${ymdDe(z.to)}`;
  if (art === "statistik-lehrkraefte") {
    return {
      art,
      title: EXPORT_LABELS[art],
      subtitle,
      filename: "vertretungsstatistik-lehrkraefte",
      head: ["Kürzel", "Name", "vertreten", "davon mit eigenem Fach", "abgegeben", "Entfall"],
      rows: stats.teachers.map((t) => [t.code ?? "", t.name, String(t.substitutions), String(t.ownSubject), String(t.given), String(t.cancelled)]),
    };
  }
  return {
    art,
    title: EXPORT_LABELS[art],
    subtitle,
    filename: "vertretungsstatistik-klassen",
    head: ["Klasse/Kurs", "vertreten", "davon mit anderem Fach", "Entfall"],
    rows: stats.groups.map((g) => [g.name, String(g.substituted), String(g.ownSubject), String(g.cancelled)]),
  };
}

/** Die Tabelle eines Exports. Rechte prüft der Aufrufer mit `canExport` (404 bei Fehlen). */
export async function buildExport(db: Db, art: ExportArt, opts: { today: string; monat?: boolean }): Promise<ExportTable> {
  switch (art) {
    case "gesamt-klassen":
    case "gesamt-lehrkraefte":
      return gesamt(db, art, opts.today);
    case "verteilung":
      return verteilung(db, opts.today);
    case "deputate":
      return deputate(db, opts.today);
    case "aufsichten":
      return aufsichten(db);
    case "statistik-lehrkraefte":
    case "statistik-klassen":
      return statistik(db, art, opts.today, opts.monat ?? false);
  }
}
