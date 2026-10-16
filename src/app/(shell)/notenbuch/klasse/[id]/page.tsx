import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { schoolYears } from "@/core/db/schema";
import { toBerlinDate } from "@/core/time";
import { notenbuchPageLocked } from "@/modules/notenbuch/guard";
import { currentTerm, handoverGrid, hasNotenbuchRight, EXPORT, notenbuchAccess, termOverview } from "@/modules/notenbuch/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { NotenbuchLocked } from "../../gesperrt";

export const metadata: Metadata = { title: "Übergabeliste" };
export const dynamic = "force-dynamic";

/**
 * Übergabeliste je Klasse (P5-13): Halbjahreswerte aller Fächer für Klassenleitung und `notenbuch.term_view` – nie Teilnoten.
 * Jeder Abruf steht im Audit-Log (`termOverview`). Deutlich als Entwurf gekennzeichnet; kein Zeugnisdruck, nur CSV-Export (POST).
 */
export default async function HandoverPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sj?: string; hj?: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  if (!(await notenbuchAccess(db, perms)).any) notFound(); // Schüler-/Elternsicht (P5-14) nur unter /notenbuch
  const gate = await notenbuchPageLocked(db, perms.userId);
  if (gate) return <NotenbuchLocked reason={gate} />;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const groupId = decodeURIComponent(id);
  const now = new Date();
  const current = await currentTerm(db, toBerlinDate(now));
  const years = await db.select({ id: schoolYears.id, name: schoolYears.name, startsOn: schoolYears.startsOn }).from(schoolYears);
  const yearId = years.some((y) => y.id === sp.sj) ? sp.sj! : (current?.schoolYearId ?? [...years].sort((a, b) => (a.startsOn < b.startsOn ? 1 : -1))[0]?.id ?? "");
  const term = sp.hj === "2" ? 2 : sp.hj === "1" ? 1 : (current?.term ?? 1);
  const overview = await termOverview(db, perms, groupId, now, { schoolYearId: yearId, term });
  if (!overview) notFound();
  const yearName = years.find((y) => y.id === yearId)?.name ?? "";
  const canExport = hasNotenbuchRight(perms, EXPORT);

  // G5A-C07: je Fach und Lerngruppe eine Spalte (Klasse und z. B. Förderkurs im selben Fach)
  const { columns, cells } = handoverGrid(overview.groupName, overview.grades);
  const label = (c: (typeof columns)[number]) => (c.groupName ? `${c.subjectName} (${c.groupName})` : c.subjectName);
  const href = (y: string, t: number) => `/notenbuch/klasse/${encodeURIComponent(groupId)}?sj=${encodeURIComponent(y)}&hj=${t}`;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`Notenbuch · Übergabeliste · ${yearName} · ${term}. Halbjahr`}
        title={overview.groupName}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link href="/notenbuch" prefetch={false}>
              Notenbuch
            </Link>
          </Button>
        }
      />
      <p role="note" className="rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm font-medium text-warn">
        Entwurf – amtlich ist die Schulverwaltungssoftware. Diese Liste dient nur der Übergabe der Halbjahreswerte; Zeugnisse entstehen dort. Jeder
        Abruf wird protokolliert.
      </p>
      <nav aria-label="Halbjahr" className="flex flex-wrap items-center gap-2 text-sm">
        {years.length > 1 &&
          years.map((y) => (
            <Link key={y.id} href={href(y.id, term)} prefetch={false} className={y.id === yearId ? "font-semibold" : "text-accent-ink hover:underline"} aria-current={y.id === yearId ? "page" : undefined}>
              {y.name}
            </Link>
          ))}
        {[1, 2].map((t) => (
          <Link key={t} href={href(yearId, t)} prefetch={false} className={t === term ? "font-semibold" : "text-accent-ink hover:underline"} aria-current={t === term ? "page" : undefined}>
            {t}. Halbjahr
          </Link>
        ))}
      </nav>
      {columns.length === 0 ? (
        <EmptyState title="Noch keine Halbjahreswerte">Für dieses Halbjahr hat noch keine Fachlehrkraft ein Notenbuch mit Werten für die Klasse geführt.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full border-collapse text-left text-sm" aria-label={`Halbjahreswerte ${overview.groupName}`}>
            <thead>
              <tr className="text-xs text-muted">
                <th scope="col" className="sticky left-0 bg-surface px-3 py-2 font-semibold">
                  Name
                </th>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className="px-3 py-2 font-semibold" title={label(c)}>
                    {c.subjectId}
                    {c.groupName && <span className="block text-xs font-normal text-muted">{c.groupName}</span>}
                    {c.locked && <span className="sr-only"> (abgeschlossen)</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {overview.students.map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <th scope="row" className="sticky left-0 bg-surface px-3 py-2 text-left font-medium whitespace-nowrap">
                    {s.name}
                  </th>
                  {columns.map((c) => {
                    const g = cells.get(`${s.id}:${c.key}`);
                    return (
                      <td key={c.key} className="px-3 py-2">
                        {g?.final ? (
                          <span className="font-semibold">{g.final}</span>
                        ) : g?.computed ? (
                          <span className="text-muted" title="Vorschlag, noch nicht festgelegt">
                            ({g.computed})
                          </span>
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted">
        Fett = von der Fachlehrkraft festgelegt, (in Klammern) = berechneter Vorschlag, noch nicht festgelegt. Abgeschlossene Fächer:{" "}
        {columns.some((c) => c.locked) ? columns.filter((c) => c.locked).map(label).join(", ") : "noch keine"}.{" "}
        {columns.length > 0 && <Badge>{columns.length} Fächer</Badge>}
      </p>
      {canExport && (
        <Card aria-labelledby="export">
          <h2 id="export" className="text-base font-semibold">
            Export für die Schulverwaltungssoftware
          </h2>
          <form method="post" action="/api/notenbuch/export" className="flex flex-wrap items-end gap-3" aria-label="Halbjahreswerte exportieren">
            <input type="hidden" name="groupId" value={groupId} />
            <input type="hidden" name="schoolYearId" value={yearId} />
            <input type="hidden" name="term" value={term} />
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Zeichensatz
              <Select name="encoding" defaultValue="utf8">
                <option value="utf8">UTF-8</option>
                <option value="cp1252">Windows-1252 (ältere Programme)</option>
              </Select>
            </label>
            <Button type="submit">CSV herunterladen</Button>
          </form>
          <p className="text-xs text-muted">Nur festgelegte Halbjahresnoten (offene bleiben leer), keine Teilnoten oder Kommentare. Jeder Export wird protokolliert.</p>
        </Card>
      )}
    </main>
  );
}
