import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, inArray, isNull, or } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { groups } from "@/core/db/schema";
import { deleteCategoryAction, saveCategoryAction } from "@/modules/gebaeude/actions";
import { canConfigure, categoriesWithoutInspectionType, listCategories, type AssetCategoryRow } from "@/modules/gebaeude/inventar";
import { ASSET_CATEGORY_TEMPLATE } from "@/modules/gebaeude/kategorien";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { SpecForm, type FieldSpec } from "@/ui/spec-form";
import { GebaeudeNav } from "../../ui";

export const metadata: Metadata = { title: "Inventar-Kategorien" };

type Option = { value: string; label: string };

function categoryFields(groupOptions: Option[], c?: AssetCategoryRow): FieldSpec[] {
  return [
    { name: "name", label: "Name", type: "text", required: true, maxLength: 80, wide: true, defaultValue: c?.name },
    { name: "prefix", label: "Präfix der Inventarnummer", type: "text", required: true, maxLength: 6, defaultValue: c?.prefix, hint: "1 bis 6 Großbuchstaben/Ziffern, z. B. IT" },
    { name: "sortOrder", label: "Reihenfolge", type: "number", min: 0, max: 100000, defaultValue: String(c?.sortOrder ?? 500) },
    { name: "responsibleGroupId", label: "verantwortliche Gruppe", type: "select", defaultValue: c?.responsibleGroupId ?? "", options: groupOptions, hint: "pflegt das Inventar dieser Kategorie" },
    { name: "inspectionRequired", label: "prüfpflichtig (wiederkehrende Prüfungen)", type: "checkbox", checked: c ? c.inspectionRequired : false },
    { name: "active", label: "eingeschaltet", type: "checkbox", checked: c ? c.active : true },
  ];
}

/**
 * INV-01: Kategorien des Inventars (Vorlage + eigene) mit Präfix, Prüfpflicht und verantwortlicher Gruppe – Recht
 * `gebaeude.configure`. Vorlagen-Kategorien lassen sich anpassen und ausschalten, eigene ohne Inventar auch löschen.
 */
export default async function KategorienPage() {
  const { perms } = await requireUser();
  if (!canConfigure(perms)) notFound();
  const db = await getDb();
  const [categories, missing] = await Promise.all([listCategories(db), categoriesWithoutInspectionType(db)]);
  const assigned = categories.map((c) => c.responsibleGroupId).filter((g): g is string => !!g);
  const groupRows = await db
    .select({ id: groups.id, name: groups.name, archivedAt: groups.archivedAt })
    .from(groups)
    // auswählbar: Gruppen ohne Klassen-/Kursbezug; die eingetragene bleibt immer in der Liste
    .where(or(and(inArray(groups.kind, ["frei", "gremium", "fachschaft", "ag"]), isNull(groups.archivedAt)), assigned.length ? inArray(groups.id, assigned) : undefined));
  const groupOptions: Option[] = [
    { value: "", label: "keine (nur Inventar-Recht)" },
    ...groupRows.sort((a, b) => a.name.localeCompare(b.name, "de")).map((g) => ({ value: g.id, label: g.archivedAt ? `${g.name} (archiviert)` : g.name })),
  ];
  const templateKeys = new Set(ASSET_CATEGORY_TEMPLATE.map((t) => t.key));

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Inventar" title="Kategorien" />
      <GebaeudeNav current="inventar" configure />
      <p className="text-sm text-muted">
        Jede Kategorie hat ein Präfix für automatische Inventarnummern, eine Prüfpflicht (dann gehört eine eingeschaltete{" "}
        <Link href="/gebaeude/pruefarten" className="font-medium text-accent-ink hover:underline">
          Prüfart
        </Link>{" "}
        dazu) und optional eine verantwortliche Gruppe, die das Inventar dieser Kategorie pflegt (z. B. IT, Fachschaft Musik). Das Recht „Inventar pflegen“ gilt
        für alle Kategorien.{" "}
        <Link href="/gebaeude/inventar" className="font-medium text-accent-ink hover:underline">
          Zurück zum Inventar
        </Link>
      </p>
      {missing.length > 0 && <p role="note" className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">Prüfpflichtig, aber ohne eingeschaltete Prüfart: {missing.join(", ")}.</p>}
      <ul aria-label="Kategorien" className="flex flex-col gap-2">
        {categories.map((c) => (
          <li key={c.id}>
            <details className="rounded-xl border border-border bg-surface px-4 py-3">
              <summary className="flex min-h-6 cursor-pointer flex-wrap items-center gap-2">
                <span className="font-medium">{c.name}</span>
                <Badge tone="neutral">{c.prefix}</Badge>
                {!c.active && <Badge tone="neutral">aus</Badge>}
                {c.inspectionRequired && <Badge tone="warn">prüfpflichtig</Badge>}
                <span className="text-xs text-muted">
                  {c.assetCount === 1 ? "1 Eintrag" : `${c.assetCount} Einträge`}
                  {c.responsibleGroupName && ` · ${c.responsibleGroupName}`}
                  {!templateKeys.has(c.key) && " · eigene"}
                </span>
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                <SpecForm action={saveCategoryAction.bind(null, c.id)} label={`Kategorie ${c.name}`} submit="Speichern" okText="Gespeichert." columns={3} fields={categoryFields(groupOptions, c)} />
                {!templateKeys.has(c.key) && c.assetCount === 0 && (
                  <SpecForm action={deleteCategoryAction.bind(null, c.id)} label={`Kategorie ${c.name} löschen`} submit="Kategorie löschen" okText="Gelöscht." variant="secondary" columns={1} fields={[]} />
                )}
              </div>
            </details>
          </li>
        ))}
      </ul>
      <Card aria-labelledby="neu">
        <CardHeader title={<span id="neu">Eigene Kategorie anlegen</span>} />
        <SpecForm action={saveCategoryAction.bind(null, null)} label="Eigene Kategorie anlegen" submit="Anlegen" okText="Angelegt." columns={3} fields={categoryFields(groupOptions)} />
      </Card>
    </main>
  );
}
