import Link from "next/link";
import { getDb } from "@/core/db/client";
import type { KurswahlVerfahren } from "@/core/db/schema";
import type { PermissionSet } from "@/core/permissions";
import { TZ } from "@/core/time";
import { missing } from "@/modules/kurswahl/erinnerung";
import { neededChoices, wahlRows, type AngebotView, type VerfahrenState } from "@/modules/kurswahl/service";
import { remindAction, submitChoiceAction } from "@/modules/kurswahl/wahl-actions";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Table } from "@schulos/ui/table";
import { ActionButton, ChoiceForm } from "../wahl-forms";

const stamp = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });

/** P4-62: Wahlen der Zielgruppe (Verwaltung) – Stand je Person, Erinnerung an Nichtwähler, Eintrag vom Papier-Wahlbogen. */
export async function WahlenPart({ perms, v, offers, state }: { perms: PermissionSet; v: KurswahlVerfahren; offers: AngebotView[]; state: VerfahrenState }) {
  const db = await getDb();
  const [rows, m] = await Promise.all([wahlRows(db, perms, v), missing(db, v.id)]);
  const title = new Map(offers.map((o) => [o.id, o.title]));
  const need = neededChoices(v, offers.length);
  const open = m.notChosen.length + m.notConfirmed.length;
  // P4-67: Mehrfachwahl – Wünsche je Kurs in einer Spalte
  const multi = v.maxCourses > 1;
  const names = (list: string[]) => list.map((c) => title.get(c) ?? "–").join(", ");
  return (
    <section aria-labelledby="wahlen" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="wahlen" className="flex-1 font-display text-xl font-bold">
          Wahlen
        </h2>
        <Button asChild variant="secondary" size="sm">
          <Link href={`/druck/kurswahl/${v.id}`}>Alle Wahlbögen drucken</Link>
        </Button>
      </div>
      {state === "offen" && open > 0 && (
        <Card className="flex flex-col gap-2">
          <p className="text-sm">
            {m.notChosen.length} noch ohne Wahl{m.notConfirmed.length > 0 && `, ${m.notConfirmed.length} ohne Bestätigung der Eltern`}
            {v.remindedAt && ` · zuletzt erinnert am ${stamp.format(v.remindedAt)}`}
          </p>
          <p className="text-xs text-muted">
            {v.autoRemindedOn
              ? `Automatische Erinnerung am ${v.autoRemindedOn.slice(8, 10)}.${v.autoRemindedOn.slice(5, 7)}. verschickt.`
              : "Zwei Tage vor Wahlende erinnert SchulOS automatisch (Gong, keine Mail)."}
          </p>
          <ActionButton action={remindAction.bind(null, v.id)} label="Erinnerung an Nichtwähler senden" doneText="%n Erinnerungen verschickt." variant="secondary" />
        </Card>
      )}
      {state !== "uebernommen" && need > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-accent">Wahl vom Papier-Wahlbogen eintragen</summary>
          <div className="pt-3">
            <ChoiceForm
              action={submitChoiceAction.bind(null, v.id, null)}
              label="Wahl eintragen"
              need={need}
              offers={offers.map((o) => ({ value: o.id, label: o.title }))}
              initial={[]}
              submitLabel="Wahl eintragen"
              courses={{ min: v.minCourses, max: v.maxCourses }}
              students={rows.filter((r) => r.student.classId).map((r) => ({ value: r.student.id, label: `${r.student.lastName}, ${r.student.firstName} (${r.student.className})` }))}
            />
          </div>
        </details>
      )}
      <Table>
        <thead>
          <tr>
            <th>Schüler:in</th>
            <th>Klasse</th>
            {multi ? (
              <th>Wünsche je Kurs</th>
            ) : (
              Array.from({ length: need }, (_, i) => <th key={i}>{i + 1}. Wunsch</th>)
            )}
            <th>Stand</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const w = r.wahl;
            return (
              <tr key={r.student.id}>
                <td>
                  {r.student.lastName}, {r.student.firstName}
                  {r.selfResponsible && (
                    <Badge tone="soft" className="ml-2">
                      eigenständig
                    </Badge>
                  )}
                </td>
                <td>{r.student.className}</td>
                {multi ? (
                  <td>
                    {r.places
                      .filter((p) => p.choices.length)
                      .map((p) => `Kurs ${p.place}: ${names(p.choices)}`)
                      .join(" · ")}
                  </td>
                ) : (
                  Array.from({ length: need }, (_, i) => <td key={i}>{w?.choices[i] ? (title.get(w.choices[i]!) ?? "–") : ""}</td>)
                )}
                <td>{!w?.submittedAt ? <Badge tone="warn">nicht gewählt</Badge> : v.parentConfirm && !r.selfResponsible && !w.confirmedAt ? <Badge tone="soft">Bestätigung fehlt</Badge> : <Badge tone="success">gewählt</Badge>}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </section>
  );
}
