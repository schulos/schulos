import type { Metadata } from "next";
import Link from "next/link";
import { Accessibility } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { ROOM_KIND_LABELS } from "@/core/labels";
import { roomHref } from "@/core/room-href";
import { roomDirectory } from "@/modules/verwaltung/raumsteckbrief";
import { roomPhotoSrc } from "@/ui/raum-steckbrief";
import { Button } from "@schulos/ui/button";
import { Input } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Räume" };

/** RS-02: Raumliste für alle Angemeldeten – nur Stammdaten ohne Belegung, je Raum ein Link auf den Steckbrief; mit Titelbild (RS-04). */
export default async function RaeumeListePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireUser();
  const { q } = await searchParams;
  const list = await roomDirectory(await getDb(), q);
  const byBuilding = new Map<string, typeof list>();
  for (const r of list) {
    const key = r.building ?? "Ohne Gebäude";
    byBuilding.set(key, [...(byBuilding.get(key) ?? []), r]);
  }
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Organisation" title="Räume" />
      <form role="search" className="flex max-w-xl flex-wrap gap-2">
        <Input name="q" type="search" defaultValue={q} placeholder="Kürzel oder Name" aria-label="Raum suchen" className="min-w-0 flex-1" />
        <Button type="submit">Suchen</Button>
      </form>
      {list.length === 0 ? (
        <EmptyState title="Keine Räume gefunden" />
      ) : (
        [...byBuilding].map(([building, rooms]) => (
          <section key={building} aria-label={building} className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{building}</h2>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {rooms.map((r) => (
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
          </section>
        ))
      )}
    </main>
  );
}
