import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { printClassCardsAction } from "@/modules/buecherei/actions";
import { cardClasses } from "@/modules/buecherei/cards";
import { canDesk } from "@/modules/buecherei/loans";
import { Button } from "@schulos/ui/button";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { BuechereiNav } from "../ui";

export const metadata: Metadata = { title: "Büchereiausweise" };

/**
 * Ausweise (BU-07, Recht `buecherei.desk`): klassenweise Codes erzeugen und drucken. Der Code ist zufällig und enthält
 * weder Namen noch Kontonummer; einzelne Ausweise (auch Ersatz bei Verlust) gibt es an der Theke bei der Person.
 */
export default async function AusweisePage() {
  const { perms } = await requireUser();
  if (!canDesk(perms)) notFound();
  const classes = await cardClasses(await getDb(), perms);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Bücherei" title="Ausweise" />
      <BuechereiNav current="ausweise" perms={perms} />
      <p className="max-w-3xl text-sm text-muted">
        Jeder Ausweis trägt einen zufälligen Code (Code 128) – ohne Namen oder Kontonummer darin. An der Theke wählt ein gescannter Ausweis die Person; die
        Suche nach Name oder Klasse bleibt als Rückfall. Ein verlorener Ausweis wird an der Theke ersetzt, der alte Code gilt dann nicht mehr. Drucken über
        den Browser: Karten (zehn je A4-Seite) oder Etiketten 62 × 29 mm.
      </p>
      {classes.length === 0 ? (
        <EmptyState title="Keine Klassen" />
      ) : (
        <Table>
          <caption className="sr-only">Ausweise je Klasse</caption>
          <thead>
            <tr>
              <th>Klasse</th>
              <th className="text-right">Schüler:innen</th>
              <th className="text-right">mit Ausweis</th>
              <th className="sr-only">Drucken</th>
            </tr>
          </thead>
          <tbody>
            {classes.map((c) => (
              <tr key={c.id}>
                <td className="font-medium">{c.name}</td>
                <td className="text-right tabular-nums">{c.members}</td>
                <td className="text-right tabular-nums">{c.cards}</td>
                <td className="text-right">
                  <form action={printClassCardsAction.bind(null, c.id)}>
                    <Button type="submit" size="sm" variant="secondary" aria-label={`Ausweise ${c.name} drucken`}>
                      {c.cards < c.members ? "Codes ergänzen und drucken" : "Drucken"}
                    </Button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </main>
  );
}
