import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { REPLACEMENT_HORIZONS, REPLACEMENT_STATE_LABELS, parseHorizon, replacementReport, type ReplacementReport } from "@/modules/gebaeude/ersatzbedarf";
import { canConfigure, canSeeInventory, listCategories } from "@/modules/gebaeude/inventar";
import { formatPrice } from "@/modules/gebaeude/labels";
import { buildingOptions, formatDay, roomOptions } from "@/modules/gebaeude/pruefungen";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Field, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { GebaeudeNav } from "../../ui";

export const metadata: Metadata = { title: "Ersatzbedarf" };

type Search = { kategorie?: string; gebaeude?: string; raum?: string; jahre?: string };

const pieces = (n: number) => (n === 1 ? "1 Stück" : `${n.toLocaleString("de-DE")} Stück`);
const value = (cents: number | null) => formatPrice(cents);

/** Zahl + Stückzahl als Zelle (Einträge nur, wenn Sammelposten dabei sind). */
function CountCell({ c }: { c: { entries: number; pieces: number } }) {
  if (c.pieces === 0) return <span className="text-muted">–</span>;
  return (
    <span className="tabular-nums">
      {c.pieces.toLocaleString("de-DE")}
      {c.entries !== c.pieces && <span className="text-muted"> ({c.entries})</span>}
    </span>
  );
}

/**
 * INV-11: Ersatzbedarf/Bestand – Alter gegen die Nutzungsdauer der Kategorie (Richtwert, INV-10), je Kategorie, Jahr und Raum,
 * dazu die fälligen Einträge; CSV und Druck. Sicht wie die Inventarliste (verantwortliche Gruppen nur ihre Kategorien), Preise und
 * Werte nur mit `configure`/`view_all`. Grundlage fürs Gespräch mit dem Schulträger – keine Abschreibung, kein Bestellwesen.
 */
