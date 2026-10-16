// Archivexport des Klassenbuchs (B-08, DATENSCHUTZ.md §3.6, § 9 VO-DV I): je Klasse ein ZIP mit Metadaten,
// maschinenlesbarem JSON und einer Druckansicht (HTML → „als PDF speichern“). Wird nicht auf dem Server abgelegt.
// Erst wenn die Schule die Übergabe bestätigt, darf der Löschlauf die Akte im Live-System löschen.
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { absenceReports, classbookAbsences, classbookEntries, groupMembers, groups, recordArchives, schoolYears, subjects, users } from "@/core/db/schema";
import { createZip } from "@/core/zip";
import { ValidationError } from "@/modules/verwaltung/users";
import { collectExcuses, excusesArchived, excusesHtml } from "./entschuldigungen";

export const ARCHIVE_NOTE = "Nach Fristablauf dem zuständigen Archiv anzubieten (§ 9 Abs. 3 VO-DV I).";

/** Rein: frühestes Vernichtungsdatum = 31.12. des Abschlussjahres + 10 Jahre. */
export function destroyEarliest(closedOn: string): string {
  return `${Number(closedOn.slice(0, 4)) + 10}-12-31`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const de = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

export interface ArchiveData {
  meta: {
    schuljahr: string;
    klasse: string;
    abschlussdatum: string;
    fruehestesVernichtungsdatum: string;
    vermerk: string;
    hinweis: string;
    exportiertAm: string;
  };
  schueler: { id: string; name: string }[];
  eintraege: {
    datum: string;
    stunde: number;
    fach: string;
    lehrkraft: string | null;
    thema: string;
    hausaufgabe: string | null;
    fehlzeiten: { schueler: string; art: "fehlt" | "verspätet"; minuten: number | null; entschuldigt: boolean | null }[];
  }[];
}

/** Sammelt die Akte einer Gruppe. */
export async function collectArchive(db: Db, groupId: string, now = new Date()): Promise<ArchiveData> {
  const [g] = await db
    .select({ name: groups.name, yearName: schoolYears.name, endsOn: schoolYears.endsOn })
    .from(groups)
    .innerJoin(schoolYears, eq(schoolYears.id, groups.schoolYearId))
    .where(eq(groups.id, groupId));
  if (!g) throw new ValidationError({ archive: "Gruppe ohne Schuljahr – kein Archivexport möglich" });
  const teacher = alias(users, "teacher");
  const entries = await db
    .select({
      id: classbookEntries.id,
      date: classbookEntries.date,
      periodNr: classbookEntries.periodNr,
      subject: subjects.name,
      teacher: teacher.name,
      topic: classbookEntries.topic,
      homework: classbookEntries.homework,
    })
    .from(classbookEntries)
    .innerJoin(subjects, eq(subjects.id, classbookEntries.subjectId))
    .leftJoin(teacher, eq(teacher.id, classbookEntries.teacherId))
    .where(eq(classbookEntries.groupId, groupId))
    .orderBy(asc(classbookEntries.date), asc(classbookEntries.periodNr));
  const absences = entries.length
    ? await db
        .select({
          entryId: classbookAbsences.entryId,
          studentId: classbookAbsences.studentId,
          name: users.name,
          kind: classbookAbsences.kind,
          minutesLate: classbookAbsences.minutesLate,
          excused: classbookAbsences.excused,
        })
        .from(classbookAbsences)
        .innerJoin(users, eq(users.id, classbookAbsences.studentId))
        .where(inArray(classbookAbsences.entryId, entries.map((e) => e.id)))
    : [];
  // Klassenliste: Mitglieder (vor dem Archivieren) plus alle, die im Klassenbuch vorkommen
  const roster = await db
    .select({ id: users.id, name: users.name })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), eq(users.role, "schueler")));
  const students = new Map(roster.map((r) => [r.id, r.name]));
  for (const a of absences) students.set(a.studentId, a.name);
  return {
    meta: {
      schuljahr: g.yearName,
      klasse: g.name,
      abschlussdatum: g.endsOn,
      fruehestesVernichtungsdatum: destroyEarliest(g.endsOn),
      vermerk: ARCHIVE_NOTE,
      hinweis:
        "Die Frist verlängert sich, wenn die Schulpflicht einer betroffenen Person später endet: dann 31.12. jenes Jahres + 10 Jahre (§ 9 VO-DV I). Bitte vor der Vernichtung prüfen.",
      exportiertAm: now.toISOString(),
    },
    schueler: [...students].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "de")),
    eintraege: entries.map((e) => ({
      datum: e.date,
      stunde: e.periodNr,
      fach: e.subject,
      lehrkraft: e.teacher,
      thema: e.topic,
      hausaufgabe: e.homework,
      fehlzeiten: absences
        .filter((a) => a.entryId === e.id)
        .map((a) => ({ schueler: a.name, art: a.kind === "late" ? "verspätet" : "fehlt", minuten: a.minutesLate, entschuldigt: a.excused })),
    })),
  };
}

