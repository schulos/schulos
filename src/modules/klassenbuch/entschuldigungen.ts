// DS-16 (B05-KRANKMELDUNG.md): Entschuldigungen als eigener Teil des Archivexports. Gilt die Meldung über SchulOS als
// schriftliche Entschuldigung (Einstellung „abwesenheiten.digital_written“), gehört sie zur Schülerakte – Aufbewahrung
// 5 Jahre (§ 9 Abs. 1 Nr. 4 VO-DV I, BASS 12-51 Nr. 5 Nr. 3), Fristbeginn frühestens mit Ende der Schulpflicht. Sie steht
// deshalb in eigenen Dateien und nicht in der Klassenbuch-Druckansicht.
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/core/db/client";
import { absenceReports, groups, schoolYears, users } from "@/core/db/schema";
import { readModuleSetting } from "@/core/modules/settings";
import { REASON_LABEL, STATUS_LABEL } from "@/modules/abwesenheiten/labels";
import { DIGITAL_WRITTEN } from "@/modules/abwesenheiten/settings";

export const EXCUSE_YEARS = 5;

/** Rein: frühestes Vernichtungsdatum der Entschuldigungen = 31.12. des Abschlussjahres + 5 Jahre. */
export function excusesDestroyEarliest(closedOn: string): string {
  return `${Number(closedOn.slice(0, 4)) + EXCUSE_YEARS}-12-31`;
}

export interface ExcuseArchive {
  meta: { schuljahr: string; klasse: string; fruehestesVernichtungsdatum: string; frist: string; hinweis: string };
  entschuldigungen: {
    schueler: string;
    von: string;
    bis: string;
    grund: string;
    gemeldetVon: string | null;
    gemeldetAm: string;
    entscheidung: string;
    entschiedenVon: string | null;
    entschiedenAm: string | null;
  }[];
}

/** Gilt die digitale Meldung als schriftliche Entschuldigung? (Vorgabe: ja) */
export async function excusesArchived(db: Db): Promise<boolean> {
  return (await readModuleSetting(db, DIGITAL_WRITTEN)) !== "0";
}

/**
 * Meldungen der Schüler:innen einer Klasse im Schuljahr der Gruppe. `reportIds` (nicht Teil der Datei) nennt die enthaltenen
 * Meldungen – der Archivexport vermerkt sich daran (G4D-S01).
 */
export async function collectExcuses(db: Db, groupId: string, studentIds: readonly string[]): Promise<{ archive: ExcuseArchive; reportIds: string[] }> {
  const [g] = await db
    .select({ name: groups.name, yearName: schoolYears.name, startsOn: schoolYears.startsOn, endsOn: schoolYears.endsOn })
    .from(groups)
    .innerJoin(schoolYears, eq(schoolYears.id, groups.schoolYearId))
    .where(eq(groups.id, groupId));
  const reporter = alias(users, "reporter");
  const decider = alias(users, "decider");
  const rows =
    g && studentIds.length
      ? await db
          .select({
            id: absenceReports.id,
            student: users.name,
            from: absenceReports.fromDate,
            to: absenceReports.toDate,
            reason: absenceReports.reason,
            status: absenceReports.status,
            reporter: reporter.name,
            createdAt: absenceReports.createdAt,
            decider: decider.name,
            decidedAt: absenceReports.decidedAt,
          })
          .from(absenceReports)
          .innerJoin(users, eq(users.id, absenceReports.studentId))
          .leftJoin(reporter, eq(reporter.id, absenceReports.reportedBy))
          .leftJoin(decider, eq(decider.id, absenceReports.decidedBy))
          .where(and(inArray(absenceReports.studentId, [...studentIds]), gte(absenceReports.fromDate, g.startsOn), lte(absenceReports.fromDate, g.endsOn)))
          .orderBy(asc(users.lastName), asc(absenceReports.fromDate))
      : [];
  const archive: ExcuseArchive = {
    meta: {
      schuljahr: g?.yearName ?? "",
      klasse: g?.name ?? "",
      fruehestesVernichtungsdatum: excusesDestroyEarliest(g?.endsOn ?? "1970-01-01"),
      frist: "5 Jahre (§ 9 Abs. 1 Nr. 4 VO-DV I; BASS 12-51 Nr. 5 Nr. 3: Entschuldigungen sind Teil der Schülerakte)",
      hinweis:
        "Die Frist beginnt frühestens mit Ablauf des Kalenderjahres, in dem die Schulpflicht der betroffenen Person endet – endet sie später, verschiebt sich das Vernichtungsdatum. Gesundheitsbezug: nur für die Klassenleitung, Schulleitung und die Schülerakte, nicht mit dem Klassenbuch auslegen.",
    },
    entschuldigungen: rows.map((r) => ({
      schueler: r.student,
      von: r.from,
      bis: r.to,
      grund: REASON_LABEL[r.reason],
      gemeldetVon: r.reporter,
      gemeldetAm: r.createdAt.toISOString(),
      entscheidung: STATUS_LABEL[r.status],
      entschiedenVon: r.decider,
      entschiedenAm: r.decidedAt?.toISOString() ?? null,
    })),
  };
  return { archive, reportIds: rows.map((r) => r.id) };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const de = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

/** Rein: Druckansicht der Entschuldigungen (eigene Datei, nicht Teil der Klassenbuch-Ansicht). */
export function excusesHtml(d: ExcuseArchive): string {
  const rows = d.entschuldigungen
    .map(
      (e) =>
        `<tr><td>${esc(e.schueler)}</td><td>${de(e.von)}${e.bis !== e.von ? `–${de(e.bis)}` : ""}</td><td>${esc(e.grund)}</td><td>${esc(e.gemeldetVon ?? "–")}<br><small>${esc(e.gemeldetAm.slice(0, 10))}</small></td><td>${esc(e.entscheidung)}${e.entschiedenVon ? `<br><small>${esc(e.entschiedenVon)}</small>` : ""}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Entschuldigungen ${esc(d.meta.klasse)} ${esc(d.meta.schuljahr)}</title>
<style>body{font:11pt/1.4 system-ui,sans-serif;margin:2cm}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px;vertical-align:top;text-align:left}th{background:#eee}dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px}@media print{tr{break-inside:avoid}}</style>
</head><body>
<h1>Entschuldigungen ${esc(d.meta.klasse)} – Schuljahr ${esc(d.meta.schuljahr)}</h1>
<dl><dt>Frist</dt><dd>${esc(d.meta.frist)}</dd><dt>Frühestes Vernichtungsdatum</dt><dd>${de(d.meta.fruehestesVernichtungsdatum)}</dd><dt>Hinweis</dt><dd>${esc(d.meta.hinweis)}</dd></dl>
<table><thead><tr><th>Schüler:in</th><th>Zeitraum</th><th>Grund</th><th>gemeldet von</th><th>Entscheidung</th></tr></thead><tbody>
${rows || '<tr><td colspan="5">keine Meldungen</td></tr>'}
</tbody></table></body></html>`;
}
