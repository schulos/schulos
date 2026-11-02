import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { TZ } from "@/core/time";
import { canReadInventories, getInventory } from "@/modules/gebaeude/inventur";
import { INVENTORY_ITEM_STATE_LABELS } from "@/modules/gebaeude/labels";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Inventurprotokoll drucken" };

const when = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });

/** INV-04: Inventurprotokoll eines Raums als Druckansicht (Nachweis für den Schulträger) – ohne Namen der Erfassenden. */
export default async function InventurDruckPage({ params }: { params: Promise<{ id: string }> }) {
  await requireModulePage("gebaeude");
  const { perms } = await requireUser();
  if (!canReadInventories(perms)) notFound();
  const { id } = await params;
  const inv = await getInventory(await getDb(), perms, id);
  if (!inv) notFound();
  const s = inv.summary;

  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-end gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/gebaeude/inventur/${encodeURIComponent(inv.id)}`}>Zurück zur Inventur</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[190mm] flex-col gap-5">
        <DruckKopf
          eyebrow="Gebäude & Technik"
          title="Inventurprotokoll"
          subtitle={inv.roomLabel}
          stamp={`begonnen ${when.format(inv.startedAt)}${inv.closedAt ? ` · abgeschlossen ${when.format(inv.closedAt)}` : " · noch nicht abgeschlossen"}`}
        />
        <p className="text-sm">
          Soll-Posten: {s.expected} · erfasst: {s.done} · gefunden: {s.found} · fehlen: {s.missing}
          {s.open > 0 && ` · offen: ${s.open}`} · falscher Raum: {s.wrongRoom}
          {s.moved > 0 && ` · umgezogen: ${s.moved}`}
          {s.lent > 0 && ` · verliehen: ${s.lent}`}
          {s.short > 0 && ` · Sammelposten mit Fehlmenge: ${s.short}`}
        </p>
        {inv.items.length === 0 ? (
          <p className="text-sm">Keine Posten.</p>
        ) : (
          <div role="region" aria-label="Posten" tabIndex={0} className="overflow-x-auto print:overflow-visible">
            <table className="w-full border-collapse text-left text-sm [&_td]:border [&_td]:border-border-strong [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border-strong [&_th]:px-2 [&_th]:py-1 [&_th]:text-xs">
              <thead>
                <tr>
                  <th>Inventarnummer</th>
                  <th>Bezeichnung</th>
                  <th>Kategorie</th>
                  <th>Soll</th>
                  <th>Ist</th>
                  <th>Stand</th>
                  <th>Bemerkung</th>
                </tr>
              </thead>
              <tbody>
                {inv.items.map((i) => (
                  <tr key={i.id} className="break-inside-avoid">
                    <td>{i.inventoryNo ?? "–"}</td>
                    <td>{i.name}</td>
                    <td>{i.categoryName}</td>
                    <td>{i.expected ? i.quantity : "–"}</td>
                    <td>{i.counted ?? (i.state === "gefunden" || i.state === "umgezogen" || i.state === "falscher_raum" ? i.quantity : i.state === "fehlt" ? 0 : "")}</td>
                    <td>
                      <strong>{INVENTORY_ITEM_STATE_LABELS[i.state]}</strong>
                    </td>
                    <td>
                      {i.state === "falscher_raum" || i.state === "umgezogen"
                        ? i.homeRoomId
                          ? `laut Inventar Raum ${i.homeRoomId}`
                          : "laut Inventar ohne Raum"
                        : !i.expected
                          ? "nicht im Soll"
                          : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-6 grid grid-cols-2 gap-8 text-xs">
          <p className="border-t border-border-strong pt-1">Datum, Unterschrift (durchgeführt)</p>
          <p className="border-t border-border-strong pt-1">Datum, Unterschrift (geprüft)</p>
        </div>
        <p className="text-xs">Erstellt mit SchulOS.</p>
      </main>
    </div>
  );
}
