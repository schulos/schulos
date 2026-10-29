import Link from "next/link";
import { Accessibility, Plus } from "lucide-react";
import { ROOM_KINDS, type RoomKind } from "@/core/db/schema";
import { ROOM_KIND_LABELS } from "@/core/labels";
import type { Db } from "@/core/db/client";
import { roomHref } from "@/core/room-href";
import { equipmentByRoom, equipmentLabel } from "@/modules/verwaltung/raumausstattung";
import { listRooms } from "@/modules/verwaltung/rooms";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Input, Select } from "@schulos/ui/field";
import { EmptyState } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";

export async function RoomsSection({ db, q, art }: { db: Db; q?: string; art?: string }) {
  const kind = (ROOM_KINDS as readonly string[]).includes(art ?? "") ? (art as RoomKind) : undefined;
  const list = await listRooms(db, { q, kind });
  const equipment = await equipmentByRoom(db, list.map((r) => r.id));
  return (
    <section aria-labelledby="ra" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="ra" className="font-display text-xl font-bold">
          Räume
        </h2>
        <span className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/verwaltung/stammdaten/raeume/gebaeude">Gebäude und Etagen</Link>
          </Button>
          <Button asChild>
            <Link href="/verwaltung/stammdaten/raeume/infofelder">Infofelder</Link>
          </Button>
          <Button asChild>
            <Link href="/verwaltung/stammdaten/raeume/ausstattung">Ausstattungskatalog</Link>
          </Button>
          <Button asChild variant="primary">
            <Link href="/verwaltung/stammdaten/raeume/neu">
              <Plus aria-hidden /> Raum anlegen
            </Link>
          </Button>
        </span>
      </div>
      <form role="search" className="grid gap-3 rounded-card border border-border bg-surface p-4 sm:grid-cols-[2fr_1fr_auto]">
        <input type="hidden" name="bereich" value="raeume" />
        <Input name="q" type="search" defaultValue={q} placeholder="Kürzel, Name oder Gebäude" aria-label="Suche" />
        <Select name="art" defaultValue={kind ?? ""} aria-label="Raumart">
          <option value="">Alle Raumarten</option>
          {ROOM_KINDS.map((k) => (
            <option key={k} value={k}>
              {ROOM_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
        <Button type="submit">Filtern</Button>
      </form>
      {list.length === 0 ? (
        <EmptyState title="Keine Räume gefunden" />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Raum</th>
              <th>Art</th>
              <th>Ort</th>
              <th className="text-right">Plätze</th>
              <th>Ausstattung</th>
              <th>
                <span className="sr-only">Aktionen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className={r.active ? undefined : "text-muted"}>
                <td>
                  <Link href={`/verwaltung/stammdaten/raeume/${encodeURIComponent(r.id)}`} className="font-medium hover:underline">
                    {r.id}
                  </Link>
                  {r.name !== r.id && <span className="text-muted"> · {r.name}</span>}
                  {!r.active && <Badge className="ml-2">inaktiv</Badge>}
                </td>
                <td>{ROOM_KIND_LABELS[r.kind]}</td>
                <td className="text-muted">
                  {[r.building, r.floor].filter(Boolean).join(" · ")}
                  {r.accessible && <Accessibility aria-label="barrierefrei" className="ml-1.5 inline size-4 align-text-bottom text-accent" />}
                </td>
                <td className="text-right tabular-nums">{r.capacity ?? "–"}</td>
                <td className="text-muted">{(equipment.get(r.id) ?? []).map(equipmentLabel).join(", ")}</td>
                <td className="text-right whitespace-nowrap">
                  <Button asChild size="sm" variant="ghost">
                    <Link href={roomHref(r.id)} aria-label={`Steckbrief Raum ${r.id}`}>
                      Steckbrief
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/verwaltung/stammdaten/raeume/${encodeURIComponent(r.id)}`} aria-label={`Raum ${r.id} bearbeiten`}>
                      Bearbeiten
                    </Link>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
