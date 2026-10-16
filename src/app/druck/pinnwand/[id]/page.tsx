import { requireModulePage } from "@/core/modules/guard";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ } from "@/core/time";
import { getBoard } from "@/modules/pinnwaende/service";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Pinnwand drucken" };

const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

/** P3-09: Druckansicht bzw. PDF (über „Drucken“ → „Als PDF speichern“) – Spalten untereinander, nur sichtbare Karten. */
export default async function PinnwandDruckPage({ params }: { params: Promise<{ id: string }> }) {
  await requireModulePage("pinnwaende");
  const { perms } = await requireUser();
  const id = (await params).id;
  const data = await getBoard(await getDb(), perms, id);
  if (!data) notFound();
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/pinnwaende/${id}`}>Zurück zur Pinnwand</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[190mm] flex-col gap-5">
        <DruckKopf eyebrow={data.groupName ?? "Freie Pinnwand"} title={data.board.title} stamp={`Stand ${stamp.format(new Date())} Uhr`} />
        {data.columns
          .map((col) => ({ ...col, cards: col.cards.filter((c) => c.approved) }))
          .map((col) => (
            <section key={col.id} aria-label={col.title} className="flex flex-col gap-2">
              <h2 className="font-display text-lg font-bold">{col.title}</h2>
              {col.cards.length === 0 ? (
                <p className="text-sm">Keine Karten.</p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {col.cards.map((c) => (
                    <li key={c.id} className="break-inside-avoid rounded-lg border border-border-strong px-3 py-2 text-sm">
                      <p className="font-semibold">{c.title}</p>
                      {c.body && <p className="whitespace-pre-wrap">{c.body}</p>}
                      {c.url && <p className="break-all">{c.url}</p>}
                      {c.fileName && <p>Datei: {c.fileName}</p>}
                      <p className="text-xs">{c.authorName ?? "Gelöschtes Konto"}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ))}
      </main>
    </div>
  );
}
