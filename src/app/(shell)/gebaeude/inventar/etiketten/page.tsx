import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { LABEL_FORMATS, labelFormat } from "@/core/etiketten/codes";
import { readModuleSetting } from "@/core/modules/settings";
import { canPrintLabels, printableAssets } from "@/modules/gebaeude/etiketten";
import { listCategories } from "@/modules/gebaeude/inventar";
import { assetPlace, roomOptions } from "@/modules/gebaeude/pruefungen";
import { LABEL_FORMAT_DEFAULT } from "@/modules/gebaeude/settings";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Field, Select } from "@schulos/ui/field";
import { PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Inventar-Etiketten drucken" };

type Search = { kategorie?: string; raum?: string; ohne?: string };

/**
 * INV-02 Sammeldruck: Inventar nach Kategorie, Raum und „ohne Etikett“ eingrenzen, Einträge anhaken → Druckansicht
 * `/druck/inventar-etiketten`. Formulare per GET, ohne Skript; „alle gefilterten drucken“ als Link.
 */
export default async function EtikettenAuswahlPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  if (!(await canPrintLabels(db, perms))) notFound();
  const sp = await searchParams;
  const [categories, rooms, defaultFormat] = await Promise.all([listCategories(db), roomOptions(db), readModuleSetting(db, LABEL_FORMAT_DEFAULT)]);
  const category = categories.find((c) => c.id === sp.kategorie);
  const room = rooms.find((r) => r.value === sp.raum);
  const filter = { categoryId: category?.id, roomId: room?.value, withoutLabel: sp.ohne === "1" };
  const list = await printableAssets(db, perms, filter);
  const groupsByCategory: { id: string; name: string; items: typeof list }[] = [];
  for (const a of list) {
    let g = groupsByCategory.find((x) => x.id === a.categoryId);
    if (!g) groupsByCategory.push((g = { id: a.categoryId, name: a.categoryName, items: [] }));
    g.items.push(a);
  }
  const allQuery = new URLSearchParams({ alle: "1", format: labelFormat(defaultFormat) });
  if (category) allQuery.set("kategorie", category.id);
  if (room) allQuery.set("raum", room.value);
  if (sp.ohne === "1") allQuery.set("ohne", "1");

  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader eyebrow="Inventar" title="Etiketten drucken" />
      <p className="text-sm text-muted">
        Jedes Etikett trägt Inventarnummer, Bezeichnung, Schulname und einen QR-Code. Wer ihn ohne Anmeldung scannt, sieht nur die Anmeldeseite; nach der
        Anmeldung öffnet sich die Seite des Geräts. Der Code bleibt beim Nachdruck gleich – einen neuen erzeugen Sie auf der Seite des Geräts.{" "}
        <Link href="/gebaeude/inventar" className="font-medium text-accent-ink hover:underline">
          Zurück zum Inventar
        </Link>
      </p>
      <form aria-label="Eingrenzen" className="flex flex-wrap items-end gap-3">
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
        <Field label="Raum">
          <Select name="raum" defaultValue={room?.value ?? ""} className="w-64">
            <option value="">alle</option>
            {rooms.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="ohne" value="1" defaultChecked={sp.ohne === "1"} className="size-6 accent-[var(--accent)]" />
          nur ohne Etikett
        </label>
        <Button type="submit">Eingrenzen</Button>
      </form>

      <form action="/druck/inventar-etiketten" method="get" aria-label="Etiketten auswählen" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Format">
            <Select name="format" defaultValue={labelFormat(defaultFormat)} className="sm:w-80">
              {(Object.keys(LABEL_FORMATS) as (keyof typeof LABEL_FORMATS)[]).map((f) => (
                <option key={f} value={f}>
                  {LABEL_FORMATS[f].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="ab Etikett Nr. (angefangener Bogen)">
            <Select name="ab" defaultValue="1" className="w-28">
              {Array.from({ length: 52 }, (_, i) => (
                <option key={i + 1} value={String(i + 1)}>
                  {i + 1}
                </option>
              ))}
            </Select>
          </Field>
          {list.length > 0 && (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/druck/inventar-etiketten?${allQuery}`}>Alle {list.length} gefilterten drucken</Link>
            </Button>
          )}
        </div>
        {list.length === 0 ? (
          <p role="status" className="text-sm text-muted">
            Kein Inventar in dieser Auswahl.
          </p>
        ) : (
          groupsByCategory.map((g) => (
            <Card key={g.id}>
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-2 font-semibold">{g.name}</legend>
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {g.items.map((a) => (
                    <li key={a.id}>
                      <label className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                        <input type="checkbox" name="asset" value={a.id} className="size-6 accent-[var(--accent)]" />
                        <span className="min-w-0">
                          <span className="font-mono font-semibold">{a.inventoryNo}</span>
                          <span className="block truncate">{a.name}</span>
                          <span className="block text-xs text-muted">
                            {assetPlace(a)}
                            {a.labelCode ? " · Etikett vorhanden" : ""}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            </Card>
          ))
        )}
        <div>
          <Button type="submit" variant="primary">
            Gewählte drucken
          </Button>
        </div>
      </form>
    </main>
  );
}
