import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { ELEMENT_LABELS, LAYOUT_ELEMENTS, VARIANT_LABELS } from "@/core/raumlayout-raster";
import { roomHref } from "@/core/room-href";
import { TZ } from "@/core/time";
import { canViewLayouts, listRoomLayouts } from "@/modules/verwaltung/raumlayout";
import { getRoom } from "@/modules/verwaltung/rooms";
import { DruckKopf } from "@/ui/druck-kopf";
import { LayoutGrid } from "@/ui/raumlayout";
import { roomTitle } from "@/ui/raum-steckbrief";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";

export const metadata: Metadata = { title: "Raumlayout drucken" };

const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });

/** RS-08: Raumlayout drucken (A4 quer) – nur Beschäftigte, wie die Seite; Plätze sind leer. */
export default async function RaumLayoutDruckPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ l?: string }> }) {
  const { perms } = await requireUser();
  if (!canViewLayouts(perms)) notFound();
  const id = decodeURIComponent((await params).id);
  const sp = await searchParams;
  const db = await getDb();
  const room = await getRoom(db, id);
  if (!room) notFound();
  const list = (await listRoomLayouts(db, perms, room.id)) ?? [];
  const layout = list.find((l) => l.id === sp.l) ?? list[0];
  if (!layout) notFound();
  const used = LAYOUT_ELEMENTS.filter((e) => Object.values(layout.cells).includes(e));
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-end gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`${roomHref(room.id)}/layout?l=${encodeURIComponent(layout.id)}`}>Zurück zum Layout</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[277mm] flex-col gap-4">
        <DruckKopf
          eyebrow="Raumlayout"
          title={`${roomTitle(room)} – ${layout.name}`}
          subtitle={`Variante ${VARIANT_LABELS[layout.variant]} · ${layout.seats} Plätze · ${layout.examSeats} Prüfungsplätze`}
          stamp={`Stand ${stamp.format(new Date())}`}
        />
        <div className="rounded border border-ink/40 py-1 text-center text-sm font-medium">vorn</div>
        <LayoutGrid rows={layout.rows} cols={layout.cols} cells={layout.cells} caption={`Raumlayout ${layout.name}, Raum ${room.id}`} print />
        {used.length > 0 && <p className="text-sm">Elemente: {used.map((e) => ELEMENT_LABELS[e]).join(", ")}</p>}
      </main>
    </div>
  );
}
