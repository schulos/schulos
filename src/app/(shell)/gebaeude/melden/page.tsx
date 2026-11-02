import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { rooms } from "@/core/db/schema";
import { createTicketAction } from "@/modules/gebaeude/actions";
import { ticketCategoryForAsset } from "@/modules/gebaeude/labels";
import { assetPlace, getAsset } from "@/modules/gebaeude/pruefungen";
import { canManage, canReport, openTicketCountForAsset } from "@/modules/gebaeude/service";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { ReportForm } from "./report-form";

export const metadata: Metadata = { title: "Mangel melden" };

/**
 * Mangel oder Störung melden – mit `?raum=112` aus Raumbelegung und Kursraum vorbelegt, mit `?asset=<id>` (INV-03, Asset-Seite bzw.
 * Etikett) für ein Inventargut: Raum, Meldungskategorie und Bezeichnung sind vorbelegt, die Meldung trägt den Bezug zum Gerät.
 */
export default async function MeldenPage({ searchParams }: { searchParams: Promise<{ raum?: string; asset?: string }> }) {
  const { perms } = await requireUser();
  if (!canReport(perms) && !canManage(perms)) notFound();
  const db = await getDb();
  const list = await db.select({ id: rooms.id, name: rooms.name, building: rooms.building }).from(rooms).where(eq(rooms.active, true)).orderBy(asc(rooms.id));
  const sp = await searchParams;
  const found = sp.asset ? await getAsset(db, perms, sp.asset) : null;
  const asset = found?.asset.active ? found : null;
  const openCount = asset ? await openTicketCountForAsset(db, asset.asset.id) : 0;
  const raum = asset ? (asset.asset.roomId ?? "") : (sp.raum ?? "");
  const options = list.map((r) => ({ value: r.id, label: [r.id === r.name ? `Raum ${r.id}` : `${r.id} – ${r.name}`, r.building].filter(Boolean).join(" · ") }));
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        eyebrow="Gebäude & Technik"
        title="Mangel melden"
        actions={
          <Link href="/gebaeude" className="text-sm font-medium text-accent-ink hover:underline">
            Zur Übersicht
          </Link>
        }
      />
      {asset && (
        <Card aria-labelledby="geraet">
          <h2 id="geraet" className="text-sm font-medium text-muted">
            Betroffenes Gerät
          </h2>
          <p className="font-medium">
            {asset.asset.name}
            {asset.full && asset.asset.inventoryNo && <span className="font-normal text-muted"> · {asset.asset.inventoryNo}</span>}
          </p>
          <p className="text-sm text-muted">
            {asset.asset.categoryName} · {assetPlace(asset.asset)}
          </p>
          {openCount > 0 && (
            <p role="note" className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
              Zu diesem Gerät {openCount === 1 ? "ist schon eine Meldung" : `sind schon ${openCount} Meldungen`} offen. Wenn es um denselben Mangel geht, ist er bereits bekannt.
            </p>
          )}
        </Card>
      )}
      {sp.asset && !asset && (
        <p role="status" className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
          Das Gerät ist nicht (mehr) im Inventar – bitte Raum oder Ort selbst angeben.
        </p>
      )}
      <Card>
        <ReportForm
          action={createTicketAction}
          rooms={options}
          initialRoom={list.some((r) => r.id === raum) ? raum : ""}
          asset={asset ? { id: asset.asset.id, title: asset.asset.name.slice(0, 100), category: ticketCategoryForAsset(asset.asset.categoryKey) } : undefined}
        />
      </Card>
    </main>
  );
}
