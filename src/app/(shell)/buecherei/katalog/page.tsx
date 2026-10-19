import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { CATALOG_LIMIT, canUse, searchCatalog } from "@/modules/buecherei/katalog";
import { MEDIA_TYPE_LABELS, MEDIA_TYPES, type MediaType } from "@/modules/buecherei/labels";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { AvailabilityBadge, BuechereiNav } from "../ui";
import { CatalogSearch } from "./catalog-search";

export const metadata: Metadata = { title: "Bücherei-Katalog" };

type Search = { q?: string; art?: string };

const MEDIA_OPTIONS = MEDIA_TYPES.map((k) => ({ value: k, label: MEDIA_TYPE_LABELS[k] }));

/** Katalog (BU-03, Recht `buecherei.use`): Titel suchen, Verfügbarkeit sehen, zum Vormerken auf die Titelseite. */
export default async function KatalogPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  if (!canUse(perms)) notFound();
  const sp = await searchParams;
  const mediaType = MEDIA_TYPES.find((k): k is MediaType => k === sp.art);
  const q = sp.q?.trim() ?? "";
  const titles = await searchCatalog(await getDb(), perms, { q, mediaType });
  const filtered = !!(q || mediaType);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Bücherei" title="Katalog" />
      <BuechereiNav current="katalog" perms={perms} />
      <CatalogSearch q={q} art={mediaType ?? ""} options={MEDIA_OPTIONS} />
      {titles.length === 0 ? (
        <EmptyState title={filtered ? "Nichts gefunden" : "Noch kein Bestand"}>{filtered ? "Andere Suchbegriffe versuchen." : "Die Bücherei hat noch keine Titel erfasst."}</EmptyState>
      ) : (
        <>
          <Table>
            <caption className="sr-only">Titel im Katalog</caption>
            <thead>
              <tr>
                <th>Titel</th>
                <th>Autor:in</th>
                <th>Medienart</th>
                <th>Verfügbar</th>
              </tr>
            </thead>
            <tbody>
              {titles.map((t) => (
                <tr key={t.id}>
                  <td className="font-medium">
                    <Link href={`/buecherei/katalog/${t.id}`} className="hover:underline">
                      {t.title}
                    </Link>
                    {t.year && <span className="text-muted"> ({t.year})</span>}
                    {t.ageFrom !== null && <span className="block text-xs text-muted">ab {t.ageFrom} Jahren</span>}
                  </td>
                  <td>{t.author ?? "–"}</td>
                  <td>{MEDIA_TYPE_LABELS[t.mediaType]}</td>
                  <td>
                    <AvailabilityBadge t={t} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {titles.length >= CATALOG_LIMIT && <p className="text-sm text-muted">Nur die ersten {CATALOG_LIMIT} Treffer – bitte die Suche verfeinern.</p>}
        </>
      )}
    </main>
  );
}
