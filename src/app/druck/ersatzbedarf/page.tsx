import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { toBerlinDate } from "@/core/time";
import { REPLACEMENT_STATE_LABELS, parseHorizon, replacementReport } from "@/modules/gebaeude/ersatzbedarf";
import { canSeeInventory, listCategories } from "@/modules/gebaeude/inventar";
import { formatPrice } from "@/modules/gebaeude/labels";
import { buildingOptions, formatDay, roomOptions } from "@/modules/gebaeude/pruefungen";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Ersatzbedarf drucken" };

type Search = {
  kategorie?: string;
  gebaeude?: string;
  raum?: string;
  jahre?: string;
};

const TABLE =
  "w-full border-collapse text-left text-sm [&_td]:border [&_td]:border-border-strong [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border-strong [&_th]:px-2 [&_th]:py-1 [&_th]:text-xs";

/** INV-11: Ersatzbedarf als Druckansicht (Gespräch mit dem Schulträger) – Sicht und Preise wie auf der Seite, ohne Namen. */
export default async function ErsatzbedarfDruckPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModulePage("gebaeude");
  const { perms } = await requireUser();
  const db = await getDb();
  if (!(await canSeeInventory(db, perms))) notFound();
  const sp = await searchParams;
  const [categories, buildings, rooms] = await Promise.all([listCategories(db), buildingOptions(db), roomOptions(db)]);
  const category = categories.find((c) => c.id === sp.kategorie);
  const building = buildings.find((b) => b.value === sp.gebaeude);
  const room = rooms.find((r) => r.value === sp.raum);
  const horizon = parseHorizon(sp.jahre);
  const today = toBerlinDate(new Date());
  const r = await replacementReport(
    db,
    perms,
    {
      categoryId: category?.id,
      buildingId: building?.value,
      roomId: room?.value,
    },
    today,
    horizon,
  );
  const scope = [category?.name, building?.label, room ? `Raum ${room.value}` : null].filter(Boolean).join(" · ") || "gesamter Bestand";
  const back = new URLSearchParams(
    Object.entries({
      kategorie: category?.id,
      gebaeude: building?.value,
      raum: room?.value,
      jahre: String(horizon),
    }).filter((e): e is [string, string] => !!e[1]),
  );

  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-end gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/gebaeude/inventar/ersatzbedarf?${back}`}>Zurück zum Ersatzbedarf</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[190mm] flex-col gap-5">
        <DruckKopf eyebrow="Gebäude & Technik" title="Ersatzbedarf" subtitle={scope} stamp={`Stand ${formatDay(today)} · Vorausschau ${horizon} Jahre`} />
        <p className="text-sm">
          Ersatz fällig: {r.totals.faellig.pieces} Stück · {r.year + 1}–{r.year + horizon}: {r.totals.bald.pieces} Stück · ohne Anschaffungsdatum: {r.totals.ohne_datum.pieces} ·
          ohne Richtwert: {r.totals.ohne_richtwert.pieces}
          {r.values && ` · Anschaffungswert fällig ${formatPrice(r.totals.faellig.valueCents)}, Vorausschau ${formatPrice(r.totals.bald.valueCents)}`}
        </p>
        <p className="text-xs">Richtwert: Anschaffungsjahr + Nutzungsdauer der Kategorie – keine Abschreibung, kein Restwert.</p>
        <section aria-labelledby="d-kat" className="flex flex-col gap-2">
          <h2 id="d-kat" className="text-base font-semibold">
            Je Kategorie
          </h2>
          <div role="region" aria-label="Je Kategorie (Tabelle)" tabIndex={0} className="overflow-x-auto print:overflow-visible">
            <table className={TABLE}>
              <thead>
                <tr>
                  <th>Kategorie</th>
                  <th>Nutzungsdauer</th>
                  <th>Bestand (Stück)</th>
                  <th>fällig</th>
                  <th>bis {r.year + horizon}</th>
                  <th>ohne Datum</th>
                  {r.values && <th>Wert fällig + Vorausschau</th>}
                </tr>
              </thead>
              <tbody>
                {r.byCategory.map((c) => (
                  <tr key={c.categoryId} className="break-inside-avoid">
                    <td>{c.name}</td>
                    <td>{c.lifetimeYears ? `${c.lifetimeYears} Jahre` : "–"}</td>
                    <td>{c.total.pieces}</td>
                    <td>{c.faellig.pieces}</td>
                    <td>{c.bald.pieces}</td>
                    <td>{c.ohneDatum}</td>
                    {r.values && <td>{formatPrice((c.faellig.valueCents ?? 0) + (c.bald.valueCents ?? 0))}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section aria-labelledby="d-jahr" className="flex flex-col gap-2">
          <h2 id="d-jahr" className="text-base font-semibold">
            Je Jahr
          </h2>
          <div role="region" aria-label="Je Jahr (Tabelle)" tabIndex={0} className="overflow-x-auto print:overflow-visible">
            <table className={TABLE}>
              <thead>
                <tr>
                  <th>Jahr</th>
                  <th>Stück</th>
                  <th>Einträge</th>
                  {r.values && <th>Anschaffungswert</th>}
                </tr>
              </thead>
              <tbody>
                {r.byYear.map((y) => (
                  <tr key={y.year} className="break-inside-avoid">
                    <td>{y.overdue ? `bis ${y.year} (fällig)` : y.year}</td>
                    <td>{y.counts.pieces}</td>
                    <td>{y.counts.entries}</td>
                    {r.values && <td>{formatPrice(y.counts.valueCents)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        {r.items.length > 0 && (
          <section aria-labelledby="d-eintraege" className="flex flex-col gap-2">
            <h2 id="d-eintraege" className="text-base font-semibold">
              Einträge ({r.items.length})
            </h2>
            <div role="region" aria-label="Einträge (Tabelle)" tabIndex={0} className="overflow-x-auto print:overflow-visible">
              <table className={TABLE}>
                <thead>
                  <tr>
                    <th>Ersatz</th>
                    <th>Inventarnummer</th>
                    <th>Bezeichnung</th>
                    <th>Kategorie</th>
                    <th>Standort</th>
                    <th>Menge</th>
                    <th>angeschafft</th>
                    {r.values && <th>Preis</th>}
                  </tr>
                </thead>
                <tbody>
                  {r.items.map((i) => (
                    <tr key={i.id} className="break-inside-avoid">
                      <td>{i.state === "faellig" ? REPLACEMENT_STATE_LABELS.faellig : i.year}</td>
                      <td>{i.inventoryNo ?? "–"}</td>
                      <td>{i.name}</td>
                      <td>{i.categoryName}</td>
                      <td>{i.place}</td>
                      <td>{i.quantity}</td>
                      <td>{i.acquiredOn ? formatDay(i.acquiredOn) : "–"}</td>
                      {r.values && <td>{formatPrice(i.priceCents)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        <p className="text-xs">Erstellt mit SchulOS.</p>
      </main>
    </div>
  );
}
