import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ } from "@/core/time";
import { adoptInventoryItemAction, setInventoryItemAction } from "@/modules/gebaeude/actions";
import { canConfigure } from "@/modules/gebaeude/inventar";
import { canReadInventories, canRunInventory, getInventory, INVENTORY_MAX_COUNT, type InventoryItemRow } from "@/modules/gebaeude/inventur";
import { INVENTORY_ITEM_STATE_LABELS, type InventoryItemState } from "@/modules/gebaeude/labels";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { Input } from "@schulos/ui/field";
import { PageHeader, Progress } from "@schulos/ui/misc";
import { GebaeudeNav } from "../../ui";
import { CloseInventory, DeleteInventory, ScanBox } from "./forms";

export const metadata: Metadata = { title: "Inventur" };

const when = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const STATE_TONE: Record<InventoryItemState, "neutral" | "soft" | "warn" | "success" | "danger"> = {
  offen: "neutral",
  gefunden: "success",
  fehlt: "danger",
  falscher_raum: "warn",
  umgezogen: "soft",
};

function ItemActions({ i }: { i: InventoryItemRow }) {
  const label = `${i.inventoryNo ? `${i.inventoryNo} ` : ""}${i.name}`;
  if (i.state === "falscher_raum")
    return (
      <div className="flex flex-wrap gap-2">
        {i.assetId && (
          <form action={adoptInventoryItemAction.bind(null, i.id)}>
            <Button type="submit" size="md" aria-label={`Hierher umziehen: ${label}`}>
              Hierher umziehen
            </Button>
          </form>
        )}
        <form action={setInventoryItemAction.bind(null, i.id, "offen")}>
          <Button type="submit" variant="ghost" aria-label={`Zurücknehmen: ${label}`}>
            Zurücknehmen
          </Button>
        </form>
      </div>
    );
  if (i.state === "umgezogen") return null;
  if (i.state !== "offen")
    return (
      <form action={setInventoryItemAction.bind(null, i.id, "offen")}>
        <Button type="submit" variant="ghost" aria-label={`Zurücksetzen: ${label}`}>
          Zurücksetzen
        </Button>
      </form>
    );
  return (
    <div className="flex flex-wrap items-end gap-2">
      <form action={setInventoryItemAction.bind(null, i.id, "gefunden")} className="flex flex-wrap items-end gap-2">
        {i.quantity > 1 && (
          <label className="flex flex-col gap-1 text-sm">
            <span>gezählt (Soll {i.quantity})</span>
            <Input name="counted" type="number" inputMode="numeric" min={0} max={INVENTORY_MAX_COUNT} defaultValue={i.quantity} className="w-28" />
          </label>
        )}
        <Button type="submit" variant="primary" aria-label={`${i.quantity > 1 ? "Gezählt" : "Gefunden"}: ${label}`}>
          {i.quantity > 1 ? "Gezählt" : "Gefunden"}
        </Button>
      </form>
      <form action={setInventoryItemAction.bind(null, i.id, "fehlt")}>
        <Button type="submit" aria-label={`Fehlt: ${label}`}>
          Fehlt
        </Button>
      </form>
    </div>
  );
}

/**
 * INV-04 Inventur eines Raums, mobil zuerst: Fortschritt, Erfassen (Eingabe, In-App-Scan wenn der Browser es kann), Liste der
 * Posten mit Knöpfen (gefunden/fehlt, Sammelposten mit Menge, Gerät aus anderem Raum übernehmen), Protokoll als CSV und Druck.
 */
