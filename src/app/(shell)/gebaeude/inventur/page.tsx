import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ } from "@/core/time";
import { startInventoryAction } from "@/modules/gebaeude/actions";
import { canConfigure } from "@/modules/gebaeude/inventar";
import { canReadInventories, canRunInventory, listInventories, type InventoryRow } from "@/modules/gebaeude/inventur";
import { roomOptions } from "@/modules/gebaeude/pruefungen";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { SpecForm } from "@/ui/spec-form";
import { GebaeudeNav } from "../ui";

export const metadata: Metadata = { title: "Inventur" };

const when = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });

function InventoryItem({ i }: { i: InventoryRow }) {
  const s = i.summary;
  return (
    <Link
      href={`/gebaeude/inventur/${encodeURIComponent(i.id)}`}
      className="flex flex-col gap-1 rounded-xl border border-border bg-surface px-3 py-2.5 hover:ring-1 hover:ring-border-strong"
      aria-label={`Inventur ${i.roomLabel}${i.closedAt ? ", abgeschlossen" : ", läuft"}`}
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{i.roomLabel}</span>
        {i.closedAt ? <Badge tone="neutral">abgeschlossen</Badge> : <Badge tone="soft">läuft</Badge>}
        {s.missing > 0 && <Badge tone="danger">{s.missing} fehlen</Badge>}
        {s.wrongRoom > 0 && <Badge tone="warn">{s.wrongRoom} falscher Raum</Badge>}
      </span>
      <span className="text-xs text-muted">
        {s.done} von {s.expected} erfasst · begonnen {when.format(i.startedAt)}
        {i.closedAt && ` · abgeschlossen ${when.format(i.closedAt)}`}
      </span>
    </Link>
  );
}

/**
 * INV-04 Inventur: Raum wählen und starten (Soll = Inventar des Raums), laufende und abgeschlossene Inventuren. Durchführen mit
 * `gebaeude.inventory`/`configure`, lesen auch mit `view_all`.
 */
export default async function InventurPage({ searchParams }: { searchParams: Promise<{ geloescht?: string }> }) {
  const { perms } = await requireUser();
  if (!canReadInventories(perms)) notFound();
  const db = await getDb();
  const sp = await searchParams;
  const run = canRunInventory(perms);
  const [list, rooms] = await Promise.all([listInventories(db, perms, { limit: 100 }), run ? roomOptions(db) : []]);
  const open = list.filter((i) => !i.closedAt);
  const closed = list.filter((i) => i.closedAt);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Gebäude & Technik" title="Inventur" />
      <GebaeudeNav current="inventar" configure={canConfigure(perms)} />
      {sp.geloescht === "1" && (
        <p role="status" className="text-sm text-muted">
          Inventur gelöscht.
        </p>
      )}
      {run && (
        <Card aria-labelledby="starten">
          <CardHeader title={<span id="starten">Inventur starten</span>} />
          <p className="text-sm text-muted">
            Soll ist das Inventar, das beim Start in diesem Raum steht. Erfassen per Etikett: QR-Code mit der Kamera-App des Handys scannen – auf der
            Geräteseite „gefunden“ tippen. Oder auf der Inventurseite scannen bzw. die Inventarnummer eingeben.
          </p>
          <SpecForm
            action={startInventoryAction}
            label="Inventur starten"
            submit="Starten"
            columns={1}
            fields={[{ name: "roomId", label: "Raum", type: "select", required: true, options: [{ value: "", label: "Raum wählen" }, ...rooms] }]}
          />
        </Card>
      )}
      <section aria-labelledby="laufend" className="flex flex-col gap-2">
        <h2 id="laufend" className="font-display text-lg font-semibold">
          Laufende Inventuren
        </h2>
        {open.length === 0 ? (
          <p className="text-sm text-muted">Keine Inventur läuft.</p>
        ) : (
          <ul aria-label="Laufende Inventuren" className="flex flex-col gap-2">
            {open.map((i) => (
              <li key={i.id}>
                <InventoryItem i={i} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="abgeschlossen" className="flex flex-col gap-2">
        <h2 id="abgeschlossen" className="font-display text-lg font-semibold">
          Abgeschlossen
        </h2>
        {closed.length === 0 ? (
          <EmptyState title="Noch keine abgeschlossene Inventur" />
        ) : (
          <ul aria-label="Abgeschlossene Inventuren" className="flex flex-col gap-2">
            {closed.map((i) => (
              <li key={i.id}>
                <InventoryItem i={i} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
