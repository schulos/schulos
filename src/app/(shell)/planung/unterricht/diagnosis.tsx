import Link from "next/link";
import { DIAGNOSIS_CATEGORIES, DIAGNOSIS_LABELS, type DiagnosisCategory, type DiagnosisReport, type Finding, type Severity } from "@/modules/stundenplan/diagnose";
import { Badge } from "@schulos/ui/badge";
import { cn } from "@schulos/ui/cn";
import { EmptyState } from "@schulos/ui/misc";

const SEVERITY: Record<Severity, { label: string; tone: "danger" | "warn" | "neutral" }> = {
  error: { label: "Fehler", tone: "danger" },
  warn: { label: "prüfen", tone: "warn" },
  info: { label: "Hinweis", tone: "neutral" },
};

const unterricht = (p: Record<string, string | undefined>) => {
  const q = new URLSearchParams(Object.entries(p).filter((e): e is [string, string] => Boolean(e[1])));
  return `/planung/unterricht?${q.toString()}`;
};

/** Link zum Lehrauftrag (öffnet das Bearbeiten-Formular in der Unterrichtsverteilung) */
function assignmentHref(f: Finding): string {
  return unterricht({ gruppe: f.target.kind === "group" ? f.target.id : undefined, auftrag: f.assignmentId });
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={SEVERITY[severity].tone}>{SEVERITY[severity].label}</Badge>;
}

/** Hinweise als Liste; mit `showCategory` steht die Prüfung vor jeder Zeile. */
export function FindingList({ findings, showCategory = false, linkAssignments = true }: { findings: Finding[]; showCategory?: boolean; linkAssignments?: boolean }) {
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {findings.map((f, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-2">
          <SeverityBadge severity={f.severity} />
          {showCategory && <span className="text-muted">{DIAGNOSIS_LABELS[f.category]}:</span>}
          <span>{f.message}</span>
          {linkAssignments && f.assignmentId && (
            <Link href={assignmentHref(f)} className="text-accent-ink hover:underline">
              Lehrauftrag
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

function total(c: Record<Severity, number>) {
  return c.error + c.warn + c.info;
}

export function DiagnosisView({ report, category, refLabel }: { report: DiagnosisReport; category?: DiagnosisCategory; refLabel: string }) {
  const shown = category ? report.findings.filter((f) => f.category === category) : report.findings;
  // nach Bezug gruppieren (Reihenfolge der ersten Nennung: Fehler zuerst)
  const byTarget = new Map<string, { f: Finding; items: Finding[] }>();
  for (const f of [...shown].sort((a, b) => ["error", "warn", "info"].indexOf(a.severity) - ["error", "warn", "info"].indexOf(b.severity))) {
    const k = `${f.target.kind}:${f.target.id}`;
    if (!byTarget.has(k)) byTarget.set(k, { f, items: [] });
    byTarget.get(k)!.items.push(f);
  }
  const groupsFirst = [...byTarget.values()].sort((a, b) => (a.f.target.kind === b.f.target.kind ? 0 : a.f.target.kind === "group" ? -1 : 1));
  return (
    <section aria-labelledby="dg" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="dg" className="font-display text-xl font-bold">
          Diagnose
        </h2>
        <p className="text-sm text-muted">Prüft Stundenplan ({refLabel}), Lehraufträge, Stundentafel und Deputate. Ein Klick auf eine Prüfung filtert die Liste.</p>
      </div>
      <nav aria-label="Prüfungen" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
        {DIAGNOSIS_CATEGORIES.map((c) => {
          const n = report.counts[c];
          const active = category === c;
          return (
            <Link
              key={c}
              href={unterricht({ ansicht: "diagnose", kategorie: active ? undefined : c })}
              aria-current={active ? "true" : undefined}
              className={cn(
                "flex flex-col gap-2 rounded-card border border-border bg-surface p-3 text-sm transition hover:border-accent",
                active && "border-accent bg-accent-soft",
              )}
            >
              <span className="font-medium">{DIAGNOSIS_LABELS[c]}</span>
              <span className="flex flex-wrap gap-1">
                {total(n) === 0 ? (
                  <Badge tone="success">in Ordnung</Badge>
                ) : (
                  (["error", "warn", "info"] as const)
                    .filter((s) => n[s] > 0)
                    .map((s) => (
                      <Badge key={s} tone={SEVERITY[s].tone}>
                        {n[s]} {SEVERITY[s].label}
                      </Badge>
                    ))
                )}
              </span>
            </Link>
          );
        })}
      </nav>
      {groupsFirst.length === 0 ? (
        <EmptyState title={category ? `${DIAGNOSIS_LABELS[category]}: alles in Ordnung` : "Keine Auffälligkeiten"} />
      ) : (
        <div className="flex flex-col gap-3">
          {groupsFirst.map(({ f, items }) => (
            <article key={`${f.target.kind}:${f.target.id}`} className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4" aria-label={f.target.label}>
              <h3 className="flex flex-wrap items-center gap-2 font-semibold">
                <Link
                  href={
                    f.target.kind === "teacher"
                      ? unterricht({ ansicht: "lehrkraefte", lehrkraft: f.target.id })
                      : f.target.kind === "band"
                        ? unterricht({ ansicht: "baender", band: f.target.id })
                        : unterricht({ gruppe: f.target.id })
                  }
                  className="hover:underline"
                >
                  {f.target.label}
                </Link>
                <span className="text-xs font-normal text-muted">{f.target.kind === "teacher" ? "Lehrkraft" : f.target.kind === "band" ? "Band" : "Klasse/Kurs"}</span>
                {f.target.kind === "group" && (
                  <Link href={`/planung/stundenplan?gruppe=${encodeURIComponent(f.target.id)}`} className="ml-auto text-sm font-normal text-accent-ink hover:underline">
                    Plan bearbeiten
                  </Link>
                )}
              </h3>
              <FindingList findings={items} showCategory={!category} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
