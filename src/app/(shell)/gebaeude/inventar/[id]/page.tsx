import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { labelUrl, qrSvg } from "@/core/etiketten/qr";
import { roomHref } from "@/core/room-href";
import { TZ, toBerlinDate } from "@/core/time";
import {
  addAssetPhotoAction,
  deleteAssetPhotoAction,
  moveAssetAction,
  recordInspectionAction,
  setAssetActiveAction,
  setAssetConditionAction,
  updateAssetAction,
} from "@/modules/gebaeude/actions";
import { assetHistory, listAssetPhotos } from "@/modules/gebaeude/asset-seite";
import { assetCode } from "@/modules/gebaeude/etiketten";
import { canConfigure, listCategories, maintainableCategories } from "@/modules/gebaeude/inventar";
import {
  ASSET_CONDITIONS,
  ASSET_PHOTOS_MAX,
  ASSET_PHOTO_MAX_MB,
  CONDITION_LABELS,
  INSPECTION_RESULTS,
  INSPECTION_STATE_LABELS,
  MAX_REPORT_MB,
  RESULT_LABELS,
  formatPrice,
  type InspectionState,
} from "@/modules/gebaeude/labels";
import { assetPlace, buildingOptions, floorOptions, formatDay, getAsset, listInspections, roomOptions } from "@/modules/gebaeude/pruefungen";
import { canManage, canReport, canViewAll, listTickets, openTicketCountForAsset } from "@/modules/gebaeude/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { SpecForm } from "@/ui/spec-form";
import { GebaeudeNav, TicketItem } from "../../ui";
import { assetFields } from "../asset-form";
import { AssetPhotoForm, ConditionButtons, DeleteAsset, DeleteAssetPhoto, MoveForm, RenewAssetCode } from "./forms";

export const metadata: Metadata = { title: "Inventar" };

const when = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const STATE_TONE: Record<InspectionState, "danger" | "warn" | "neutral" | "success"> = { ueberfaellig: "danger", faellig: "warn", geplant: "neutral", erledigt: "success" };

const reportHref = (id: string) => `/gebaeude/melden?asset=${encodeURIComponent(id)}`;
const photoSrc = (id: string, small = false) => `/api/gebaeude/inventar-foto/${encodeURIComponent(id)}${small ? "?klein=1" : ""}`;