export default async function ErsatzbedarfPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  if (!(await canSeeInventory(db, perms))) notFound();
  const sp = await searchParams;
  const [categories, buildings, rooms] = await Promise.all([listCategories(db), buildingOptions(db), roomOptions(db)]);
  const category = categories.find((c) => c.id === sp.kategorie);
  const building = buildings.find((b) => b.value === sp.gebaeude);
  const room = rooms.find((r) => r.value === sp.raum);
  const horizon = parseHorizon(sp.jahre);
  const today = toBerlinDate(new Date());
  const r: ReplacementReport = await replacementReport(db, perms, { categoryId: category?.id, buildingId: building?.value, roomId: room?.value }, today, horizon);
  const query = new URLSearchParams(
    Object.entries({ kategorie: category?.id, gebaeude: building?.value, raum: room?.value, jahre: String(horizon) }).filter((e): e is [string, string] => !!e[1]),
  ).toString();
  const t = r.totals;
  const inStock = Object.values(t).reduce((n, c) => n + c.pieces, 0);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Inventar" title="Ersatzbedarf" />
      <GebaeudeNav current="inventar" configure={canConfigure(perms)} />
      <p className="text-sm text-muted">
        Alter des Inventars gegen die Nutzungsdauer der Kategorie (Richtwert, in den{" "}
        {canConfigure(perms) ? (
          <Link href="/gebaeude/inventar/kategorien" className="font-medium text-accent-ink hover:underline">
            Kategorien
          </Link>
        ) : (
          "Kategorien"
        )}{" "}
        einstellbar): Ersatz fällig ist ein Eintrag ab dem Jahr „Anschaffungsjahr + Nutzungsdauer“. Grundlage fürs Gespräch mit dem Schulträger – keine Abschreibung
        und kein Restwert.{!r.values && " Preise und Werte sieht nur die Verwaltung bzw. Leitung."}{" "}
        <Link href="/gebaeude/inventar" className="font-medium text-accent-ink hover:underline">
          Zurück zum Inventar
        </Link>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="secondary" size="sm">
          <a href={`/api/gebaeude/export/ersatzbedarf?${query}`} download>
            Als CSV exportieren
          </a>
        </Button>
        <Button asChild variant="secondary" size="sm">
          <Link href={`/druck/ersatzbedarf?${query}`}>Drucken</Link>
        </Button>
      </div>
      <form aria-label="Filter" className="flex flex-wrap items-end gap-3">
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
        <Field label="Raum">
          <Select name="raum" defaultValue={room?.value ?? ""} className="w-48">
            <option value="">alle</option>
            {rooms.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Vorausschau">
          <Select name="jahre" defaultValue={String(horizon)} className="w-40">
            {REPLACEMENT_HORIZONS.map((h) => (
              <option key={h} value={h}>
                {h} Jahre
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit">Anzeigen</Button>
      </form>

      {inStock === 0 ? (
        <EmptyState title="Kein Inventar">Für diese Auswahl ist kein Inventar in Betrieb erfasst.</EmptyState>
      ) : (
        <>
          <dl aria-label="Überblick" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ["faellig", `Ersatz fällig (bis ${r.year})`],
                ["bald", `${r.year + 1}–${r.year + r.horizon}`],
                ["ohne_datum", "ohne Anschaffungsdatum"],
                ["ohne_richtwert", "ohne Richtwert"],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="rounded-card border border-border bg-surface px-4 py-3">
                <dt className="text-sm text-muted">{label}</dt>
                <dd className="font-display text-2xl font-bold tabular-nums">{pieces(t[k].pieces)}</dd>
                {r.values && (k === "faellig" || k === "bald") && <dd className="text-sm text-muted tabular-nums">Anschaffungswert {value(t[k].valueCents)}</dd>}
              </div>
            ))}
          </dl>

          <section aria-labelledby="je-kategorie" className="flex flex-col gap-3">
            <h2 id="je-kategorie" className="font-display text-xl font-bold">
              Je Kategorie
            </h2>
            <Table scrollLabel="Ersatzbedarf je Kategorie">
              <caption className="sr-only">Ersatzbedarf je Kategorie</caption>
              <thead>
                <tr>
                  <th>Kategorie</th>
                  <th className="text-right">Nutzungsdauer</th>
                  <th className="text-right">Bestand</th>
                  <th className="text-right">fällig</th>
                  <th className="text-right">bis {r.year + r.horizon}</th>
                  <th className="text-right">ohne Datum</th>
                  {r.values && <th className="text-right">Wert fällig + bis {r.year + r.horizon}</th>}
                </tr>
              </thead>
              <tbody>
                {r.byCategory.map((c) => (
                  <tr key={c.categoryId}>
                    <td className="font-medium">{c.name}</td>
                    <td className="text-right tabular-nums">{c.lifetimeYears ? `${c.lifetimeYears} J.` : <span className="text-muted">–</span>}</td>
                    <td className="text-right">
                      <CountCell c={c.total} />
                    </td>
                    <td className="text-right">
                      <CountCell c={c.faellig} />
                    </td>
                    <td className="text-right">
                      <CountCell c={c.bald} />
                    </td>
                    <td className="text-right tabular-nums">{c.ohneDatum || <span className="text-muted">–</span>}</td>
                    {r.values && <td className="text-right tabular-nums">{value((c.faellig.valueCents ?? 0) + (c.bald.valueCents ?? 0))}</td>}
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="text-xs text-muted">Stückzahlen; in Klammern die Zahl der Einträge, wenn Sammelposten dabei sind.</p>
          </section>

          <section aria-labelledby="je-jahr" className="flex flex-col gap-3">
            <h2 id="je-jahr" className="font-display text-xl font-bold">
              Je Jahr
            </h2>
            <Table scrollLabel="Ersatzbedarf je Jahr">
              <caption className="sr-only">Ersatzbedarf je Jahr</caption>
              <thead>
                <tr>
                  <th>Jahr</th>
                  <th className="text-right">Stück</th>
                  <th className="text-right">Einträge</th>
                  {r.values && <th className="text-right">Anschaffungswert</th>}
                </tr>
              </thead>
              <tbody>
                {r.byYear.map((y) => (
                  <tr key={y.year}>
                    <td className="font-medium">{y.overdue ? `bis ${y.year} (fällig)` : y.year}</td>
                    <td className="text-right tabular-nums">{y.counts.pieces}</td>
                    <td className="text-right tabular-nums">{y.counts.entries}</td>
                    {r.values && <td className="text-right tabular-nums">{value(y.counts.valueCents)}</td>}
                  </tr>
                ))}
              </tbody>
            </Table>
          </section>

          {r.byPlace.length > 0 && (
            <section aria-labelledby="je-raum" className="flex flex-col gap-3">
              <h2 id="je-raum" className="font-display text-xl font-bold">
                Je Raum
              </h2>
              <Table scrollLabel="Ersatzbedarf je Raum">
                <caption className="sr-only">Ersatzbedarf je Raum</caption>
                <thead>
                  <tr>
                    <th>Standort</th>
                    <th className="text-right">fällig</th>
                    <th className="text-right">bis {r.year + r.horizon}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byPlace.map((p) => (
                    <tr key={p.place}>
                      <td>
                        {p.roomId ? (
                          <Link href={`/gebaeude/inventar/ersatzbedarf?${new URLSearchParams({ raum: p.roomId, jahre: String(horizon) })}`} className="flex min-h-6 items-center font-medium text-accent-ink hover:underline">
                            {p.place}
                          </Link>
                        ) : (
                          p.place
                        )}
                      </td>
                      <td className="text-right">
                        <CountCell c={p.faellig} />
                      </td>
                      <td className="text-right">
                        <CountCell c={p.bald} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </section>
          )}

          <section aria-labelledby="eintraege" className="flex flex-col gap-3">
            <h2 id="eintraege" className="font-display text-xl font-bold">
              Fällig und in der Vorausschau ({r.items.length})
            </h2>
            {r.items.length === 0 ? (
              <p className="text-sm text-muted">Nichts fällig bis {r.year + r.horizon}.</p>
            ) : (
              <Table scrollLabel="Einträge mit Ersatzbedarf">
                <caption className="sr-only">Einträge mit Ersatzbedarf</caption>
                <thead>
                  <tr>
                    <th>Ersatz</th>
                    <th>Inventarnr.</th>
                    <th>Bezeichnung</th>
                    <th>Kategorie</th>
                    <th>Standort</th>
                    <th className="text-right">Menge</th>
                    <th>angeschafft</th>
                    <th className="text-right">Alter</th>
                    {r.values && <th className="text-right">Preis</th>}
                  </tr>
                </thead>
                <tbody>
                  {r.items.slice(0, 500).map((i) => (
                    <tr key={i.id}>
                      <td>{i.state === "faellig" ? <Badge tone="warn">{REPLACEMENT_STATE_LABELS.faellig}</Badge> : i.year}</td>
                      <td className="font-mono tabular-nums">
                        <Link href={`/gebaeude/inventar/${encodeURIComponent(i.id)}`} className="flex min-h-6 items-center font-medium text-accent-ink hover:underline">
                          {i.inventoryNo ?? "–"}
                        </Link>
                      </td>
                      <td className="font-medium">{i.name}</td>
                      <td>{i.categoryName}</td>
                      <td>{i.place}</td>
                      <td className="text-right tabular-nums">{i.quantity}</td>
                      <td>{i.acquiredOn ? formatDay(i.acquiredOn) : "–"}</td>
                      <td className="text-right tabular-nums">{i.age === null ? "–" : `${i.age} J.`}</td>
                      {r.values && <td className="text-right tabular-nums">{value(i.priceCents)}</td>}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>
        </>
      )}
    </main>
  );
}
