import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { canDesk } from "@/modules/buecherei/loans";
import { canSeeDunningLevels, dunningList } from "@/modules/buecherei/mahnungen";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { BuechereiNav } from "../ui";

export const metadata: Metadata = { title: "Mahnliste" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const day = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));

/**
 * Mahnliste (BU-04, Recht `buecherei.desk`): überfällige Ausleihen, am längsten überfällige zuerst. Name und Klasse wie an der
 * Theke; Mahnstufen sehen nur Erwachsene im Team, Schüler-Helfer:innen nicht. Mahnungen verschickt der tägliche Lauf selbst.
 */
export default async function MahnlistePage() {
  const { perms } = await requireUser();
  if (!canDesk(perms)) notFound();
  const db = await getDb();
  const rows = await dunningList(db, perms, toBerlinDate(new Date()));
  const levels = canSeeDunningLevels(perms);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Bücherei" title="Mahnliste" />
      <BuechereiNav current="mahnliste" perms={perms} />
      <p className="text-sm text-muted">
        Erinnerungen und Mahnungen verschickt SchulOS jeden Schultag selbst – ohne Titel, nur mit dem Hinweis auf „Meine Ausleihen“. Ab der 2. Mahnung erfahren es auch
        die Eltern Minderjähriger. Rückgabe oder Verlängern beendet die Mahnung.
      </p>
      <Card aria-labelledby="ueberfaellig">
        <CardHeader title={<span id="ueberfaellig">Überfällig ({rows.length})</span>} />
        {rows.length === 0 ? (
          <EmptyState title="Nichts überfällig" />
        ) : (
          <Table>
            <caption className="sr-only">Überfällige Ausleihen</caption>
            <thead>
              <tr>
                <th>Person</th>
                <th>Titel</th>
                <th>fällig seit</th>
                {levels && <th>Mahnstufe</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.loanId}>
                  <td>
                    {r.userId && r.name ? (
                      <Link href={`/buecherei/theke?person=${encodeURIComponent(r.userId)}`} className="font-medium hover:underline">
                        {r.name}
                      </Link>
                    ) : (
                      <span className="text-muted">Konto gelöscht</span>
                    )}
                    {r.className && <span className="ml-2 text-sm text-muted">{r.className}</span>}
                  </td>
                  <td>
                    {r.title} <span className="font-mono text-xs text-muted">{r.barcode}</span>
                  </td>
                  <td className="tabular-nums">
                    {day(r.dueOn)}
                    <span className="block text-xs text-muted">{r.overdueDays === 1 ? "1 Tag" : `${r.overdueDays} Tage`}</span>
                  </td>
                  {levels && (
                    <td>
                      {r.dunningLevel ? <Badge tone={r.dunningLevel >= 3 ? "danger" : "warn"}>{r.dunningLevel}. Mahnung</Badge> : <span className="text-sm text-muted">noch keine</span>}
                      {r.dunnedOn && <span className="block text-xs text-muted">am {day(r.dunnedOn)}</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </main>
  );
}
