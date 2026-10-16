import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { createAssetAction, importAssetsAction, setAssetActiveAction } from "@/modules/gebaeude/actions";
import { ASSET_KIND_LABELS, ASSET_KINDS, type AssetKind } from "@/modules/gebaeude/labels";
import { canConfigure, canSeeAssets, formatDay, inspectionBuildings, listAssets, roomOptions } from "@/modules/gebaeude/pruefungen";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { Field, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { toBerlinDate } from "@/core/time";
import { SpecForm } from "../spec-form";
import { GebaeudeNav } from "../ui";

export const metadata: Metadata = { title: "Anlagen und Geräte" };

type Search = { art?: string; gebaeude?: string; alle?: string };

/** Anlagen/Geräte (Inventar): Liste mit nächster Prüfung, Anlegen und CSV-Import der Inventarliste (Recht `gebaeude.configure`). */
export default async function AnlagenPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  if (!canSeeAssets(perms)) notFound();
  const db = await getDb();
  const sp = await searchParams;
  const kind = ASSET_KINDS.find((k): k is AssetKind => k === sp.art);
  const buildings = await inspectionBuildings(db);
  const building = buildings.find((b) => b === sp.gebaeude);
  const configure = canConfigure(perms);
  const [assets, rooms] = await Promise.all([listAssets(db, perms, { kind, building, inactive: sp.alle === "1" }), configure ? roomOptions(db) : Promise.resolve([])]);
  const today = toBerlinDate(new Date());

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Gebäude & Technik" title="Anlagen und Geräte" />
      <GebaeudeNav current="anlagen" configure={canConfigure(perms)} />
      <form aria-label="Filter" className="flex flex-wrap items-end gap-3">
        <Field label="Art">
          <Select name="art" defaultValue={kind ?? ""} className="w-64">
            <option value="">alle</option>
            {ASSET_KINDS.map((k) => (
              <option key={k} value={k}>
                {ASSET_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        {buildings.length > 0 && (
          <Field label="Gebäude">
            <Select name="gebaeude" defaultValue={building ?? ""} className="w-48">
              <option value="">alle</option>
              {buildings.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </Select>
          </Field>
        )}
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="alle" value="1" defaultChecked={sp.alle === "1"} className="size-4 accent-[var(--accent)]" />
          auch außer Betrieb
        </label>
        <Button type="submit">Filtern</Button>
      </form>

      {assets.length === 0 ? (
        <EmptyState title="Keine Anlagen">{configure ? "Unten einzeln anlegen oder die Inventarliste des Schulträgers als CSV importieren." : "Es sind noch keine Anlagen erfasst."}</EmptyState>
      ) : (
        <Table>
          <caption className="sr-only">Anlagen und Geräte</caption>
          <thead>
            <tr>
              <th>Bezeichnung</th>
              <th>Art</th>
              <th>Ort</th>
              <th>Inventarnr.</th>
              <th>Nächste Prüfung</th>
              {configure && <th className="sr-only">Aktion</th>}
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id}>
                <td className="font-medium">
                  {a.name} {!a.active && <Badge tone="neutral">außer Betrieb</Badge>}
                </td>
                <td>{ASSET_KIND_LABELS[a.kind]}</td>
                <td>{[a.roomId ? `Raum ${a.roomId}` : null, a.building].filter(Boolean).join(" · ") || "–"}</td>
                <td className="tabular-nums">{a.inventoryNo ?? "–"}</td>
                <td>{a.nextDue ? <span className={a.nextDue < today ? "font-semibold text-danger" : undefined}>{formatDay(a.nextDue)}</span> : "–"}</td>
                {configure && (
                  <td className="text-right">
                    <form action={setAssetActiveAction.bind(null, a.id, !a.active)}>
                      <Button type="submit" size="sm" variant="ghost" aria-label={`${a.name} ${a.active ? "außer Betrieb nehmen" : "wieder in Betrieb nehmen"}`}>
                        {a.active ? "außer Betrieb" : "in Betrieb"}
                      </Button>
                    </form>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {configure && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card aria-labelledby="anlegen">
            <CardHeader title={<span id="anlegen">Anlage anlegen</span>} />
            <SpecForm
              action={createAssetAction}
              label="Anlage anlegen"
              submit="Anlegen"
              okText="Angelegt – passende Prüfungen sind geplant."
              fields={[
                { name: "name", label: "Bezeichnung", type: "text", required: true, maxLength: 120, wide: true, placeholder: "z. B. Feuerlöscher Flur 1. OG" },
                { name: "kind", label: "Art", type: "select", options: ASSET_KINDS.map((k) => ({ value: k, label: ASSET_KIND_LABELS[k] })) },
                { name: "inventoryNo", label: "Inventarnummer", type: "text", maxLength: 40 },
                { name: "roomId", label: "Raum", type: "select", options: [{ value: "", label: "kein Raum" }, ...rooms] },
                { name: "building", label: "Gebäude", type: "text", maxLength: 60, hint: "ohne Raum oder abweichend" },
                { name: "manufacturer", label: "Hersteller", type: "text", maxLength: 80 },
                { name: "serial", label: "Seriennummer", type: "text", maxLength: 80 },
                { name: "acquiredOn", label: "angeschafft am", type: "date", hint: "ohne Angabe ist die erste Prüfung sofort fällig" },
              ]}
            />
          </Card>
          <Card aria-labelledby="import">
            <CardHeader title={<span id="import">Inventarliste importieren (CSV)</span>} />
            <p className="text-sm text-muted">
              Spalten <code>Name;Art;Raum;Inventarnummer</code>, optional <code>;letzte Prüfung</code> (TT.MM.JJJJ) – mit oder ohne Kopfzeile, Trennzeichen „;“ oder „,“.
              Gleiche Inventarnummer aktualisiert die Anlage. Art z. B. „Feuerlöscher“, „Leiter“, „Elektrogerät“. Fehler in einer Zeile → nichts wird übernommen.
            </p>
            <SpecForm
              action={importAssetsAction}
              label="Inventarliste importieren"
              submit="Importieren"
              columns={1}
              fields={[{ name: "file", label: "CSV-Datei", type: "file", accept: ".csv,text/csv", hint: "höchstens 512 KB, 2000 Zeilen" }]}
            />
          </Card>
        </div>
      )}
    </main>
  );
}
