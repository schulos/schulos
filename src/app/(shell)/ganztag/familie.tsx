// GT-05: Ganztag aus Sicht der Familie – nur die eigenen Zeilen (bzw. die des Kindes), keine anderen Teilnehmenden.
import type { FamilyChild } from "@/modules/ganztag/familie";
import { EXCUSED_LABEL, MARK_LABEL as STATUS_LABEL, MARK_TONE as STATUS_TONE, WAY_LABEL } from "@/modules/ganztag/labels";
import { dateLabel } from "@/modules/ganztag/service";
import { Badge } from "@schulos/ui/badge";
import { Card } from "@schulos/ui/card";
import { EmptyState } from "@schulos/ui/misc";
import { WaySelect } from "./heimweg-select";

export function FamilyGanztag({ child, self, deadline }: { child: FamilyChild; self: boolean; deadline: string }) {
  const id = `ganztag-${child.id}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="font-display text-xl font-bold">
        {self ? "Meine Angebote" : `Ganztag: ${child.name}`}
      </h2>
      {child.offers.length === 0 ? (
        <EmptyState title="Keine Angebote mit Anwesenheitsliste">
          {self ? "Du bist in keiner AG und keinem Kurs mit Anwesenheitsliste." : "Das Kind ist in keiner AG und keinem Kurs mit Anwesenheitsliste."}
        </EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2" aria-label={self ? "Meine Angebote" : `Angebote von ${child.name}`}>
          {child.offers.map((o) => (
            <li key={o.id}>
              <Card className="h-full gap-2">
                <h3 className="font-semibold">{o.name}</h3>
                <p className="text-sm text-muted">{o.next ? `Nächster Termin: ${dateLabel(o.next.date)}, ${o.next.startsAt}–${o.next.endsAt} Uhr` : "Kein Termin in den nächsten vier Wochen"}</p>
                {o.cancelled.map((c) => (
                  <Badge key={`${c.date}-${c.startsAt}`} tone="warn" className="self-start">
                    fällt aus: {dateLabel(c.date)}, {c.startsAt} Uhr
                  </Badge>
                ))}
                {/* GT-09: Heimweg – nur die Art, keine Namen Abholberechtigter */}
                <div className="flex flex-col gap-2 border-t border-border pt-2">
                  <span className="text-sm font-medium">Heimweg</span>
                  {child.mayAct ? (
                    <WaySelect label={`Heimweg nach ${o.name}`} studentId={child.id} groupId={o.id} value={o.way} emptyLabel="keine Angabe" />
                  ) : (
                    <span className="text-sm">{o.way ? WAY_LABEL[o.way] : "keine Angabe"}</span>
                  )}
                  {o.days.length > 0 && (
                    <ul className="flex flex-col gap-2" aria-label={`Heimweg an den nächsten Terminen: ${o.name}`}>
                      {o.days.map((d) => (
                        <li key={d.sessionId} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                          <span className="text-sm">
                            {dateLabel(d.date)}, {d.startsAt} Uhr{d.leftAt && ` · gegangen ${d.leftAt} Uhr`}
                          </span>
                          {child.mayAct && d.open ? (
                            <WaySelect
                              label={`Heimweg am ${dateLabel(d.date)}: ${o.name}`}
                              studentId={child.id}
                              sessionId={d.sessionId}
                              value={d.way}
                              emptyLabel={`wie immer${o.way ? ` (${WAY_LABEL[o.way]})` : ""}`}
                            />
                          ) : (
                            <span className="text-sm text-muted">{d.way ? `geändert: ${WAY_LABEL[d.way]}` : "wie immer"}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {child.mayAct && (
                    <p className="text-xs text-muted">
                      Ändern für denselben Tag bis {deadline} Uhr, die Leitung bekommt einen Hinweis. Wer abholt, wird nicht in SchulOS eingetragen – bitte direkt mit der Leitung klären.
                    </p>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <h3 className="font-semibold">{self ? "Meine Anwesenheit" : "Anwesenheit"} in diesem Schuljahr</h3>
      <p className="text-sm text-muted" role="status" aria-label={self ? "Meine Anwesenheit gesamt" : `Anwesenheit gesamt: ${child.name}`}>
        {child.counts.anwesend} anwesend · {child.counts.verspaetet} verspätet · {child.counts.fehlt} gefehlt
      </p>
      {child.marks.length === 0 ? (
        <p className="rounded-card border border-border bg-surface p-4 text-muted">Noch nichts erfasst.</p>
      ) : (
        <ul className="rounded-card border border-border bg-surface px-4" aria-label={self ? "Meine Anwesenheit" : `Anwesenheit von ${child.name}`}>
          {child.marks.map((m) => (
            <li key={`${m.date}-${m.startsAt}-${m.offer}`} className="flex flex-col gap-1 border-t border-border py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex flex-col leading-tight">
                <span className="font-medium">{m.offer}</span>
                <span className="text-sm text-muted">
                  {dateLabel(m.date)}, {m.startsAt}–{m.endsAt} Uhr
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONE[m.status]}>
                  {STATUS_LABEL[m.status]}
                  {m.status === "verspaetet" && m.minutesLate ? ` (${m.minutesLate} Min.)` : ""}
                </Badge>
                {m.excused && <Badge>{EXCUSED_LABEL[m.excused]}</Badge>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
