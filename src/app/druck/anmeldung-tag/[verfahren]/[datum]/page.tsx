import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { TZ } from "@/core/time";
import { ANTRAG_STATUS_LABELS } from "@/modules/anmeldung/labels";
import { dayList } from "@/modules/anmeldung/sekretariat";
import { getVerfahren } from "@/modules/anmeldung/service";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Tagesliste Anmeldegespräche" };
export const dynamic = "force-dynamic";

const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const timeFmt = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

/** Tagesliste der Anmeldegespräche (P4-36) – je Termin die angemeldeten Kinder mit Elternteil und Telefon. */
export default async function TageslistePage({ params }: { params: Promise<{ verfahren: string; datum: string }> }) {
  await requireModulePage("anmeldung");
  const { perms } = await requireUser();
  const { verfahren, datum } = await params;
  const db = await getDb();
  const v = await getVerfahren(db, perms, decodeURIComponent(verfahren)).catch(() => null);
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(datum)) notFound();
  const rows = await dayList(db, perms, v.id, datum);
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/verwaltung/anmeldung/${v.id}/antraege`}>Zurück zu den Anträgen</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[277mm] flex-col gap-5">
        <DruckKopf eyebrow={v.name} title="Anmeldegespräche" subtitle={dayFmt.format(new Date(`${datum}T12:00:00Z`))} stamp={`Stand ${stamp.format(new Date())}`} />
        {rows.length === 0 ? (
          <p className="text-sm">Keine Gesprächstermine an diesem Tag.</p>
        ) : (
          <table className="w-full border-collapse text-left text-sm [&_td]:border [&_td]:border-border-strong [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border-strong [&_th]:px-2 [&_th]:py-1 [&_th]:text-xs">
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Raum</th>
                <th>Nummer</th>
                <th>Kind</th>
                <th>Elternteil</th>
                <th>Telefon</th>
                <th>Stand</th>
                <th>Notiz</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((r) =>
                r.antraege.length === 0
                  ? [
                      <tr key={r.slot.id} className="break-inside-avoid">
                        <td className="tabular-nums">
                          {timeFmt.format(r.slot.startsAt)}–{timeFmt.format(r.slot.endsAt)}
                        </td>
                        <td>{r.slot.room ?? "–"}</td>
                        <td colSpan={6} className="text-muted">
                          frei
                        </td>
                      </tr>,
                    ]
                  : r.antraege.map((a) => (
                      <tr key={a.id} className="break-inside-avoid">
                        <td className="tabular-nums">
                          {timeFmt.format(r.slot.startsAt)}–{timeFmt.format(r.slot.endsAt)}
                        </td>
                        <td>{r.slot.room ?? "–"}</td>
                        <td className="tabular-nums">{a.number}</td>
                        <td>
                          {a.child}
                          {a.sibling ? " (Geschwister)" : ""}
                        </td>
                        <td>{a.parent}</td>
                        <td>{a.phone ?? "–"}</td>
                        <td>{ANTRAG_STATUS_LABELS[a.status]}</td>
                        <td className="w-[40mm]" />
                      </tr>
                    )),
              )}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
