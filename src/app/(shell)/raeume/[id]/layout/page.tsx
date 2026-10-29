import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus, Printer } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { LAYOUTS_PER_ROOM_MAX, VARIANT_LABELS, capacityHint, variantCells } from "@/core/raumlayout-raster";
import { roomHref } from "@/core/room-href";
import { canEditRoomInfo } from "@/modules/verwaltung/raum-rechte";
import { canViewLayouts, listRoomLayouts } from "@/modules/verwaltung/raumlayout";
import { getRoom } from "@/modules/verwaltung/rooms";
import { LayoutGrid } from "@/ui/raumlayout";
import { roomTitle } from "@/ui/raum-steckbrief";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { cn } from "@schulos/ui/cn";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { LayoutActions } from "./layout-actions";
import { LayoutEditor } from "./layout-editor";

export const metadata: Metadata = { title: "Raumlayout" };
export const dynamic = "force-dynamic";

/**
 * RS-08 Raumlayout: Standard-Layout plus optional weitere benannte Layouts eines Raums. Sehen nur Beschäftigte; bearbeiten,
 * wer `canEditRoomInfo` erfüllt (Recht „Raumdaten pflegen“, `verwaltung.school`, Raumverantwortliche für den eigenen Raum).
 */
export default async function RaumLayoutPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ l?: string; neu?: string; gespeichert?: string }> }) {
  const { perms } = await requireUser();
  if (!canViewLayouts(perms)) notFound();
  const id = decodeURIComponent((await params).id);
  const sp = await searchParams;
  const db = await getDb();
  const room = await getRoom(db, id);
  if (!room) notFound();
  const [layouts, canEdit] = await Promise.all([listRoomLayouts(db, perms, room.id), canEditRoomInfo(db, perms, room.id)]);
  const list = layouts ?? [];
  const creating = canEdit && sp.neu === "1" && list.length < LAYOUTS_PER_ROOM_MAX;
  const selected = creating ? null : (list.find((l) => l.id === sp.l) ?? list[0] ?? null);
  const base = `${roomHref(room.id)}/layout`;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Raumsteckbrief · Layout"
        title={roomTitle(room)}
        actions={
          <>
            {selected && (
              <Button asChild variant="ghost">
                <Link href={`/druck/raum/${encodeURIComponent(room.id)}/layout?l=${encodeURIComponent(selected.id)}`}>
                  <Printer aria-hidden /> Drucken
                </Link>
              </Button>
            )}
            <Button asChild>
              <Link href={roomHref(room.id)}>Zum Steckbrief</Link>
            </Button>
          </>
        }
      />
      <p className="max-w-3xl text-sm text-muted">
        Layouts sehen nur Beschäftigte. Die Plätze sind leer – Namen stehen erst im Sitzplan der Lehrkraft, der ein Layout beim Anlegen als
        Kopie übernimmt. Die Platzzahl in den Stammdaten ändert sich nie automatisch.
      </p>
      {sp.gespeichert && (
        <p role="status" className="rounded-lg bg-success-soft px-4 py-2 text-sm text-success">
          Layout angelegt.
        </p>
      )}

      {(list.length > 0 || canEdit) && (
        <nav aria-label="Layouts des Raums" className="flex flex-wrap items-center gap-2">
          {list.map((l) => (
            <Link
              key={l.id}
              href={`${base}?l=${encodeURIComponent(l.id)}`}
              aria-current={selected?.id === l.id ? "page" : undefined}
              className={cn(
                "flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm",
                selected?.id === l.id ? "bg-accent-soft font-semibold text-accent-ink" : "bg-surface hover:bg-surface-2",
              )}
            >
              {l.name}
              {l.isDefault && l.name.toLowerCase() !== "standard" && <Badge tone="neutral">Standard</Badge>}
            </Link>
          ))}
          {canEdit && list.length < LAYOUTS_PER_ROOM_MAX && (
            <Button asChild size="sm" variant={creating ? "primary" : "ghost"}>
              <Link href={`${base}?neu=1`} aria-current={creating ? "page" : undefined}>
                <Plus aria-hidden /> Neues Layout
              </Link>
            </Button>
          )}
        </nav>
      )}

      {creating ? (
        <Card aria-labelledby="neu">
          <CardHeader title={<span id="neu">Neues Layout</span>} />
          <LayoutEditor
            roomId={room.id}
            layoutId={null}
            capacity={room.capacity}
            initial={{ name: list.length === 0 ? "Standard" : "", variant: "reihen", rows: 6, cols: 8, cells: variantCells("reihen", 6, 8) }}
          />
        </Card>
      ) : selected ? (
        <Card aria-labelledby="layout">
          <CardHeader title={<span id="layout">{selected.name}</span>} />
          <p className="mb-3 text-sm text-muted" data-testid="layout-fakten">
            {[
              selected.isDefault ? "Standard-Layout" : null,
              `Variante ${VARIANT_LABELS[selected.variant]}`,
              `Raster ${selected.rows} × ${selected.cols}`,
              `${selected.seats} ${selected.seats === 1 ? "Platz" : "Plätze"}`,
              `${selected.examSeats} Prüfungsplätze`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {canEdit ? (
            <div className="flex flex-col gap-4">
              <LayoutActions roomId={room.id} layoutId={selected.id} name={selected.name} isDefault={selected.isDefault} />
              <LayoutEditor
                key={`${selected.id}-${selected.updatedAt.getTime()}`}
                roomId={room.id}
                layoutId={selected.id}
                capacity={room.capacity}
                initial={{ name: selected.name, variant: selected.variant, rows: selected.rows, cols: selected.cols, cells: selected.cells }}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="rounded-lg bg-surface-2 py-1 text-center text-xs font-medium text-muted" aria-hidden>
                vorn
              </div>
              <LayoutGrid rows={selected.rows} cols={selected.cols} cells={selected.cells} caption={`Raumlayout ${selected.name}, Raum ${room.id}`} />
              {capacityHint(selected.seats, room.capacity) && <p className="text-sm text-muted">{capacityHint(selected.seats, room.capacity)}</p>}
            </div>
          )}
        </Card>
      ) : (
        <EmptyState title="Noch kein Layout">
          {canEdit ? "Mit „Neues Layout“ legst du das Standard-Layout an." : "Für diesen Raum ist noch kein Layout eingetragen."}
        </EmptyState>
      )}
    </main>
  );
}
