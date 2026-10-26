import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { classLeadClasses, classOpenItems, type ClassOpenRow } from "@/modules/buecherei/klasse";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { BuechereiNav } from "../ui";

export const metadata: Metadata = { title: "Meine Klasse – Bücherei" };

const Count = ({ n, tone }: { n: number; tone: "warn" | "danger" }) => (n > 0 ? <Badge tone={tone}>{n}</Badge> : <span className="text-muted">–</span>);

/** Spaltenkopf: auf schmalen Bildschirmen kurz (Vorleser lesen immer die volle Bezeichnung), sonst ausgeschrieben. */
const ShortHead = ({ short, full }: { short: string; full: string }) => (
  <>
    <span aria-hidden className="sm:hidden">
      {short}
    </span>
    <span className="max-sm:sr-only">{full}</span>
  </>
);

const withOpen = (r: ClassOpenRow) => r.schoolbooks + r.compensations > 0;

/**
 * Klassenleitung (BU-16): offene Schulbücher und Ersatzforderungen je Schüler:in der eigenen Klasse – nur Name und Zahlen,
 * ohne Titel. Recht: Klassenleitung einer aktiven Klasse (kein Bücherei-Recht nötig); Einzelheiten sehen nur die Person, ihre
 * Eltern und die Verwaltung mit „Schulbuchausleihe“.
 */
export default async function KlassePage() {
  const { perms } = await requireUser();
  const db = await getDb();
  if ((await classLeadClasses(db, perms)).length === 0) notFound();
  const { stage2, classes } = await classOpenItems(db, perms);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Bücherei" title="Meine Klasse" />
      <BuechereiNav current="klasse" perms={perms} />
      <p className="text-sm text-muted">
        {stage2 ? "Offene Schulbücher und Ersatzforderungen" : "Offene Ersatzforderungen"} deiner Klasse – nur als Zahl. Welche Bücher es sind, sehen die
        Schüler:innen und ihre Eltern unter „Meine Ausleihen“ und die Verwaltung. Ausleihen der Bücherei stehen hier nicht: Was jemand liest, ist privat.
      </p>
      {classes.map((c) => {
        const open = c.students.filter(withOpen).length;
        return (
          <Card key={c.id} aria-labelledby={`klasse-${c.id}`}>
            <CardHeader title={<span id={`klasse-${c.id}`}>{c.name}</span>} />
            {c.students.length === 0 ? (
              <EmptyState title="Keine Schüler:innen in der Klasse" />
            ) : (
              <>
                <p className="text-sm text-muted">
                  {open === 0 ? "Niemand hat etwas offen." : `${open} von ${c.students.length} Schüler:innen mit offenen Posten.`}
                </p>
                <Table>
                  <caption className="sr-only">Offene Posten in {c.name}</caption>
                  <thead>
                    <tr>
                      <th>Schüler:in</th>
                      {stage2 && (
                        <th className="text-right">
                          <ShortHead short="Bücher" full="Schulbücher offen" />
                        </th>
                      )}
                      <th className="text-right">
                        <ShortHead short="Ersatz" full="Ersatzforderungen offen" />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.students.map((s) => (
                      <tr key={s.userId}>
                        <td className={withOpen(s) ? "font-medium" : undefined}>{s.name}</td>
                        {stage2 && (
                          <td className="text-right tabular-nums">
                            <Count n={s.schoolbooks} tone="warn" />
                          </td>
                        )}
                        <td className="text-right tabular-nums">
                          <Count n={s.compensations} tone="danger" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </>
            )}
          </Card>
        );
      })}
    </main>
  );
}
