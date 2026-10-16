import { getDb } from "@/core/db/client";
import type { KurswahlVerfahren } from "@/core/db/schema";
import type { PermissionSet } from "@/core/permissions";
import { TZ } from "@/core/time";
import { wahlRows, type AngebotView } from "@/modules/kurswahl/service";
import { assignmentLines, explainAllocation, statistics } from "@/modules/kurswahl/zuteilen";
import { allocateAction, assignAction } from "@/modules/kurswahl/zuteilung-actions";
import { Badge } from "@schulos/ui/badge";
import { Table } from "@schulos/ui/table";
import { AllocateForm, AssignForm } from "../zuteilung-forms";

const stamp = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });

/** P4-63: Nachfrage je Angebot, Zuteilung berechnen (mit Protokoll), Ergebnis je Person mit Begründung und Korrektur. */
export async function ZuteilungPart({ perms, v, offers }: { perms: PermissionSet; v: KurswahlVerfahren; offers: AngebotView[] }) {
  const db = await getDb();
  const [stats, explained, rows] = await Promise.all([statistics(db, perms, v), explainAllocation(db, perms, v), wahlRows(db, perms, v)]);
  const locked = Boolean(v.transferredAt);
  const title = new Map(offers.map((o) => [o.id, o.title]));
  const cancelled = new Map((explained?.offers ?? []).filter((o) => o.cancelled).map((o) => [o.id, o.reason]));
  // P4-67: je Person und Platz eine Zeile (bei einem Kurs je Person wie bisher eine); G4E-C05: alle Plätze bis zur Höchstzahl
  const multi = v.maxCourses > 1;
  const lines = assignmentLines(rows, v.maxCourses);
  const shown = v.allocatedAt ? lines : lines.filter((l) => l.w?.manual);
  const ranks = Array.from({ length: stats[0]?.demand.byRank.length ?? 0 }, (_, i) => i);
  return (
    <section aria-labelledby="zuteilung" className="flex flex-col gap-3">
      <h2 id="zuteilung" className="font-display text-xl font-bold">
        Nachfrage und Zuteilung
      </h2>
      <Table>
        <thead>
          <tr>
            <th>Angebot</th>
            {ranks.map((r) => (
              <th key={r}>{r + 1}. Wunsch</th>
            ))}
            <th>Plätze</th>
            <th>zugeteilt</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.id}>
              <td>
                {s.title}
                {cancelled.has(s.id) && (
                  <Badge tone="warn" className="ml-2">
                    fällt aus
                  </Badge>
                )}
              </td>
              {ranks.map((r) => (
                <td key={r} className="tabular-nums">
                  {s.demand.byRank[r] ?? 0}
                </td>
              ))}
              <td className="tabular-nums">
                {s.minSize > 0 ? `${s.minSize}–` : ""}
                {s.maxSize ?? "∞"}
              </td>
              <td className="tabular-nums">{s.assigned}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      {!locked && !v.allocatedAt && v.allocationSeed && (
        <p role="status" className="rounded-xl border border-warn-border bg-warn-soft p-3 text-sm text-warn">
          Zuteilung veraltet – seit der letzten Berechnung haben sich Wahlen oder Angebote geändert. Bitte neu berechnen.
        </p>
      )}
      {!locked && <AllocateForm action={allocateAction.bind(null, v.id)} again={Boolean(v.allocatedAt)} />}
      {v.allocatedAt && (
        <div className="flex flex-col gap-1 text-sm text-muted">
          <p>
            Zuletzt berechnet am {stamp.format(v.allocatedAt)} · Los-Seed <code>{v.allocationSeed}</code> (gleicher Seed und gleiche Wahlen ergeben dasselbe Ergebnis)
          </p>
          {explained && explained.log.length > 0 && (
            <ul aria-label="Protokoll der Zuteilung" className="list-disc pl-5">
              {explained.log.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {shown.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th>Schüler:in</th>
              <th>Klasse</th>
              <th>Wünsche</th>
              <th>Kurs</th>
              <th>Begründung</th>
              {!locked && <th>Korrektur</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map(({ r, w, place }) => {
              const name = `${r.student.firstName} ${r.student.lastName}${multi ? `, Kurs ${place}` : ""}`;
              return (
                <tr key={`${r.student.id}#${place}`}>
                  <td>
                    {r.student.lastName}, {r.student.firstName}
                    {multi && <span className="text-muted"> · Kurs {place}</span>}
                  </td>
                  <td>{r.student.className}</td>
                  <td className="text-sm">{w?.submittedAt ? w.choices.map((c) => title.get(c) ?? "–").join(" › ") : "nicht gewählt"}</td>
                  <td>{w?.assignedId ? title.get(w.assignedId) : <Badge tone="warn">offen</Badge>}</td>
                  <td className="text-sm text-muted">
                    {w?.reason ?? (!v.allocatedAt ? "" : place > v.minCourses ? "freiwilliger Kurs – bei Bedarf von Hand zuteilen" : "nicht gewählt – von Hand zuteilen")}
                  </td>
                  {!locked && (
                    <td>
                      <AssignForm
                        action={assignAction.bind(null, v.id, r.student.id, place)}
                        student={name}
                        current={w?.manual ? (w.assignedId ?? "") : ""}
                        offers={offers.map((o) => ({ value: o.id, label: o.title }))}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </section>
  );
}
