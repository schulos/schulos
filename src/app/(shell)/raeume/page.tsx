import type { Metadata } from "next";
import Link from "next/link";
import { Accessibility, Printer } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { ROOM_KIND_LABELS } from "@/core/labels";
import { roomHref } from "@/core/room-href";
import { placeOptions } from "@/modules/verwaltung/gebaeude-etagen";
import { roomDirectory } from "@/modules/verwaltung/raumsteckbrief";
import { canPrintDoorSigns } from "@/modules/verwaltung/tuer-qr";
import { roomPhotoSrc } from "@/ui/raum-steckbrief";
import { Button } from "@schulos/ui/button";
import { Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Räume" };

type Room = Awaited<ReturnType<typeof roomDirectory>>[number];

/**
 * RS-02/RS-10: Raumliste und Raumfinder für alle Angemeldeten – nur Stammdaten ohne Belegung, je Raum ein Link auf den
 * Steckbrief, mit Titelbild (RS-04). Gruppiert und filterbar nach Gebäude und Etage (Stammdaten, Reihenfolge der Verwaltung).
 */
export default async function RaeumeListePage({ searchParams }: { searchParams: Promise<{ q?: string; gebaeude?: string; etage?: string }> }) {
  const { perms } = await requireUser();
  const sp = await searchParams;
  const db = await getDb();
  const places = await placeOptions(db);
  const building = places.find((b) => b.id === sp.gebaeude) ?? null;
  // Etage nur innerhalb des gewählten Gebäudes (bzw. irgendeines, wenn keins gewählt ist)
  const floorOwner = places.find((b) => b.floors.some((f) => f.id === sp.etage) && (!building || b.id === building.id)) ?? null;
  const floor = floorOwner?.floors.find((f) => f.id === sp.etage) ?? null;
  const [list, printable] = await Promise.all([
    roomDirectory(db, sp.q, 500, { buildingId: (building ?? floorOwner)?.id, floorId: floor?.id }),
    canPrintDoorSigns(db, perms),
  ]);
  // Gruppen: Gebäude → Etage (Reihenfolge kommt sortiert aus roomDirectory)
  const groups: { key: string; building: string; floors: { key: string; floor: string | null; rooms: Room[] }[] }[] = [];
  for (const r of list) {
    const bKey = r.buildingId ?? "-";
    let g = groups.find((x) => x.key === bKey);
    if (!g) groups.push((g = { key: bKey, building: r.building ?? "Ohne Gebäude", floors: [] }));
    const fKey = r.floorId ?? "-";
    let f = g.floors.find((x) => x.key === fKey);
    if (!f) g.floors.push((f = { key: fKey, floor: r.floor, rooms: [] }));
    f.rooms.push(r);
  }
  const filtered = Boolean(sp.q?.trim() || building || floor);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Organisation"
        title="Räume"
        actions={
          printable ? (
            <Button asChild variant="ghost">
              <Link href="/raeume/tuerschilder">
                <Printer aria-hidden /> Türschilder drucken
              </Link>
            </Button>
          ) : undefined
        }
      />
      <form role="search" aria-label="Raumfinder" className="grid gap-3 rounded-card border border-border bg-surface p-4 sm:grid-cols-[2fr_1fr_1fr_auto]">
        <Input name="q" type="search" defaultValue={sp.q} placeholder="Kürzel oder Name" aria-label="Raum suchen" className="min-w-0" />
        {places.length > 0 && (
          <>
            <Select name="gebaeude" defaultValue={building?.id ?? ""} aria-label="Gebäude">
              <option value="">Alle Gebäude</option>
              {places.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
            <Select name="etage" defaultValue={floor?.id ?? ""} aria-label="Etage">
              <option value="">Alle Etagen</option>
              {(building ? [building] : places)
                .filter((b) => b.floors.length > 0)
                .map((b) => (
                  <optgroup key={b.id} label={b.name}>
                    {b.floors.map((f) => (
                      <option key={f.id} value={f.id}>
                        {building ? f.name : `${b.name} · ${f.name}`}
                      </option>
                    ))}
                  </optgroup>
                ))}
            </Select>
          </>
        )}
        <Button type="submit">Suchen</Button>
      </form>
      {filtered && (
        <p className="text-sm text-muted" role="status">
          {list.length === 1 ? "1 Raum" : `${list.length} Räume`}
          {building && ` in ${building.name}`}
          {floor && ` · ${floor.name}`} ·{" "}
          <Link href="/raeume" className="font-medium text-accent-ink hover:underline">
            Filter zurücksetzen
          </Link>
        </p>
      )}
      {list.length === 0 ? (
        <EmptyState title="Keine Räume gefunden" />
      ) : (
        groups.map((g) => (
          <section key={g.key} aria-label={g.building} className="flex flex-col gap-3">
            <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{g.building}</h2>
            {g.floors.map((f) => (
              <div key={f.key} className="flex flex-col gap-2">
                {f.floor && <h3 className="text-sm font-semibold">{f.floor}</h3>}
                <ul aria-label={f.floor ? `${g.building}, ${f.floor}` : g.building} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {f.rooms.map((r) => (
                    <li key={r.id}>
                      <Link href={roomHref(r.id)} className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3 hover:bg-surface-2">
                        {r.coverId && (
                          // eslint-disable-next-line @next/next/no-img-element -- geschützte Route mit Sitzung, keine Bildoptimierung
                          <img src={roomPhotoSrc(r.coverId, true)} alt="" loading="lazy" className="size-12 shrink-0 rounded-md border border-border bg-surface-2 object-cover" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="font-semibold">{r.id}</span>
                          {r.name !== r.id && r.name !== `Raum ${r.id}` && <span className="text-muted"> · {r.name}</span>}
                          <span className="block text-xs text-muted">
                            {[ROOM_KIND_LABELS[r.kind], r.floor, r.capacity ? `${r.capacity} Plätze` : null].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        {r.accessible && <Accessibility aria-label="barrierefrei" className="size-4 shrink-0 text-accent" />}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))
      )}
    </main>
  );
}