export default async function InventurDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  if (!canReadInventories(perms)) notFound();
  const { id } = await params;
  const inv = await getInventory(await getDb(), perms, id);
  if (!inv) notFound();
  const s = inv.summary;
  const running = !inv.closedAt;
  const run = canRunInventory(perms) && running;
  const pct = s.expected === 0 ? 100 : (s.done / s.expected) * 100;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow={running ? "Inventur läuft" : "Inventur abgeschlossen"} title={inv.roomLabel} />
      <GebaeudeNav current="inventar" configure={canConfigure(perms)} />
      <Card aria-labelledby="stand">
        <CardHeader title={<span id="stand">Stand</span>} />
        <p className="text-sm">
          <strong className="text-base tabular-nums">
            {s.done} von {s.expected}
          </strong>{" "}
          Soll-Posten erfasst
        </p>
        <Progress value={pct} label={`${s.done} von ${s.expected} erfasst`} />
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="success">{s.found} gefunden</Badge>
          {s.open > 0 && <Badge tone="neutral">{s.open} offen</Badge>}
          {s.missing > 0 && <Badge tone="danger">{s.missing} fehlen</Badge>}
          {s.wrongRoom > 0 && <Badge tone="warn">{s.wrongRoom} falscher Raum</Badge>}
          {s.moved > 0 && <Badge tone="soft">{s.moved} umgezogen</Badge>}
          {s.short > 0 && <Badge tone="warn">{s.short} Sammelposten mit Fehlmenge</Badge>}
        </div>
        <p className="text-xs text-muted">
          begonnen {when.format(inv.startedAt)}
          {inv.closedAt && ` · abgeschlossen ${when.format(inv.closedAt)}`}
        </p>
      </Card>

      {run && (
        <Card aria-labelledby="erfassen">
          <CardHeader title={<span id="erfassen">Erfassen</span>} />
          <p className="text-sm text-muted">
            Etikett mit der Kamera-App scannen und auf der Geräteseite „gefunden“ tippen – oder hier den Code bzw. die Inventarnummer eingeben (auch mit
            einem Handscanner).
          </p>
          <ScanBox inventoryId={inv.id} />
        </Card>
      )}

      <section aria-labelledby="posten" className="flex flex-col gap-2">
        <h2 id="posten" className="font-display text-lg font-semibold">
          Posten
        </h2>
        {inv.items.length === 0 ? (
          <p className="text-sm text-muted">In diesem Raum steht laut Inventar nichts. Gescannte Geräte erscheinen hier.</p>
        ) : (
          <ul aria-label="Posten der Inventur" className="flex flex-col gap-2">
            {inv.items.map((i) => (
              <li key={i.id} className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {i.assetId ? (
                      <Link href={`/gebaeude/inventar/${encodeURIComponent(i.assetId)}`} className="font-medium text-accent-ink hover:underline">
                        {i.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{i.name}</span>
                    )}
                    <Badge tone={STATE_TONE[i.state]}>{INVENTORY_ITEM_STATE_LABELS[i.state]}</Badge>
                  </span>
                  <span className="text-xs text-muted">
                    {[
                      i.inventoryNo ?? "ohne Nummer",
                      i.categoryName,
                      i.quantity > 1 ? `Soll ${i.quantity}${i.counted !== null ? ` · gezählt ${i.counted}` : ""}` : null,
                      i.state === "falscher_raum" ? (i.homeRoomId ? `gehört in Raum ${i.homeRoomId}` : "ohne Raum im Inventar") : null,
                      !i.expected && i.state !== "falscher_raum" ? "nicht im Soll" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                {run && <ItemActions i={i} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card aria-labelledby="protokoll">
        <CardHeader title={<span id="protokoll">Protokoll</span>} />
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary">
            <a href={`/api/gebaeude/inventur/${encodeURIComponent(inv.id)}`}>CSV herunterladen</a>
          </Button>
          <Button asChild variant="secondary">
            <Link href={`/druck/inventur/${encodeURIComponent(inv.id)}`}>Druckansicht</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/gebaeude/inventur">Alle Inventuren</Link>
          </Button>
        </div>
        {(run || (!running && canConfigure(perms))) && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            {run && <CloseInventory id={inv.id} open={s.open} />}
            <DeleteInventory id={inv.id} closed={!running} />
          </div>
        )}
        {running && <p className="text-xs text-muted">Beim Abschluss wird alles Offene als „fehlt“ eingetragen. Das Inventar selbst ändert sich dabei nicht.</p>}
      </Card>
    </main>
  );
}
