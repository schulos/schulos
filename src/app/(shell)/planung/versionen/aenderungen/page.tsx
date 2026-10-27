import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { WEEKDAYS } from "@/modules/stundenplan/manage";
import { comparableVersions, DIFF_FIELD_LABELS, DIFF_KIND_LABELS, diffNames, loadPlanDiff, type DiffEntry, type DiffKind, type DiffLesson, type DiffNames } from "@/modules/stundenplan/plan-diff";
import { canSeeVersion, type Viewer } from "@/modules/stundenplan/planpruefung";
import { getVersion, STATUS_LABELS, versionNumber } from "@/modules/stundenplan/planversionen";
import { PLAN_MANAGE, PLAN_REVIEW } from "@/modules/stundenplan/rechte";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Änderungen einer Planversion" };

const dateFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const date = (ymd: string) => dateFmt.format(fromBerlinLocal(ymd));

const KIND_TONES: Record<DiffKind, "neutral" | "soft" | "warn" | "success" | "danger"> = { unchanged: "neutral", changed: "warn", added: "success", removed: "danger" };

/** Eine Stunde als kurze Zeile: „Mo 3. · Deutsch · Klasse 7b · BRA · R 101“. */
function lessonText(l: DiffLesson, names: DiffNames): string {
  const t = l.teacherId ? names.teachers.get(l.teacherId) : undefined;
  return [
    `${WEEKDAYS[l.weekday]} ${l.periodNr}.`,
    names.subjects.get(l.subjectId) ?? l.subjectId,
    names.groups.get(l.groupId)?.name ?? l.groupId,
    l.teacherId ? (t?.code ?? t?.name ?? "Lehrkraft") : "ohne Lehrkraft",
    l.roomId ? `R ${l.roomId}` : "ohne Raum",
    ...(l.week !== "all" ? [`${l.week}-Woche`] : []),
  ].join(" · ");
}

function EntryItem({ e, names }: { e: DiffEntry; names: DiffNames }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <Badge tone={KIND_TONES[e.kind]}>{DIFF_KIND_LABELS[e.kind]}</Badge>
      {e.before && <span className={e.kind === "removed" ? "text-muted line-through" : e.kind === "changed" ? "text-muted" : ""}>{lessonText(e.before, names)}</span>}
      {e.kind === "changed" && <ArrowRight aria-label="wird zu" className="size-4 shrink-0 self-center text-muted" />}
      {e.after && <span>{lessonText(e.after, names)}</span>}
      {e.changes.length > 0 && <span className="text-xs text-muted">({e.changes.map((c) => DIFF_FIELD_LABELS[c]).join(", ")})</span>}
    </li>
  );
}

/**
 * SP3-02 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.3, §4 Schritt 7): Änderungen einer Version gegenüber dem gültigen Plan an ihrem Stichtag oder
 * gegenüber einer anderen Version – je Lehrkraft und je Klasse/Kurs (Diff-Engine `planDiff()`). Nur `stundenplan.manage`; SP3-03: auch die
 * Prüfung (`stundenplan.review`) für Versionen ab „in Prüfung“ – Vergleich nur mit Versionen, die sie sehen darf.
 */
