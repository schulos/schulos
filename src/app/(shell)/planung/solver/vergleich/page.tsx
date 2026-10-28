import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Check } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import {
  EFFORT_LABELS,
  getRun,
  PRESET_LABELS,
  type StoredResult,
} from "@/modules/stundenplan/solverlauf";
import {
  GROUP_LABELS,
  loadComparison,
  loadVersionComparison,
  parseCompareIds,
  type CompareRow,
} from "@/modules/stundenplan/solververgleich";
import { STATUS_LABELS } from "@/modules/stundenplan/planversionen";
import { defaultObligation } from "@/modules/stundenplan/deputate";
import { readSchoolSettings } from "@/core/settings";
import { toBerlinDate } from "@/core/time";
import { Badge } from "@schulos/ui/badge";
import { PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { duration, num, runTitle, timeFmt } from "../format";
import {
  loadPreviewContext,
  parsePreview,
  PreviewGrid,
  previewExists,
  previewLessons,
  previewName,
} from "../preview";
import { RUN_STATUS, WEIGHT_FIELDS } from "../status";
import { PreviewPicker } from "../[id]/preview-picker";

export const metadata: Metadata = { title: "Läufe vergleichen" };

const MINUS = "−";

/** Unterschied zum ersten Lauf mit Vorzeichen (nie nur Farbe: das Zeichen trägt die Information). */
function deltaText(row: CompareRow, d: number): string {
  if (d === 0) return "±0";
  const abs =
    row.unit === "ms" ? duration(Math.abs(d)) : num.format(Math.abs(d));
  return `${d > 0 ? "+" : MINUS}${abs}`;
}

const valueText = (row: CompareRow, v: number) =>
  row.unit === "ms" ? duration(v) : num.format(v);

/**
 * SP-08: 2–3 Solver-Läufe nebeneinander – Kennzahlen aus `metrics` (keine Diagnose je Aufruf) mit bestem Wert je Zeile und Delta
 * zum ersten Lauf, Parameter mit Abweichungen, Vorschau einer Klasse oder Lehrkraft nebeneinander (erst auf Wunsch).
 */
export default async function SolverComparePage({
  searchParams,
}: {
  searchParams: Promise<{ laeufe?: string | string[]; vorschau?: string; versionen?: string | string[] }>;
}) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.manage")) notFound();
  const sp = await searchParams;
  // SP3-02: zweite Quelle „Version“ – Variantenvergleich von Entwürfen/Versionen
  if (sp.versionen) return <VersionCompare ids={parseCompareIds(sp.versionen)} />;
  const ids = parseCompareIds(sp.laeufe);
  const db = await getDb();
  const result = await loadComparison(db, ids);

  const back = (
    <Link
      href="/planung/solver"
      className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
    >
      <ArrowLeft aria-hidden className="size-4" /> Alle Läufe
    </Link>
  );
  if (!result.ok) {
    return (
      <main className="flex flex-col gap-6">
        {back}
        <PageHeader
          eyebrow="Stundenplanung · Automatisch planen"
          title="Läufe vergleichen"
        />
        <p
          role="alert"
          className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {result.problem}
        </p>
        <p className="text-sm text-muted">
          In der Liste der Läufe zwei oder drei fertige Läufe ankreuzen und
          „Ausgewählte Läufe vergleichen“ wählen.
        </p>
      </main>
    );
  }

  const { runs, rows } = result.comparison;
  const groups = [...new Set(rows.map((r) => r.group))];
  const want = parsePreview(sp.vorschau);
  const ctx = await loadPreviewContext(db, true);
  const preview = previewExists(ctx, want) ? want : null;
  const full = preview
    ? await Promise.all(runs.map((r) => getRun(db, r.id)))
    : [];
  const lessons = preview
    ? await Promise.all(
        full.map((r) =>
          r?.stored
            ? previewLessons(db, r.stored as StoredResult, preview)
            : Promise.resolve(null),
        ),
      )
    : [];
  const idsParam = runs.map((r) => r.id).join(",");
  const gridCols =
    runs.length === 3 ? "xl:grid-cols-3 lg:grid-cols-2" : "lg:grid-cols-2";

  const paramRows = [
    {
      key: "effort",
      label: "Gründlichkeit",
      get: (r: (typeof runs)[number]) =>
        r.params ? EFFORT_LABELS[r.params.effort] : "–",
    },
    {
      key: "preset",
      label: "Gewichtung",
      get: (r: (typeof runs)[number]) =>
        r.params ? PRESET_LABELS[r.params.preset] : "–",
    },
    {
      key: "refYmd",
      label: "Lehraufträge am",
      get: (r: (typeof runs)[number]) => r.params?.refYmd ?? "Tag der Berechnung",
    },
    {
      key: "seed",
      label: "Startwert",
      get: (r: (typeof runs)[number]) => String(r.params?.seed ?? r.seed),
    },
    {
      key: "passes",
      label: "Durchgänge",
      get: (r: (typeof runs)[number]) =>
        r.params?.passes
          ? `${r.params.passes}, bester: Durchgang ${r.metrics?.passes?.best ?? "–"} (Startwert ${r.metrics?.passes?.list[(r.metrics.passes.best ?? 1) - 1]?.seed ?? "–"})`
          : "Einzellauf",
    },
    ...WEIGHT_FIELDS.map((f) => ({
      key: f.key,
      label: f.label,
      get: (r: (typeof runs)[number]) =>
        r.params ? String(r.params.weights[f.key]) : "–",
    })),
  ].map((p) => {
    const cells = runs.map(p.get);
    return { ...p, cells, differs: new Set(cells).size > 1 };
  });

  return (
    <main className="flex flex-col gap-6">
      {back}
      <PageHeader
        eyebrow="Stundenplanung · Automatisch planen"
        title="Läufe vergleichen"
      />
      <p className="-mt-3 max-w-3xl text-sm text-muted">
        Kleiner ist bei jeder Zeile besser; der beste Wert ist markiert. Der
        Unterschied bezieht sich auf den ersten Lauf ({runTitle(runs[0]!)}).
      </p>

      <section aria-labelledby="kenn-title" className="flex flex-col gap-3">
        <h2 id="kenn-title" className="font-display text-xl font-bold">
          Kennzahlen
        </h2>
        <Table scrollLabel="Kennzahlen im Vergleich">
          <caption className="sr-only">
            Kennzahlen der verglichenen Läufe, bester Wert je Zeile markiert,
            Unterschied zum ersten Lauf
          </caption>
          <thead>
            <tr>
              <th scope="col">Kennzahl</th>
              {runs.map((r) => (
                <th key={r.id} scope="col" className="min-w-40 !normal-case">
                  <Link
                    href={`/planung/solver/${r.id}`}
                    className="text-sm font-semibold tracking-normal text-accent-ink underline-offset-2 hover:underline"
                  >
                    {runTitle(r)}
                  </Link>
                  <span className="mt-0.5 block text-xs font-normal tracking-normal text-muted">
                    {timeFmt.format(r.createdAt)} · {RUN_STATUS[r.status].label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g}>
              <tr>
                <th
                  scope="colgroup"
                  colSpan={runs.length + 1}
                  className="bg-surface-2"
                >
                  {GROUP_LABELS[g]}
                </th>
              </tr>
              {rows
                .filter((r) => r.group === g)
                .map((row) => (
                  <tr key={row.key}>
                    <th
                      scope="row"
                      className="!font-normal !tracking-normal !normal-case !text-ink"
                    >
                      {row.label}
                    </th>
                    {row.values.map((v, i) => {
                      const best = row.best.includes(i);
                      return (
                        <td
                          key={runs[i]!.id}
                          className={`tabular-nums ${best ? "bg-accent-soft font-semibold text-accent-ink" : ""}`}
                        >
                          {valueText(row, v)}
                          {i > 0 && (
                            <span className="ml-2 text-xs font-normal text-muted">
                              {deltaText(row, row.deltas[i]!)}
                            </span>
                          )}
                          {best && (
                            <Badge tone="success" className="ml-2">
                              <Check aria-hidden className="size-3" /> Bestwert
                            </Badge>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          ))}
        </Table>
      </section>

      <section aria-labelledby="param-title" className="flex flex-col gap-3">
        <h2 id="param-title" className="font-display text-xl font-bold">
          Parameter
        </h2>
        <Table scrollLabel="Parameter im Vergleich">
          <caption className="sr-only">
            Parameter der verglichenen Läufe, Abweichungen markiert
          </caption>
          <thead>
            <tr>
              <th scope="col">Parameter</th>
              {runs.map((r) => (
                <th key={r.id} scope="col" className="!normal-case">
                  {runTitle(r)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paramRows.map((p) => (
              <tr key={p.key}>
                <th
                  scope="row"
                  className="!font-normal !tracking-normal !normal-case !text-ink"
                >
                  {p.label}
                  {p.differs && (
                    <Badge tone="warn" className="ml-2">
                      abweichend
                    </Badge>
                  )}
                </th>
                {p.cells.map((c, i) => (
                  <td key={runs[i]!.id} className="tabular-nums">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      </section>

      <section aria-labelledby="preview-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="preview-title" className="font-display text-xl font-bold">
            Vorschau {preview ? `· ${previewName(ctx, preview)}` : ""}
          </h2>
          <PreviewPicker
            action="/planung/solver/vergleich"
            hidden={{ laeufe: idsParam }}
            value={preview ? (sp.vorschau ?? "") : ""}
            groups={ctx.options.groups}
            teachers={ctx.options.teachers}
          />
        </div>
        {!preview ? (
          <p className="text-sm text-muted">
            Klasse, Kurs oder Lehrkraft wählen, um die Vorschläge nebeneinander
            als Wochenplan zu sehen.
          </p>
        ) : (
          <div className={`grid gap-4 ${gridCols}`}>
            {runs.map((r, i) => (
              <div key={r.id} className="flex min-w-0 flex-col gap-2">
                <h3 className="text-base font-semibold">{runTitle(r)}</h3>
                {lessons[i] ? (
                  <PreviewGrid
                    ctx={ctx}
                    p={preview}
                    lessons={lessons[i]!}
                    caption={`Vorschlag ${runTitle(r)} · ${previewName(ctx, preview)}`}
                  scrollLabel={`Wochenplan ${runTitle(r)}`}
                  />
                ) : (
                  <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
                    Das Ergebnis wurde beim Aufräumen entfernt – keine Vorschau.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

const ymdFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });

/**
 * SP3-02 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.5): Variantenvergleich – 2–3 Versionen (Entwürfe an ihrem Stichtag, veröffentlichte wie in
 * der Versionsliste) mit Kennzahlen aus ihrem Wochenplan, bestem Wert je Zeile und Delta zur ersten; Sprung in die Änderungen je Person.
 */
async function VersionCompare({ ids }: { ids: string[] }) {
  const db = await getDb();
  const school = await readSchoolSettings(db);
  const result = await loadVersionComparison(db, ids, toBerlinDate(new Date()), defaultObligation(school.profile.form));
  const back = (
    <Link href="/planung/versionen" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
      <ArrowLeft aria-hidden className="size-4" /> Planversionen
    </Link>
  );
  if (!result.ok) {
    return (
      <main className="flex flex-col gap-6">
        {back}
        <PageHeader eyebrow="Stundenplanung · Planversionen" title="Varianten vergleichen" />
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {result.problem}
        </p>
      </main>
    );
  }
  const { versions, rows } = result;
  const groups = [...new Set(rows.map((r) => r.group))];
  const first = versions[0]!;
  return (
    <main className="flex flex-col gap-6">
      {back}
      <PageHeader eyebrow="Stundenplanung · Planversionen" title="Varianten vergleichen" />
      <p className="-mt-3 max-w-3xl text-sm text-muted">
        Kennzahlen aus dem Wochenplan jeder Version und der Diagnose gegen sie. Kleiner ist besser (Wochenstunden nur zur Information); der beste Wert ist markiert,
        der Unterschied bezieht sich auf Version {first.label}.
      </p>
      <Table scrollLabel="Kennzahlen der Versionen im Vergleich">
        <caption className="sr-only">Kennzahlen der verglichenen Versionen, bester Wert je Zeile markiert, Unterschied zur ersten Version</caption>
        <thead>
          <tr>
            <th scope="col">Kennzahl</th>
            {versions.map((v) => (
              <th key={v.id} scope="col" className="min-w-40 !normal-case">
                <span className="text-sm font-semibold tracking-normal">
                  Version {v.label} „{v.name}“
                </span>
                <span className="mt-0.5 block text-xs font-normal tracking-normal text-muted">
                  {STATUS_LABELS[v.status]} · Plan am {ymdFmt.format(new Date(`${v.refYmd}T00:00:00Z`))}
                </span>
                {v.id !== first.id && (
                  <Link
                    href={`/planung/versionen/aenderungen?version=${encodeURIComponent(v.id)}&mit=${encodeURIComponent(first.id)}`}
                    className="mt-0.5 block text-xs font-normal tracking-normal text-accent-ink hover:underline"
                  >
                    Änderungen zu {first.label}
                  </Link>
                )}
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g}>
            <tr>
              <th scope="colgroup" colSpan={versions.length + 1} className="bg-surface-2">
                {g === "gesamt" ? "Plan und Diagnose" : GROUP_LABELS[g]}
              </th>
            </tr>
            {rows
              .filter((r) => r.group === g)
              .map((row) => (
                <tr key={row.key}>
                  <th scope="row" className="!font-normal !tracking-normal !normal-case !text-ink">
                    {row.label}
                  </th>
                  {row.values.map((v, i) => {
                    const best = row.best.includes(i);
                    return (
                      <td key={versions[i]!.id} className={`tabular-nums ${best ? "bg-accent-soft font-semibold text-accent-ink" : ""}`}>
                        {valueText(row, v)}
                        {i > 0 && <span className="ml-2 text-xs font-normal text-muted">{deltaText(row, row.deltas[i]!)}</span>}
                        {best && (
                          <Badge tone="success" className="ml-2">
                            <Check aria-hidden className="size-3" /> Bestwert
                          </Badge>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
          </tbody>
        ))}
      </Table>
    </main>
  );
}
