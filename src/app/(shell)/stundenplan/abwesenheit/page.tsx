import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { ABSENCE_LABELS } from "@/modules/stundenplan/abwesenheit";
import { APPROVE, SELF_REASONS, myAbsences, pendingRequests, spanText } from "@/modules/stundenplan/selbstmeldung";
import { decideAbsenceAction, reportOwnAbsenceAction, saveMaterialAction, withdrawOwnAbsenceAction } from "@/modules/stundenplan/selbstmeldung-actions";
import { timetableMasterData } from "@/modules/stundenplan/service";
import { Badge } from "@schulos/ui/badge";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { ActionButton, MaterialForm, SelfAbsenceForm } from "./forms";

export const metadata: Metadata = { title: "Abwesenheit melden" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
const STATUS = {
  aktiv: { label: "gemeldet", tone: "success" },
  beantragt: { label: "beantragt", tone: "warn" },
  abgelehnt: { label: "nicht genehmigt", tone: "danger" },
} as const;

/**
 * P4-74: eigene Abwesenheit melden (Lehrkräfte) – krank sofort, Fortbildung/dienstlich als Antrag an die Schulleitung (I-26);
 * Q5-12: je betroffener Stunde Material für die Vertretung. Schulleitung (`stundenplan.absence_approve`) sieht die offenen Anträge.
 */
export default async function AbwesenheitPage() {
  const { perms } = await requireUser();
  const approver = hasPermission(perms, APPROVE);
  if (perms.role !== "lehrkraft" && !approver) notFound();
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const [master, mine, pending] = await Promise.all([
    timetableMasterData(db),
    perms.role === "lehrkraft" ? myAbsences(db, perms, today) : [],
    pendingRequests(db, perms),
  ]);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Stundenplan" title="Abwesenheit melden" />
      {approver && (
        <section id="antraege" aria-labelledby="antraege-title" className="flex flex-col gap-3">
          <h2 id="antraege-title" className="font-display text-xl font-bold">
            Anträge zur Genehmigung
          </h2>
          {pending.length === 0 ? (
            <p className="text-sm text-muted">Keine offenen Anträge.</p>
          ) : (
            <ul aria-label="Offene Anträge" className="flex flex-col gap-2">
              {pending.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
                  <span className="flex-1">
                    <strong>{r.teacherName}</strong> · {r.reason} · {r.span}
                    {r.note && <span className="text-muted"> · {r.note}</span>}
                  </span>
                  <ActionButton
                    action={decideAbsenceAction.bind(null, r.id, true)}
                    label="Genehmigen"
                    aria={`Genehmigen: ${r.teacherName}`}
                    variant="primary"
                  />
                  <ActionButton action={decideAbsenceAction.bind(null, r.id, false)} label="Ablehnen" aria={`Ablehnen: ${r.teacherName}`} variant="ghost" />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {perms.role === "lehrkraft" && (
        <>
          <Card aria-labelledby="melden-title" className="gap-3">
            <h2 id="melden-title" className="text-base font-semibold">
              Neue Abwesenheit
            </h2>
            <p className="-mt-2 text-sm text-muted">
              „krank“ gilt sofort – die Vertretungsplanung bekommt eine Nachricht (ohne Grund). Fortbildung und dienstliche Abwesenheit sind ein Antrag an die
              Schulleitung. Rückwirkend und länger als 14 Tage trägt die Vertretungsplanung ein.
            </p>
            <SelfAbsenceForm
              action={reportOwnAbsenceAction}
              today={today}
              periods={master.periods.map((p) => ({ value: String(p.nr), label: `${p.nr}. Stunde` }))}
              reasons={SELF_REASONS.map((r) => ({ value: r, label: ABSENCE_LABELS[r] }))}
            />
          </Card>

          <section aria-labelledby="meine-title" className="flex flex-col gap-3">
            <h2 id="meine-title" className="font-display text-xl font-bold">
              Meine Abwesenheiten
            </h2>
            {mine.length === 0 ? (
              <EmptyState title="Keine Abwesenheit eingetragen" />
            ) : (
              mine.map((a) => {
                const st = STATUS[a.status];
                const label = `${ABSENCE_LABELS[a.reason]} ${spanText(a)}`;
                const canWithdraw = a.selfReported && (a.status === "beantragt" || (a.status === "aktiv" && a.startsOn > today));
                return (
                  <Card key={a.id} aria-label={`Abwesenheit ${label}`} className="gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="flex-1 font-semibold">{label}</h3>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={st.tone}>{st.label}</Badge>
                        {!a.selfReported && <Badge>von der Planung eingetragen</Badge>}
                        {canWithdraw && (
                          <ActionButton
                            action={withdrawOwnAbsenceAction.bind(null, a.id)}
                            label="Zurückziehen"
                            aria={`Zurückziehen: ${label}`}
                            variant="ghost"
                            confirm="Meldung zurückziehen? Hinterlegtes Material wird mit gelöscht."
                          />
                        )}
                      </div>
                    </div>
                    {a.note && <p className="text-sm text-muted">{a.note}</p>}
                    {a.status !== "abgelehnt" &&
                      (a.lessons.length === 0 ? (
                        <p className="text-sm text-muted">In diesem Zeitraum hast du keinen Unterricht.</p>
                      ) : (
                        <ul aria-label="Betroffene Stunden" className="flex flex-col divide-y divide-border">
                          {a.lessons.map((l) => {
                            const m = a.materials.find((x) => x.lessonId === l.lessonId && x.date === l.date);
                            const lessonLabel = `${dayFmt.format(fromBerlinLocal(l.date))} ${l.periodNr}. Std · ${l.subjectName} · ${l.groupName}`;
                            return (
                              <li key={`${l.lessonId}-${l.date}`} className="flex flex-col gap-2 py-3">
                                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                  {lessonLabel}
                                  {l.change?.kind === "substitute" && <Badge tone="success">Vertretung: {l.change.substituteCode ?? "eingetragen"}</Badge>}
                                  {m && (
                                    <Link href={`/stundenplan/material/${m.id}`} className="text-accent-ink hover:underline">
                                      Material ansehen
                                    </Link>
                                  )}
                                </p>
                                <details open={!m && a.lessons.length <= 3}>
                                  <summary className="cursor-pointer text-sm text-accent">{m ? "Material ändern" : "Material hinterlegen"}</summary>
                                  <div className="pt-2">
                                    <MaterialForm
                                      action={saveMaterialAction.bind(null, a.id, l.lessonId, l.date)}
                                      label={lessonLabel}
                                      initial={{ text: m?.text ?? "", fileName: m?.fileName ?? null, forStudents: m?.forStudents ?? false }}
                                    />
                                  </div>
                                </details>
                              </li>
                            );
                          })}
                        </ul>
                      ))}
                  </Card>
                );
              })
            )}
          </section>
        </>
      )}
    </main>
  );
}