/**
 * Asset-Seite (Ziel von `/i/<code>`), mobil zuerst (INV-03): oben „Mangel melden“ und für Pflegende Zustand/Standort per Knopf,
 * darunter Stammdaten, Fotos, Meldungen und Prüfungen zum Gerät, Historie, Etikett und das volle Formular. Pflegende und `view_all`
 * sehen alles; alle anderen Angemeldeten nur Bezeichnung, Kategorie, Standort, „Mangel melden“ und die eigenen Meldungen (inv-5).
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
  const viewAll = canViewAll(perms);
  // Meldungen zum Gerät: `view_all` alle, sonst nur die eigenen (Sichtbarkeit wie im Meldungsmodul); die Anzahl offener zeigt
  // allen, dass ein Mangel schon bekannt ist – ohne Inhalte
  const [tickets, openCount] = await Promise.all([listTickets(db, perms, { assetId: base.id, state: "all", limit: 20 }), openTicketCountForAsset(db, base.id)]);
  const placeNode = base.roomId ? (
    <Link href={roomHref(base.roomId)} className="text-accent-ink hover:underline">
      {place}
    </Link>
  ) : (
    place
  );

  const ticketsCard = (
    <Card aria-labelledby="meldungen">
      <CardHeader title={<span id="meldungen">{viewAll ? "Meldungen zu diesem Gerät" : "Meine Meldungen zu diesem Gerät"}</span>} />
      {openCount > 0 && (
        <p role="note" className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          {openCount === 1 ? "Eine Meldung ist" : `${openCount} Meldungen sind`} noch offen.
        </p>
      )}
      {tickets.length === 0 ? (
        <p className="text-sm text-muted">{viewAll ? "Noch keine Meldungen." : "Keine eigenen Meldungen."}</p>
      ) : (
        <ul aria-label="Meldungen zu diesem Gerät" className="flex flex-col gap-2">
          {tickets.map((t) => (
            <li key={t.id}>
              <TicketItem t={t} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  const reportButton = report && (
    <Button asChild variant="primary" className="w-full sm:w-auto">
      <Link href={reportHref(base.id)}>Mangel melden</Link>
    </Button>
  );

  if (!r.full) {
    const a = r.asset;
    return (
      <main className="flex max-w-2xl flex-col gap-6">
        <PageHeader eyebrow="Inventar" title={a.name} />
        {reportButton && <div>{reportButton}</div>}
        <Card>
          <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted">Kategorie</dt>
            <dd>{a.categoryName}</dd>
            <dt className="text-muted">Standort</dt>
            <dd>{placeNode}</dd>
            {a.quantity > 1 && (
              <>
                <dt className="text-muted">Menge</dt>
                <dd>{a.quantity}</dd>
              </>
            )}
          </dl>
          {!a.active && <p className="text-sm text-muted">Dieses Gerät ist ausgemustert.</p>}
        </Card>
        {(tickets.length > 0 || openCount > 0) && ticketsCard}
      </main>
    );
  }

  const a = r.asset;
  const configure = canConfigure(perms);
  const manage = canManage(perms);
  const [categories, rooms, buildings, floors, own, code, photos, history, inspections] = await Promise.all([
    listCategories(db),
    r.maintain ? roomOptions(db) : [],
    r.maintain ? buildingOptions(db) : [],
    r.maintain ? floorOptions(db) : [],
    maintainableCategories(db, perms),
    r.maintain ? assetCode(db, perms, a.id, a.categoryId) : null,
    listAssetPhotos(db, perms, a.id),
    assetHistory(db, perms, a.id),
    viewAll ? listInspections(db, perms, { state: "alle", assetId: a.id, limit: 20 }, toBerlinDate(new Date())) : [],
  ]);
  const formCategories = categories.filter((c) => (c.active || c.id === a.categoryId) && (own === null || own.has(c.id))).map((c) => ({ value: c.id, label: c.name }));
  const today = toBerlinDate(new Date());
  const openInspections = inspections.filter((i) => !i.doneOn).sort((x, y) => x.dueOn.localeCompare(y.dueOn));
  const doneInspections = inspections.filter((i) => i.doneOn).sort((x, y) => (y.doneOn ?? "").localeCompare(x.doneOn ?? ""));
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
        <span className="text-sm text-muted">
          {a.categoryName} · {place}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {reportButton}
        <Button asChild variant="ghost" className="w-full sm:w-auto">
          <Link href="/gebaeude/inventar">Zur Liste</Link>
        </Button>
      </div>

      {r.maintain && a.active && (
        <Card aria-labelledby="schnell">
          <CardHeader title={<span id="schnell">Vor Ort erfassen</span>} />
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <h3 id="zustand-h" className="text-sm font-medium">
                Zustand
              </h3>
              <ConditionButtons action={setAssetConditionAction.bind(null, a.id)} current={a.condition} options={ASSET_CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))} />
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Standort</h3>
              <p className="text-sm text-muted">Jetzt: {place}</p>
              <MoveForm action={moveAssetAction.bind(null, a.id)} rooms={rooms} current={a.roomId} />
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card aria-labelledby="stamm">
          <CardHeader title={<span id="stamm">Stammdaten</span>} />
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[11rem_1fr]">
            {row("Kategorie", a.categoryName)}
            {row("Standort", placeNode)}
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

        <Card aria-labelledby="fotos">
          <CardHeader title={<span id="fotos">Fotos</span>} />
          {photos.length === 0 ? (
            <p className="text-sm text-muted">Noch keine Fotos.</p>
          ) : (
            <ul aria-label="Fotos des Geräts" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {photos.map((p, i) => (
                <li key={p.id} className="flex flex-col gap-1">
                  <a href={photoSrc(p.id)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-border">
                    {/* eslint-disable-next-line @next/next/no-img-element -- geschützte Route mit Sitzung, kein Bild-Optimierer */}
                    <img src={photoSrc(p.id, true)} alt={`Foto ${i + 1} von ${a.name}`} className="aspect-[4/3] w-full bg-surface-2 object-cover" />
                  </a>
                  {r.maintain && <DeleteAssetPhoto action={deleteAssetPhotoAction.bind(null, p.id)} label={`Foto ${i + 1}`} />}
                </li>
              ))}
            </ul>
          )}
          {r.maintain &&
            (photos.length < ASSET_PHOTOS_MAX ? (
              <AssetPhotoForm action={addAssetPhotoAction.bind(null, a.id)} maxMb={ASSET_PHOTO_MAX_MB} left={ASSET_PHOTOS_MAX - photos.length} />
            ) : (
              <p className="text-sm text-muted">Schon {ASSET_PHOTOS_MAX} Fotos – für ein neues bitte erst eines löschen.</p>
            ))}
        </Card>

        {ticketsCard}

        {viewAll && (
          <Card aria-labelledby="pruefungen">
            <CardHeader title={<span id="pruefungen">Prüfungen</span>} />
            {inspections.length === 0 ? (
              <p className="text-sm text-muted">Keine Prüfungen geplant oder erfasst.</p>
            ) : (
              <ul aria-label="Prüfungen dieses Geräts" className="flex flex-col gap-2">
                {[...openInspections, ...doneInspections].map((i) => (
                  <li key={i.id} className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{i.typeName}</span>
                      {i.doneOn ? (
                        <>
                          <span>geprüft {formatDay(i.doneOn)}</span>
                          <Badge tone={i.result === "ok" ? "success" : i.result ? "danger" : "neutral"}>{i.result ? RESULT_LABELS[i.result] : "übernommen"}</Badge>
                          {i.hasReport && (
                            <a href={`/api/gebaeude/protokoll/${i.id}`} className="font-medium text-accent-ink hover:underline">
                              Protokoll (PDF)
                            </a>
                          )}
                        </>
                      ) : (
                        <>
                          <span>fällig {formatDay(i.dueOn)}</span>
                          <Badge tone={STATE_TONE[i.state]}>{INSPECTION_STATE_LABELS[i.state]}</Badge>
                        </>
                      )}
                    </div>
                    {manage && !i.doneOn && (
                      <details className="rounded-lg bg-surface-2 px-3 py-2">
                        <summary className="flex min-h-6 cursor-pointer items-center font-medium">Ergebnis erfassen</summary>
                        <div className="mt-3">
                          <SpecForm
                            action={recordInspectionAction.bind(null, i.id)}
                            label={`Prüfung erfassen: ${i.typeName}`}
                            submit="Prüfung erfassen"
                            okText="Erfasst."
                            columns={1}
                            fields={[
                              { name: "doneOn", label: "geprüft am", type: "date", defaultValue: today, required: true },
                              { name: "result", label: "Ergebnis", type: "select", defaultValue: "ok", options: INSPECTION_RESULTS.map((x) => ({ value: x, label: RESULT_LABELS[x] })) },
                              { name: "company", label: "Firma bzw. Stelle", type: "text", hint: "kein Personenname", maxLength: 120 },
                              { name: "report", label: "Protokoll (PDF)", type: "file", accept: "application/pdf", hint: `optional, höchstens ${MAX_REPORT_MB} MB` },
                              { name: "note", label: "Bemerkung", type: "textarea", maxLength: 2000, hint: "bei Mangel: was ist zu tun? – daraus entsteht eine Meldung zu diesem Gerät" },
                            ]}
                          />
                        </div>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      <Card aria-labelledby="historie">
        <CardHeader title={<span id="historie">Historie</span>} />
        {history.length === 0 ? (
          <p className="text-sm text-muted">Noch keine Einträge.</p>
        ) : (
          <ol aria-label="Historie" className="flex flex-col gap-1.5 text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-col border-b border-border pb-1.5 last:border-0 sm:flex-row sm:gap-3">
                <span className="shrink-0 text-xs text-muted tabular-nums sm:w-36 sm:text-sm">{when.format(h.at)}</span>
                <span>
                  {h.label}
                  {h.detail && <span className="text-muted"> · {h.detail}</span>}
                  <span className="text-muted"> · {h.actor}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {r.maintain && (
        <Card aria-labelledby="etikett-h" id="etikett">
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