export default async function AenderungenPage({ searchParams }: { searchParams: Promise<{ version?: string; mit?: string; ansicht?: string }> }) {
  const { user, perms } = await requireUser();
  const viewer: Viewer = { userId: user.id, manage: hasPermission(perms, PLAN_MANAGE), review: hasPermission(perms, PLAN_REVIEW) };
  if (!viewer.manage && !viewer.review) notFound();
  const sp = await searchParams;
  if (!sp.version) notFound();
  const db = await getDb();
  if (!viewer.manage) {
    // Prüfung: nur Versionen ab „in Prüfung“, auch als Vergleich (wie „gibt es nicht“)
    for (const id of [sp.version, sp.mit && sp.mit !== "gueltig" ? sp.mit : null]) {
      const v = id ? await getVersion(db, id) : null;
      if (id && (!v || !canSeeVersion(viewer, v))) notFound();
    }
  }
  const today = toBerlinDate(new Date());
  const result = await loadPlanDiff(db, sp.version, sp.mit && sp.mit !== "gueltig" ? sp.mit : null, today);
  const back = (
    <Link href="/planung/versionen" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
      <ArrowLeft aria-hidden className="size-4" /> Planversionen
    </Link>
  );
  if (!result.ok) {
    return (
      <main className="flex flex-col gap-6">
        {back}
        <PageHeader eyebrow="Stundenplanung · Planversionen" title="Änderungen" />
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {result.problem}
        </p>
      </main>
    );
  }
  const { before, after, diff, version } = result;
  const [names, comparable] = await Promise.all([diffNames(db), comparableVersions(db, version)]);
  const others = comparable.filter((o) => canSeeVersion(viewer, o));
  const byGroup = sp.ansicht === "klassen";
  const groupsMap = byGroup ? diff.byGroup : diff.byTeacher;
  const label = (id: string) => {
    if (byGroup) return names.groups.get(id)?.name ?? id;
    const t = names.teachers.get(id);
    return t ? `${t.code ? `${t.code} – ` : ""}${t.name}` : "Lehrkraft (Konto gelöscht)";
  };
  const people = [...groupsMap.entries()].sort((a, b) => label(a[0]).localeCompare(label(b[0]), "de", { numeric: true }));
  const q = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { version: version.id, mit: sp.mit, ansicht: sp.ansicht, ...extra };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/planung/versionen/aenderungen?${p.toString()}`;
  };
  const kinds: DiffKind[] = ["changed", "added", "removed", "unchanged"];
  return (
    <main className="flex flex-col gap-6">
      {back}
      <PageHeader eyebrow="Stundenplanung · Planversionen" title={`Änderungen · Version ${versionNumber(version)}`} />
      <p className="-mt-3 max-w-3xl text-sm text-muted">
        {after.label} (Wochenplan am {date(after.refYmd)}) gegenüber {before.label}
        {before.source.kind === "draft" ? ` (am ${date(before.refYmd)})` : ""}. Zusammengehörige Stunden erkennt der Vergleich an ihrer Herkunft aus dem
        gültigen Plan, sonst an gleichem Inhalt; „geändert“ nennt, was sich ändert.
      </p>
      <form method="get" aria-label="Vergleich wählen" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="version" value={version.id} />
        {sp.ansicht && <input type="hidden" name="ansicht" value={sp.ansicht} />}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Vergleichen mit</span>
          <Select name="mit" defaultValue={sp.mit ?? "gueltig"} className="w-72 max-w-full">
            <option value="gueltig">Gültiger Plan am Stichtag</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                Version {versionNumber(o)} „{o.name}“ ({STATUS_LABELS[o.status]})
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" size="sm">
          Vergleichen
        </Button>
      </form>
      <ul aria-label="Zusammenfassung" className="flex flex-wrap gap-2 text-sm">
        {kinds.map((k) => (
          <li key={k}>
            <Badge tone={KIND_TONES[k]}>
              {DIFF_KIND_LABELS[k]}: {diff.counts[k]}
            </Badge>
          </li>
        ))}
      </ul>
      <nav aria-label="Ansicht" className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant={byGroup ? "ghost" : "secondary"}>
          <Link href={q({ ansicht: undefined })} aria-current={byGroup ? undefined : "page"}>
            Je Lehrkraft
          </Link>
        </Button>
        <Button asChild size="sm" variant={byGroup ? "secondary" : "ghost"}>
          <Link href={q({ ansicht: "klassen" })} aria-current={byGroup ? "page" : undefined}>
            Je Klasse/Kurs
          </Link>
        </Button>
      </nav>
      <section aria-labelledby="diff-title" className="flex flex-col gap-3">
        <h2 id="diff-title" className="font-display text-xl font-bold">
          {byGroup ? "Änderungen je Klasse/Kurs" : "Änderungen je Lehrkraft"} ({people.length})
        </h2>
        {people.length === 0 ? (
          <EmptyState title="Keine Änderungen">Beide Pläne stimmen überein.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="diff-liste">
            {people.map(([id, entries]) => (
              <li key={id}>
                <details className="rounded-card border border-border bg-surface px-4 py-3">
                  <summary className="cursor-pointer font-medium">
                    {label(id)}{" "}
                    <span className="text-sm font-normal text-muted">
                      · {entries.length} {entries.length === 1 ? "Änderung" : "Änderungen"}
                    </span>
                  </summary>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {entries.map((e, i) => (
                      <EntryItem key={i} e={e} names={names} />
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
