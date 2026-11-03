import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { isCalendarDate, toBerlinDate } from "@/core/time";
import { MEAL_HINT, servingList } from "@/modules/ganztag/essen";
import { canManage, dateLabel } from "@/modules/ganztag/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";

export const metadata: Metadata = { title: "Ganztag: Ausgabeliste" };

/** GT-12: Ausgabeliste eines Tages – Name, Klasse, Menü-Nr. (nur „Ganztag verwalten“), ohne Gesundheitsangaben. */
export default async function AusgabePage({ searchParams }: { searchParams: Promise<{ datum?: string }> }) {
  const { perms } = await requireUser();
  if (!canManage(perms)) notFound();
  const { datum } = await searchParams;
  const date = datum && isCalendarDate(datum) ? datum : toBerlinDate(new Date());
  const list = await servingList(await getDb(), perms, date);
  const count = (n: number) => list.rows.filter((r) => r.menu === n).length;

  return (
    <main className="flex max-w-3xl flex-col gap-5">
      <Button asChild variant="ghost" size="sm" className="self-start print:hidden">
        <Link href={`/ganztag/essen?woche=${date}`}>
          <ArrowLeft aria-hidden /> Mittagessen
        </Link>
      </Button>
      <PageHeader eyebrow="Ganztag · Mittagessen" title={`Ausgabeliste ${dateLabel(date)}`} />
      <p className="flex flex-wrap gap-2" role="status" aria-label="Anmeldungen je Menü">
        {list.menus.map((m) => (
          <Badge key={m.number}>
            Menü {m.number}: {count(m.number)}
          </Badge>
        ))}
        <Badge tone="soft">gesamt {list.rows.length}</Badge>
      </p>
      {list.menus.length > 0 && (
        <ul className="text-sm text-muted" aria-label="Menüs des Tages">
          {list.menus.map((m) => (
            <li key={m.number}>
              Menü {m.number}: {m.title}
            </li>
          ))}
        </ul>
      )}
      {list.rows.length === 0 ? (
        <EmptyState title="Keine Anmeldungen für diesen Tag" />
      ) : (
        <Table scrollLabel="Ausgabeliste">
          <thead>
            <tr>
              <th scope="col">Menü</th>
              <th scope="col">Name</th>
              <th scope="col">Klasse</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((r, i) => (
              <tr key={`${r.menu}-${r.name}-${i}`}>
                <td>{r.menu}</td>
                <td className="font-medium">{r.name}</td>
                <td>{r.className ?? "–"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="text-xs text-muted">{MEAL_HINT}</p>
    </main>
  );
}
