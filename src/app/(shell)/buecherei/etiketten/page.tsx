import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { markQueuePrintedAction } from "@/modules/buecherei/actions";
import { LABEL_TEMPLATES, labelQueue, perSheet } from "@/modules/buecherei/etiketten";
import { canStock } from "@/modules/buecherei/service";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { Field, Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { BuechereiNav } from "../ui";

export const metadata: Metadata = { title: "Bücherei-Etiketten" };

/**
 * Etiketten (BU-05, Recht `buecherei.stock`): neue Exemplare stehen in der Druckwarteschlange, bis sie in der Druckansicht als
 * gedruckt markiert werden. Druck über den Browser auf A4-Etikettenbögen (mit Startposition für angebrochene Bögen) oder
 * auf einen Etikettendrucker; Testseite zum Ausrichten.
 */
export default async function EtikettenPage({ searchParams }: { searchParams: Promise<{ gedruckt?: string }> }) {
  const { perms } = await requireUser();
  if (!canStock(perms)) notFound();
  const sp = await searchParams;
  const queue = await labelQueue(await getDb(), perms);
  const printed = sp.gedruckt !== undefined ? Number(sp.gedruckt) || 0 : null;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Bücherei" title="Etiketten" />
      <BuechereiNav current="etiketten" perms={perms} />
      <p className="max-w-3xl text-sm text-muted">
        Jedes Exemplar bekommt ein Etikett mit Exemplarnummer als Strichcode (Code 128), Signatur und Titel. Neue Exemplare landen in der Druckwarteschlange;
        nach dem Drucken in der Druckansicht „als gedruckt markieren“. Einzelne Etiketten (auch zum Nachdrucken) gibt es im Bestand beim Titel.
      </p>
      {printed !== null && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          {printed === 1 ? "1 Etikett als gedruckt markiert." : `${printed} Etiketten als gedruckt markiert.`}
        </p>
      )}

      <Card aria-labelledby="warteschlange">
        <CardHeader title={<span id="warteschlange">Druckwarteschlange</span>} />
        {queue.count === 0 ? (
          <EmptyState title="Keine Etiketten offen">Alle Exemplare im Bestand haben ein gedrucktes Etikett.</EmptyState>
        ) : (
          <>
            <p className="text-sm">
              <strong className="tabular-nums">{queue.count}</strong> {queue.count === 1 ? "Exemplar wartet" : "Exemplare warten"} auf ein Etikett.
            </p>
            <form action="/druck/buecherei-etiketten" method="get" aria-label="Warteschlange drucken" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="quelle" value="warteschlange" />
              <Field label="Vorlage">
                <Select name="vorlage" defaultValue={LABEL_TEMPLATES[0]!.id} className="w-72">
                  {LABEL_TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Startposition" hint="erstes freies Etikett auf dem Bogen (zeilenweise von links oben)">
                <Input type="number" name="start" min={1} max={40} defaultValue="1" className="w-28" />
              </Field>
              <Button type="submit">Druckansicht öffnen</Button>
            </form>
            <Table>
              <caption className="sr-only">Exemplare in der Druckwarteschlange</caption>
              <thead>
                <tr>
                  <th>Exemplarnummer</th>
                  <th>Titel</th>
                  <th>Signatur</th>
                </tr>
              </thead>
              <tbody>
                {queue.rows.map((r) => (
                  <tr key={r.copyId}>
                    <td className="font-mono tabular-nums">{r.barcode}</td>
                    <td>
                      <Link href={`/buecherei/bestand/${r.titleId}`} className="font-medium text-accent-ink hover:underline">
                        {r.title}
                      </Link>
                    </td>
                    <td>{r.signature ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {queue.count > queue.rows.length && <p className="text-sm text-muted">… und {queue.count - queue.rows.length} weitere.</p>}
            <form action={markQueuePrintedAction} className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="ghost" size="sm">
                Alle als gedruckt markieren
              </Button>
              <span className="text-xs text-muted">z. B. für Altbestand, der schon Etiketten hat</span>
            </form>
          </>
        )}
      </Card>

      <Card aria-labelledby="vorlagen">
        <CardHeader title={<span id="vorlagen">Vorlagen und Testseite</span>} />
        <p className="text-sm text-muted">
          Vor dem ersten Druck eine Testseite auf normales Papier drucken und gegen den Etikettenbogen halten. Im Druckdialog „Tatsächliche Größe“ (100 %)
          wählen und Kopf-/Fußzeilen ausschalten.
        </p>
        <ul className="flex flex-col gap-2 text-sm">
          {LABEL_TEMPLATES.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3">
              <span className="min-w-72">{t.label}</span>
              <span className="text-muted">{t.kind === "bogen" ? `${perSheet(t)} je Seite` : "ein Etikett je Seite"}</span>
              <Link href={`/druck/buecherei-etiketten?test=1&vorlage=${t.id}`} className="font-medium text-accent-ink hover:underline" aria-label={`Testseite ${t.label}`}>
                Testseite
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}
