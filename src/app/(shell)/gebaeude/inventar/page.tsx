import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { createAssetAction, importAssetsAction } from "@/modules/gebaeude/actions";
import { canPrintLabels } from "@/modules/gebaeude/etiketten";
import { canConfigure, canSeeInventory, categoriesWithoutInspectionType, listCategories, maintainableCategories } from "@/modules/gebaeude/inventar";
import { canReadInventories } from "@/modules/gebaeude/inventur";
import { ASSET_CONDITIONS, CONDITION_LABELS } from "@/modules/gebaeude/labels";
import { assetPlace, buildingOptions, floorOptions, formatDay, listAssets, roomOptions } from "@/modules/gebaeude/pruefungen";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { Field, Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { SpecForm } from "@/ui/spec-form";
import { GebaeudeNav } from "../ui";
import { assetFields } from "./asset-form";

export const metadata: Metadata = { title: "Inventar" };

type Search = { kategorie?: string; gebaeude?: string; zustand?: string; alle?: string; ohne?: string; q?: string; geloescht?: string };

/**
 * INV-01 Inventar: Liste mit Filtern (Kategorie, Gebäude, Zustand, Suche, ohne Etikett, auch ausgemusterte), Anlegen und
 * CSV-Import. Lesen mit `view_all`/`inventory`/`configure`, verantwortliche Gruppen sehen ihre Kategorien; Pflege nach
 * Kategorie (`requireMaintain` im Service).
 */
export default async function InventarPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  if (!(await canSeeInventory(db, perms))) notFound();
  const sp = await searchParams;
  const [categories, buildings, own, printable] = await Promise.all([listCategories(db), buildingOptions(db), maintainableCategories(db, perms), canPrintLabels(db, perms)]);
  const configure = canConfigure(perms);
  const maintain = own === null || own.size > 0;
  const category = categories.find((c) => c.id === sp.kategorie);
  const building = buildings.find((b) => b.value === sp.gebaeude);
  const condition = ASSET_CONDITIONS.find((c) => c === sp.zustand);
  const assets = await listAssets(db, perms, { categoryId: category?.id, buildingId: building?.value, condition, inactive: sp.alle === "1", withoutLabel: sp.ohne === "1", q: sp.q });
  const [rooms, floors, missing] = await Promise.all([maintain ? roomOptions(db) : [], maintain ? floorOptions(db) : [], configure ? categoriesWithoutInspectionType(db) : []]);
  const today = toBerlinDate(new Date());
  const formCategories = categories.filter((c) => c.active && (own === null || own.has(c.id))).map((c) => ({ value: c.id, label: c.name }));
  const total = assets.reduce((s, a) => s + a.quantity, 0);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Gebäude & Technik" title="Inventar" />
      <GebaeudeNav current="inventar" configure={configure} />
      <div className="flex flex-wrap items-center gap-2">
        {printable && (
          <Button asChild variant="secondary" size="sm">
            <Link href="/gebaeude/inventar/etiketten">Etiketten drucken</Link>
          </Button>
        )}
        {canReadInventories(perms) && (
          <Button asChild variant="secondary" size="sm">
            <Link href="/gebaeude/inventur">Inventur</Link>
          </Button>
        )}
        {configure && (
          <Button asChild variant="ghost" size="sm">
            <Link href="/gebaeude/inventar/kategorien">Kategorien</Link>
          </Button>
        )}
        {sp.geloescht === "1" && <p role="status" className="text-sm text-muted">Inventar gelöscht.</p>}
      </div>
      {missing.length > 0 && (
        <p role="note" className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
          Prüfpflichtige Kategorien ohne eingeschaltete Prüfart: {missing.join(", ")} –{" "}
          <Link href="/gebaeude/pruefarten" className="font-medium text-accent-ink hover:underline">
            Prüfarten einrichten
          </Link>
        </p>
      )}
      <form aria-label="Filter" className="flex flex-wrap items-end gap-3">
        <Field label="Suche">
          <Input name="q" type="search" defaultValue={sp.q ?? ""} placeholder="Bezeichnung, Nummer, Seriennr." className="w-56" />
        </Field>
        <Field label="Kategorie">
          <Select name="kategorie" defaultValue={category?.id ?? ""} className="w-64">
            <option value="">alle</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        {buildings.length > 0 && (
          <Field label="Gebäude">
            <Select name="gebaeude" defaultValue={building?.value ?? ""} className="w-48">
              <option value="">alle</option>
              {buildings.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Zustand">
          <Select name="zustand" defaultValue={condition ?? ""} className="w-36">
            <option value="">alle</option>
            {ASSET_CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {CONDITION_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="ohne" value="1" defaultChecked={sp.ohne === "1"} className="size-6 accent-[var(--accent)]" />
          ohne Etikett
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="alle" value="1" defaultChecked={sp.alle === "1"} className="size-6 accent-[var(--accent)]" />
          auch ausgemusterte
        </label>
        <Button type="submit">Filtern</Button>
      </form>

      {assets.length === 0 ? (
        <EmptyState title="Kein Inventar">{maintain ? "Unten einzeln anlegen oder die Inventarliste des Schulträgers als CSV importieren." : "Es ist noch kein Inventar erfasst."}</EmptyState>
      ) : (
        <>
          <p role="status" className="text-sm text-muted">
            {assets.length === 1 ? "1 Eintrag" : `${assets.length} Einträge`}
            {total !== assets.length && ` · ${total} Stück`}
          </p>
          <Table scrollLabel="Inventarliste">
            <caption className="sr-only">Inventar</caption>
            <thead>
              <tr>
                <th>Inventarnr.</th>
                <th>Bezeichnung</th>
                <th>Kategorie</th>
                <th>Standort</th>
                <th className="text-right">Menge</th>
                <th>Zustand</th>
                <th>Nächste Prüfung</th>
                <th>Etikett</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id}>
                  <td className="font-mono tabular-nums">
                    <Link href={`/gebaeude/inventar/${encodeURIComponent(a.id)}`} className="flex min-h-6 items-center font-medium text-accent-ink hover:underline">
                      {a.inventoryNo ?? "–"}
                    </Link>
                  </td>
                  <td className="font-medium">
                    {a.name} {!a.active && <Badge tone="neutral">ausgemustert</Badge>}
                  </td>
                  <td>{a.categoryName}</td>
                  <td>{assetPlace(a)}</td>
                  <td className="text-right tabular-nums">{a.quantity}</td>
                  <td>{a.condition ? CONDITION_LABELS[a.condition] : "–"}</td>
                  <td>{a.nextDue ? <span className={a.nextDue < today ? "font-semibold text-danger" : undefined}>{formatDay(a.nextDue)}</span> : "–"}</td>
                  <td>{a.labelCode ? <Badge tone="success">gedruckt</Badge> : <span className="text-muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}

      {maintain && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card aria-labelledby="anlegen">
            <CardHeader title={<span id="anlegen">Inventar anlegen</span>} />
            <SpecForm action={createAssetAction} label="Inventar anlegen" submit="Anlegen" fields={assetFields({ categories: formCategories, rooms, buildings, floors })} />
          </Card>
          <Card aria-labelledby="import">
            <CardHeader title={<span id="import">Inventarliste importieren (CSV)</span>} />
            <p className="text-sm text-muted">
              Spalten <code>Name;Kategorie;Raum;Inventarnummer</code>, optional <code>;letzte Prüfung;Menge;Hersteller;Modell;Seriennummer</code> – mit oder ohne Kopfzeile,
              Trennzeichen „;“ oder „,“. Gleiche Inventarnummer aktualisiert den Eintrag, ohne Nummer vergibt SchulOS eine. Kategorie als Name, Schlüssel oder Präfix (z. B.
              „Feuerlöscher“, „IT“, „Leiter“). Fehler in einer Zeile → nichts wird übernommen.
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
