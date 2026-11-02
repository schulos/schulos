import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { labelUrl, qrSvg } from "@/core/etiketten/qr";
import { roomHref } from "@/core/room-href";
import { toBerlinDate } from "@/core/time";
import { setAssetActiveAction, updateAssetAction } from "@/modules/gebaeude/actions";
import { assetCode } from "@/modules/gebaeude/etiketten";
import { canConfigure, listCategories, maintainableCategories } from "@/modules/gebaeude/inventar";
import { CONDITION_LABELS, formatPrice } from "@/modules/gebaeude/labels";
import { assetPlace, buildingOptions, floorOptions, formatDay, getAsset, roomOptions } from "@/modules/gebaeude/pruefungen";
import { canReport } from "@/modules/gebaeude/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { SpecForm } from "@/ui/spec-form";
import { GebaeudeNav } from "../../ui";
import { assetFields } from "../asset-form";
import { DeleteAsset, RenewAssetCode } from "./forms";

export const metadata: Metadata = { title: "Inventar" };

/**
 * INV-02 Asset-Seite (Ziel von `/i/<code>`): Pflegende und `view_all` sehen alle Angaben, Formular, Etikett-Code und
 * Ausmusterung; alle anderen Angemeldeten nur Bezeichnung, Kategorie, Standort und „Mangel melden“ (inv-5). Keine
 * Seriennummern, Preise oder Finanzierung in der eingeschränkten Sicht.
 */
