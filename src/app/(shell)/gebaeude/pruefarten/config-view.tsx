import { and, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "@/core/db/client";
import { groups } from "@/core/db/schema";
import { saveInspectionTypeAction, setResponsibilityAction } from "@/modules/gebaeude/actions";
import {
  ASSET_KIND_LABELS,
  ASSET_KINDS,
  CATEGORY_LABELS,
  INSPECTION_RESPONSIBLES,
  INSPECTION_TARGET_LABELS,
  INSPECTION_TARGETS,
  RESPONSIBLE_LABELS,
  TICKET_CATEGORIES,
} from "@/modules/gebaeude/labels";
import { listInspectionTypes } from "@/modules/gebaeude/pruefungen";
import { listResponsibilities } from "@/modules/gebaeude/service";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { SpecForm, type FieldSpec } from "../spec-form";

type TypeRow = Awaited<ReturnType<typeof listInspectionTypes>>[number];

function typeFields(t?: TypeRow): FieldSpec[] {
  return [
    { name: "name", label: "Name", type: "text", required: true, maxLength: 120, wide: true, defaultValue: t?.name },
    { name: "appliesTo", label: "gilt für", type: "select", defaultValue: t?.appliesTo ?? "anlage", options: INSPECTION_TARGETS.map((x) => ({ value: x, label: INSPECTION_TARGET_LABELS[x] })) },
    {
      name: "assetKind",
      label: "Anlagen-Art (automatisch planen)",
      type: "select",
      defaultValue: t?.assetKind ?? "",
      options: [{ value: "", label: "–" }, ...ASSET_KINDS.map((k) => ({ value: k, label: ASSET_KIND_LABELS[k] }))],
    },
    // Q5-29: offene Prüfungen behalten ihren Termin (planDue legt nur neue an) – das soll beim Ändern nicht überraschen
    {
      name: "intervalMonths",
      label: "Intervall (Monate)",
      type: "number",
      min: 1,
      max: 120,
      required: true,
      defaultValue: String(t?.intervalMonths ?? 12),
      hint: "gilt ab der nächsten erfassten Prüfung – offene behalten ihren Termin",
    },
    { name: "warnDays", label: "Vorwarnzeit (Tage)", type: "number", min: 0, max: 365, required: true, defaultValue: String(t?.warnDays ?? 30) },
    {
      name: "responsible",
      label: "zuständig",
      type: "select",
      defaultValue: t?.responsible ?? "schultraeger",
      options: INSPECTION_RESPONSIBLES.map((r) => ({ value: r, label: RESPONSIBLE_LABELS[r] })),
    },
    { name: "source", label: "Quelle", type: "text", maxLength: 300, wide: true, defaultValue: t?.source, hint: "Hinweis zum Nachlesen, z. B. „DGUV Vorschrift 3 – zu prüfen“" },
    { name: "note", label: "Bemerkung", type: "text", maxLength: 500, wide: true, defaultValue: t?.note ?? "" },
    { name: "active", label: "eingeschaltet", type: "checkbox", checked: t ? t.active : true },
  ];
}

/**
 * Prüfarten aus der Vorlage einschalten/anpassen, eigene anlegen, Zuständigkeiten je Kategorie (Recht `gebaeude.configure`).
 * Erreichbar unter Verwaltung → Gebäude & Technik und im Modul selbst (/gebaeude/pruefarten, ohne Verwaltungszugang).
 */
export async function GebaeudeConfig() {
  const db = await getDb();
  const [types, resp] = await Promise.all([listInspectionTypes(db), listResponsibilities(db)]);
  const assigned = resp.map((r) => r.groupId);
  const groupRows = await db
    .select({ id: groups.id, name: groups.name, archivedAt: groups.archivedAt })
    .from(groups)
    // auswählbar: Gruppen ohne Klassen-/Kursbezug; die aktuell eingetragene bleibt immer in der Liste (Code-Review Gate 4a N6)
    .where(or(and(inArray(groups.kind, ["frei", "gremium", "fachschaft", "ag"]), isNull(groups.archivedAt)), assigned.length ? inArray(groups.id, assigned) : undefined));
  const groupOptions = [
    { value: "", label: "Vorgabe (Gruppe der Kategorie „Gebäude“)" },
    ...groupRows.sort((a, b) => a.name.localeCompare(b.name, "de")).map((g) => ({ value: g.id, label: g.archivedAt ? `${g.name} (archiviert)` : g.name })),
  ];
  const respOf = new Map(resp.map((r) => [r.category, r.groupId]));
  return (
    <>
      <section aria-labelledby="pruefarten" className="flex flex-col gap-3">
        <h2 id="pruefarten" className="font-display text-xl font-bold">
          Prüfarten
        </h2>
        <p className="text-sm text-muted">
          Vorlage mit zwölf typischen Prüfungen an Schulen. Intervalle sind Annahmen, Quellen Hinweise – <strong>alles zu prüfen</strong>: SchulOS behauptet keine
          Rechtsverbindlichkeit, maßgeblich sind Schulträger und Fachkraft für Arbeitssicherheit. Eingeschaltete Prüfarten mit Anlagen-Art werden für alle passenden
          Anlagen automatisch geplant.
        </p>
        <ul aria-label="Prüfarten" className="flex flex-col gap-2">
          {types.map((t) => (
            <li key={t.id}>
              <details className="rounded-xl border border-border bg-surface px-4 py-3">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  <Badge tone={t.active ? "success" : "neutral"}>{t.active ? "an" : "aus"}</Badge>
                  <span className="text-xs text-muted">
                    alle {t.intervalMonths} Monate · {INSPECTION_TARGET_LABELS[t.appliesTo]}
                    {t.assetKind ? ` (${ASSET_KIND_LABELS[t.assetKind]})` : ""} · {RESPONSIBLE_LABELS[t.responsible]}
                  </span>
                </summary>
                <div className="mt-3">
                  <SpecForm action={saveInspectionTypeAction.bind(null, t.id)} label={`Prüfart ${t.name}`} submit="Speichern" okText="Gespeichert." columns={3} fields={typeFields(t)} />
                </div>
              </details>
            </li>
          ))}
        </ul>
        <Card aria-labelledby="eigene">
          <CardHeader title={<span id="eigene">Eigene Prüfart anlegen</span>} />
          <SpecForm action={saveInspectionTypeAction.bind(null, null)} label="Eigene Prüfart anlegen" submit="Anlegen" okText="Angelegt." columns={3} fields={typeFields()} />
        </Card>
      </section>

      <Card aria-labelledby="zustaendig">
        <CardHeader title={<span id="zustaendig">Zuständigkeiten je Kategorie</span>} />
        <p className="text-sm text-muted">
          Diese Gruppe bekommt den Gong bei neuen Meldungen der Kategorie (z. B. IT/Medien an eine eigene Gruppe). Ohne Eintrag gilt die Gruppe der Kategorie „Gebäude“,
          sonst alle, die Meldungen bearbeiten dürfen.
        </p>
        <SpecForm
          action={setResponsibilityAction}
          label="Zuständigkeiten"
          submit="Speichern"
          okText="Gespeichert."
          columns={3}
          fields={TICKET_CATEGORIES.map((c) => ({ name: `group-${c}`, label: CATEGORY_LABELS[c], type: "select" as const, defaultValue: respOf.get(c) ?? "", options: groupOptions }))}
        />
      </Card>
    </>
  );
}