/** Rein: Druckansicht der Akte. */
export function archiveHtml(d: ArchiveData): string {
  const rows = d.eintraege
    .map(
      (e) =>
        `<tr><td>${de(e.datum)}</td><td>${e.stunde}.</td><td>${esc(e.fach)}</td><td>${esc(e.lehrkraft ?? "–")}</td><td>${esc(e.thema)}${
          e.hausaufgabe ? `<br><small>HA: ${esc(e.hausaufgabe)}</small>` : ""
        }</td><td>${e.fehlzeiten
          .map((f) => `${esc(f.schueler)}${f.art === "verspätet" ? ` (${f.minuten ?? "?"} Min. verspätet)` : ""}${f.entschuldigt === true ? " – entsch." : f.entschuldigt === false ? " – unentsch." : ""}`)
          .join("<br>")}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Klassenbuch ${esc(d.meta.klasse)} ${esc(d.meta.schuljahr)}</title>
<style>body{font:11pt/1.4 system-ui,sans-serif;margin:2cm}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px;vertical-align:top;text-align:left}th{background:#eee}dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px}@media print{tr{break-inside:avoid}}</style>
</head><body>
<h1>Klassenbuch ${esc(d.meta.klasse)} – Schuljahr ${esc(d.meta.schuljahr)}</h1>
<dl><dt>Abschlussdatum</dt><dd>${de(d.meta.abschlussdatum)}</dd><dt>Frühestes Vernichtungsdatum</dt><dd>${de(d.meta.fruehestesVernichtungsdatum)}</dd><dt>Vermerk</dt><dd><strong>${esc(d.meta.vermerk)}</strong></dd><dt>Hinweis</dt><dd>${esc(d.meta.hinweis)}</dd></dl>
<h2>Schüler:innen (${d.schueler.length})</h2><p>${d.schueler.map((s) => esc(s.name)).join(", ") || "–"}</p>
<h2>Einträge (${d.eintraege.length})</h2>
<table><thead><tr><th>Datum</th><th>Std.</th><th>Fach</th><th>Lehrkraft</th><th>Thema</th><th>Fehlzeiten</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>`;
}

/** Erzeugt den Archivexport (ZIP) und vermerkt ihn. Wer exportiert, steht im Audit-Log. */
export async function exportClassbookArchive(db: Db, actorId: string, groupId: string, now = new Date()): Promise<{ filename: string; zip: Uint8Array }> {
  const d = await collectArchive(db, groupId, now);
  // DS-16: Entschuldigungen (Meldungen der Eltern) als eigener Teil mit 5-Jahres-Frist – nicht in der Klassenbuch-Ansicht
  const collected = (await excusesArchived(db))
    ? await collectExcuses(
        db,
        groupId,
        d.schueler.map((s) => s.id),
      )
    : null;
  const excuses = collected?.archive ?? null;
  const enc = new TextEncoder();
  const excuseFiles = excuses
    ? [
        { name: "entschuldigungen.json", data: enc.encode(JSON.stringify(excuses, null, 2)), modifiedAt: now },
        { name: "entschuldigungen.html", data: enc.encode(excusesHtml(excuses)), modifiedAt: now },
      ]
    : [];
  const zip = createZip([
    {
      name: "LIESMICH.txt",
      data: enc.encode(
        `Archivexport Klassenbuch ${d.meta.klasse}, Schuljahr ${d.meta.schuljahr}\r\n\r\n` +
          `metadaten.json   Schuljahr, Klasse, Fristen, Vermerk\r\nklassenbuch.json maschinenlesbar\r\nklassenbuch.html Druckansicht (im Browser öffnen und als PDF speichern)\r\n\r\n` +
          `Frühestes Vernichtungsdatum: ${de(d.meta.fruehestesVernichtungsdatum)}\r\n${d.meta.vermerk}\r\n${d.meta.hinweis}\r\n` +
          (excuses
            ? `\r\nentschuldigungen.json / .html  Entschuldigungen (Meldungen der Eltern) – Teil der Schülerakte, eigene Frist ${excuses.meta.frist}, frühestes Vernichtungsdatum ${de(excuses.meta.fruehestesVernichtungsdatum)}. ${excuses.meta.hinweis}\r\n`
            : ""),
      ),
      modifiedAt: now,
    },
    { name: "metadaten.json", data: enc.encode(JSON.stringify(d.meta, null, 2)), modifiedAt: now },
    { name: "klassenbuch.json", data: enc.encode(JSON.stringify(d, null, 2)), modifiedAt: now },
    { name: "klassenbuch.html", data: enc.encode(archiveHtml(d)), modifiedAt: now },
    ...excuseFiles,
  ]);
  const values = {
    groupName: d.meta.klasse,
    schoolYearName: d.meta.schuljahr,
    closedOn: d.meta.abschlussdatum,
    destroyEarliest: d.meta.fruehestesVernichtungsdatum,
    exportedAt: now,
    exportedBy: actorId,
  };
  const [ra] = await db.insert(recordArchives).values({ groupId, ...values }).onConflictDoUpdate({ target: recordArchives.groupId, set: values }).returning({ id: recordArchives.id });
  // G4D-S01: die enthaltenen Meldungen merken sich diesen Export – gelöscht wird erst nach dessen Übergabe. Wer schon in einem
  // übergebenen Export steht, behält diesen Vermerk (ein neuer, noch nicht übergebener Export hält nichts zurück).
  if (collected?.reportIds.length) {
    const handedOver = sql`exists (select 1 from ${recordArchives} r where r.id = ${absenceReports.archiveId} and r.handed_over_at is not null and r.handed_over_at >= ${absenceReports.archivedAt})`;
    await db
      .update(absenceReports)
      .set({ archiveId: ra!.id, archivedAt: now })
      .where(and(inArray(absenceReports.id, collected.reportIds), or(isNull(absenceReports.archiveId), sql`not ${handedOver}`)));
  }
  await audit(db, actorId, "klassenbuch.archiv.export", groupId, { entries: d.eintraege.length, excuses: excuses?.entschuldigungen.length ?? null });
  const safe = `${d.meta.klasse}_${d.meta.schuljahr}`.replace(/[^\p{L}\p{N}]+/gu, "-");
  return { filename: `Klassenbuch_${safe}.zip`, zip };
}

/** Die Schule bestätigt, dass der Export verwahrt ist – erst dann darf die Akte im Live-System gelöscht werden. */
export async function confirmHandover(db: Db, actorId: string, groupId: string, now = new Date()): Promise<void> {
  const [a] = await db.select().from(recordArchives).where(eq(recordArchives.groupId, groupId));
  if (!a) throw new ValidationError({ archive: "Erst exportieren" });
  if (a.handedOverAt) return;
  await db.update(recordArchives).set({ handedOverAt: now, handedOverBy: actorId }).where(eq(recordArchives.id, a.id));
  await audit(db, actorId, "klassenbuch.archiv.uebergabe", groupId, {});
}