export default async function InventarDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ angelegt?: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const r = await getAsset(db, perms, id);
  if (!r) notFound();
  const base = r.asset;
  const report = canReport(perms) && base.active;
  const place = assetPlace(base);

  if (!r.full) {
    const a = base;
    return (
      <main className="flex max-w-2xl flex-col gap-6">
        <PageHeader eyebrow="Inventar" title={a.name} />
        <Card>
          <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted">Kategorie</dt>
            <dd>{a.categoryName}</dd>
            <dt className="text-muted">Standort</dt>
            <dd>{a.roomId ? <Link href={roomHref(a.roomId)} className="text-accent-ink hover:underline">{place}</Link> : place}</dd>
            {a.quantity > 1 && (
              <>
                <dt className="text-muted">Menge</dt>
                <dd>{a.quantity}</dd>
              </>
            )}
          </dl>
        </Card>
        {report && (
          <div>
            <Button asChild variant="primary">
              <Link href={`/gebaeude/melden${a.roomId ? `?raum=${encodeURIComponent(a.roomId)}` : ""}`}>Mangel melden</Link>
            </Button>
          </div>
        )}
      </main>
    );
  }

  const a = r.asset;
  const configure = canConfigure(perms);
  const [categories, rooms, buildings, floors, own, code] = await Promise.all([
    listCategories(db),
    r.maintain ? roomOptions(db) : [],
    r.maintain ? buildingOptions(db) : [],
    r.maintain ? floorOptions(db) : [],
    maintainableCategories(db, perms),
    r.maintain ? assetCode(db, perms, a.id, a.categoryId) : null,
  ]);
  const formCategories = categories.filter((c) => (c.active || c.id === a.categoryId) && (own === null || own.has(c.id))).map((c) => ({ value: c.id, label: c.name }));
  const today = toBerlinDate(new Date());
  const row = (label: string, value: React.ReactNode) =>
    value === null || value === undefined || value === "" ? null : (
      <>
        <dt className="text-muted">{label}</dt>
        <dd>{value}</dd>
      </>
    );

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow={`Inventar · ${a.inventoryNo ?? "ohne Nummer"}`} title={a.name} />
      <GebaeudeNav current="inventar" configure={configure} />
      {sp.angelegt === "1" && (
        <p role="status" className="text-sm text-muted">
          Angelegt – Inventarnummer {a.inventoryNo}. Passende Prüfungen sind geplant.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!a.active && <Badge tone="neutral">ausgemustert{a.retiredOn ? ` am ${formatDay(a.retiredOn)}` : ""}</Badge>}
        {a.condition && <Badge tone={a.condition === "defekt" ? "danger" : "soft"}>{CONDITION_LABELS[a.condition]}</Badge>}
        {a.quantity > 1 && <Badge tone="neutral">Sammelposten · {a.quantity} Stück</Badge>}
        {report && (
          <Button asChild variant="secondary" size="sm">
            <Link href={`/gebaeude/melden${a.roomId ? `?raum=${encodeURIComponent(a.roomId)}` : ""}`}>Mangel melden</Link>
          </Button>
        )}
        <Button asChild variant="ghost" size="sm">
          <Link href="/gebaeude/inventar">Zur Liste</Link>
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card aria-labelledby="stamm">
          <CardHeader title={<span id="stamm">Stammdaten</span>} />
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[11rem_1fr]">
            {row("Kategorie", a.categoryName)}
            {row("Standort", a.roomId ? <Link href={roomHref(a.roomId)} className="text-accent-ink hover:underline">{place}</Link> : place)}
            {row("Menge", a.quantity)}
            {row("Hersteller / Modell", [a.manufacturer, a.model].filter(Boolean).join(" · "))}
            {row("Seriennummer", a.serial)}
            {row("angeschafft am", a.acquiredOn ? formatDay(a.acquiredOn) : null)}
            {row("Preis", a.priceCents === null ? null : formatPrice(a.priceCents))}
            {row("Lieferant", a.supplier)}
            {row("Finanzierung", a.financing)}
            {row("Zweckbindung bis", a.boundUntil ? <span className={a.boundUntil < today ? "text-muted" : undefined}>{formatDay(a.boundUntil)}</span> : null)}
            {row("Garantie bis", a.warrantyUntil ? <span className={a.warrantyUntil < today ? "text-muted" : undefined}>{formatDay(a.warrantyUntil)}</span> : null)}
            {row("Nächste Prüfung", a.nextDue ? <span className={a.nextDue < today ? "font-semibold text-danger" : undefined}>{formatDay(a.nextDue)}</span> : null)}
            {row("Ausmusterung", a.retiredOn ? `${formatDay(a.retiredOn)}${a.retiredReason ? ` – ${a.retiredReason}` : ""}` : null)}
            {row("Notiz", a.note)}
          </dl>
        </Card>

        {r.maintain && (
          <Card aria-labelledby="etikett" id="etikett">
            <CardHeader title={<span id="etikett-h">Etikett (QR-Code)</span>} />
            {code ? (
              <div className="flex flex-wrap items-start gap-4">
                <div
                  role="img"
                  aria-label={`QR-Code ${labelUrl("inventar", code)}`}
                  className="size-32 shrink-0 rounded-lg bg-white p-1 [&>svg]:size-full"
                  // SVG aus uqr mit der eigenen Kurz-URL – kein Fremdinhalt
                  dangerouslySetInnerHTML={{ __html: qrSvg(labelUrl("inventar", code)) }}
                />
                <div className="flex min-w-0 flex-col gap-2 text-sm">
                  <p className="font-mono break-all">{labelUrl("inventar", code)}</p>
                  <p className="text-muted">Wer den Code ohne Anmeldung scannt, sieht nur die Anmeldeseite. Der Code bleibt beim Nachdruck gleich.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="secondary" size="sm">
                      <Link href={`/druck/inventar-etiketten?asset=${encodeURIComponent(a.id)}`}>Etikett drucken</Link>
                    </Button>
                    <RenewAssetCode id={a.id} />
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2 text-sm">
                <p className="text-muted">Noch kein Etikett gedruckt – der Code entsteht beim ersten Druck.</p>
                <div>
                  <Button asChild variant="secondary" size="sm">
                    <Link href={`/druck/inventar-etiketten?asset=${encodeURIComponent(a.id)}`}>Etikett drucken</Link>
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}
      </div>

      {r.maintain && (
        <>
          <Card aria-labelledby="aendern">
            <CardHeader title={<span id="aendern">Angaben ändern</span>} />
            <SpecForm action={updateAssetAction.bind(null, a.id)} label="Inventar ändern" submit="Speichern" okText="Gespeichert." columns={3} fields={assetFields({ categories: formCategories, rooms, buildings, floors }, a)} />
          </Card>
          <Card aria-labelledby="ausmustern">
            <CardHeader title={<span id="ausmustern">{a.active ? "Ausmustern" : "Wieder in Betrieb nehmen"}</span>} />
            {a.active ? (
              <>
                <p className="text-sm text-muted">Offene Prüfungen entfallen; der Eintrag bleibt als Nachweis erhalten und erscheint in der Liste nur mit „auch ausgemusterte“.</p>
                <SpecForm
                  action={setAssetActiveAction.bind(null, a.id, false)}
                  label="Inventar ausmustern"
                  submit="Ausmustern"
                  okText="Ausgemustert."
                  variant="secondary"
                  columns={1}
                  fields={[{ name: "reason", label: "Grund", type: "text", maxLength: 200, placeholder: "z. B. defekt, verkauft, entsorgt", hint: "ohne Personenbezug" }]}
                />
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <SpecForm action={setAssetActiveAction.bind(null, a.id, true)} label="Inventar wieder in Betrieb nehmen" submit="Wieder in Betrieb nehmen" okText="Wieder in Betrieb." variant="secondary" columns={1} fields={[]} />
                {configure && <DeleteAsset id={a.id} />}
              </div>
            )}
          </Card>
        </>
      )}
    </main>
  );
}
