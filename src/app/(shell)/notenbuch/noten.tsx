import { getDb } from "@/core/db/client";
import type { PermissionSet } from "@/core/permissions";
import { familyGrades, gradeOwners, type FamilyView } from "@/modules/notenbuch/einsicht";
import { Badge } from "@schulos/ui/badge";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";

const dateFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "UTC" });
const fmtDate = (ymd: string | null) => (ymd ? dateFmt.format(new Date(`${ymd}T00:00:00Z`)) : "–");

function StudentGrades({ view, many }: { view: FamilyView; many: boolean }) {
  const label = `Noten ${view.student.name}`;
  return (
    <section aria-label={label} className="flex flex-col gap-4">
      {many && <h2 className="font-display text-xl font-bold">{view.student.name}</h2>}
      {view.books.length === 0 ? (
        <EmptyState title="Noch keine Noten">
          {view.scope === "halbjahr" ? "Halbjahresnoten erscheinen hier, sobald die Lehrkraft das Notenbuch abgeschlossen hat." : "Noten erscheinen hier, sobald Lehrkräfte sie eintragen."}
        </EmptyState>
      ) : (
        view.books.map((b) => (
          <Card key={b.bookId} aria-label={`${b.subjectName} ${b.schoolYearName} ${b.term}. Halbjahr`}>
            <header className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-semibold">
                {b.subjectName} <span className="text-sm font-normal text-muted">· {b.groupName}</span>
              </h3>
              <span className="text-sm text-muted">
                {b.schoolYearName} · {b.term}. Halbjahr
              </span>
            </header>
            {b.final !== null ? (
              <p className="flex items-center gap-2 text-sm">
                Halbjahresnote <span className="font-display text-2xl font-bold">{b.final}</span>
              </p>
            ) : (
              <p className="text-sm text-muted">Halbjahresnote: noch nicht abgeschlossen</p>
            )}
            {b.grades.length > 0 && (
              <Table>
                <caption className="sr-only">Teilnoten {b.subjectName}</caption>
                <thead>
                  <tr>
                    <th scope="col">Leistung</th>
                    <th scope="col">Art</th>
                    <th scope="col">Datum</th>
                    <th scope="col">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {b.grades.map((g, i) => (
                    <tr key={i}>
                      <td>{g.title}</td>
                      <td>{g.kind}</td>
                      <td>{fmtDate(g.date)}</td>
                      <td className="font-medium">{g.display}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        ))
      )}
    </section>
  );
}

/**
 * P5-14: Noten für Schüler:innen bzw. Eltern (Moduleinstellung, Vorgabe aus) – nur eigene bzw. verknüpfte Kinder, ohne
 * Kommentare und Vorschläge; Halbjahresnoten erst nach dem Abschluss. Die Rechte prüft der Service.
 */
export async function FamilyGrades({ perms }: { perms: PermissionSet }) {
  const db = await getDb();
  const owners = await gradeOwners(db, perms);
  const views = (await Promise.all(owners.map((o) => familyGrades(db, perms, o.id)))).filter((v): v is FamilyView => v !== null);
  const scope = views[0]?.scope;
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Unterricht" title="Noten" />
      <p className="max-w-3xl text-sm text-muted">
        {scope === "teilnoten" ? "Teilnoten und Halbjahresnoten" : "Halbjahresnoten"} aus den Notenbüchern der Lehrkräfte. Halbjahresnoten erscheinen erst nach dem
        Abschluss des Notenbuchs. Amtlich sind allein die Noten auf dem Zeugnis. <Badge tone="soft">nur lesen</Badge>
      </p>
      {views.map((v) => (
        <StudentGrades key={v.student.id} view={v} many={views.length > 1} />
      ))}
    </main>
  );
}
