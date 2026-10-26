import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import type { KurswahlVerfahren } from "@/core/db/schema";
import { hasPermission } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import { createAngebotAction, deleteAngebotAction, deleteVerfahrenAction, updateAngebotAction, updateVerfahrenAction } from "@/modules/kurswahl/actions";
import { CHOOSER_LABEL, KIND_LABEL, MANAGE, STATE_LABEL, canViewKurswahl, classesOfGrade, getVerfahren, listAngebote, neededChoices, offerShortage, rankLabel, verfahrenState, type AngebotView } from "@/modules/kurswahl/service";
import { formOptions, progress } from "@/modules/kurswahl/uebersicht";
import { loadPickList } from "@/modules/stundenplan/lehrfaecher";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Field, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { AngebotForm, ConfirmButton, EMPTY_ANGEBOT, VerfahrenForm } from "../forms";
import { WahlenPart } from "./wahlen";
import { UebernahmePart } from "./uebernahme";
import { ZuteilungPart, ZuteilungSummary } from "./zuteilung";

export const metadata: Metadata = { title: "Kurswahl" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const formatDay = (ymd: string) => dayFmt.format(new Date(`${ymd}T12:00:00Z`));

export default async function KurswahlDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { perms } = await requireUser();
  // SP-05: lesen mit `kurswahl.view` (Stundenplanung) – ohne Wahlen einzelner Schüler:innen und ohne Änderungen
  if (!canViewKurswahl(perms)) notFound();
  const manage = hasPermission(perms, MANAGE);
  const db = await getDb();
  const v = await getVerfahren(db, id);
  if (!v) notFound();
  const today = toBerlinDate(new Date());
  const state = verfahrenState(v, today);
  const [opts, offers, stats, classes, pickTeachers] = await Promise.all([
    formOptions(db),
    listAngebote(db, v.id),
    progress(db, v),
    classesOfGrade(db, v.gradeLevel),
    manage ? loadPickList(db, today) : Promise.resolve([]), // SP2-12b: Lehrkräfte mit Lehrfächern und Restdeputat für die Angebotsformulare
  ]);
  // ohne `manage` wie abgeschlossen: keine Formulare
  const locked = state === "uebernommen" || !manage;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Kurswahl"
        title={v.title}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/kurswahl">Alle Wahlverfahren</Link>
            </Button>
            {manage && <ConfirmButton action={deleteVerfahrenAction.bind(null, v.id)} question={`„${v.title}“ mit allen Angeboten und Wahlen löschen?`} label="Löschen" ariaLabel="Wahlverfahren löschen" />}
          </>
        }
      />
      <p className="flex flex-wrap items-center gap-2 text-muted">
        {KIND_LABEL[v.kind]} · {opts.gradeName.get(v.gradeLevel) ?? v.gradeLevel} · {formatDay(v.opensOn)} bis {formatDay(v.closesOn)} · {CHOOSER_LABEL[v.chooser]}
        <Badge tone={state === "offen" ? "success" : "soft"}>{STATE_LABEL[state]}</Badge>
      </p>

      <section aria-labelledby="zielgruppe" className="flex flex-col gap-2">
        <h2 id="zielgruppe" className="font-display text-xl font-bold">
          Zielgruppe
        </h2>
        <p>
          <strong>{stats.target}</strong> Schüler:innen{stats.byClass.length > 0 && ` (${stats.byClass.map((c) => `${c.name}: ${c.count}`).join(", ")})`} · <strong>{stats.submitted}</strong> haben gewählt
        </p>
      </section>

      <section aria-labelledby="angebote" className="flex flex-col gap-3">
        <h2 id="angebote" className="font-display text-xl font-bold">
          Angebote ({offers.length})
        </h2>
        {!locked && offers.length > 0 && offerShortage(v, offers.length) && (
          <p role="alert" className="rounded-xl border border-warn-border bg-warn-soft p-3 text-sm text-warn">
            {offerShortage(v, offers.length)} Weitere Angebote anlegen oder die Mindestzahl der Kurse senken.
          </p>
        )}
        {offers.length === 0 ? (
          <EmptyState title="Noch keine Angebote">Mindestens zwei Angebote anlegen – erst dann gibt es etwas zu wählen.</EmptyState>
        ) : (
          <ul className="rounded-card border border-border bg-surface px-4">
            {offers.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 border-t border-border py-3 first:border-t-0">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="flex items-center gap-2 font-medium">
                      {a.color && <span aria-hidden className="size-3 rounded-full" style={{ background: a.color }} />}
                      {a.title}
                    </span>
                    <span className="text-sm text-muted">{offerFacts(a)}</span>
                  </span>
                  {!locked && <ConfirmButton action={deleteAngebotAction.bind(null, v.id, a.id)} question={`Angebot „${a.title}“ löschen? Es fällt auch aus abgegebenen Wünschen.`} label="Löschen" ariaLabel={`Angebot ${a.title} löschen`} />}
                </div>
                {!locked && (
                  <details>
                    <summary className="cursor-pointer text-sm text-accent">Ändern</summary>
                    <div className="pt-3">
                      <AngebotForm
                        action={updateAngebotAction.bind(null, v.id, a.id)}
                        submitLabel={`${a.title} speichern`}
                        subjects={opts.subjects}
                        teachers={pickTeachers}
                        levels={opts.levels}
                        defaults={{
                          title: a.title,
                          subjectId: a.subjectId ?? "",
                          level: a.level ?? "",
                          minSize: String(a.minSize),
                          maxSize: a.maxSize == null ? "" : String(a.maxSize),
                          teacherId: a.teacherId ?? "",
                          hours: a.hours == null ? "" : String(a.hours),
                          note: a.note ?? "",
                        }}
                      />
                    </div>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {!locked && (
          <Card aria-labelledby="angebot-neu">
            <h3 id="angebot-neu" className="text-base font-semibold">
              Angebot hinzufügen
            </h3>
            <AngebotForm action={createAngebotAction.bind(null, v.id)} submitLabel="Angebot hinzufügen" defaults={EMPTY_ANGEBOT} subjects={opts.subjects} teachers={pickTeachers} levels={opts.levels} />
          </Card>
        )}
      </section>

      <Preview v={v} offers={offers} />

      {manage && offers.length > 0 && <WahlenPart perms={perms} v={v} offers={offers} state={state} />}

      {manage && offers.length > 0 && <ZuteilungPart perms={perms} v={v} offers={offers} />}

      {!manage && offers.length > 0 && <ZuteilungSummary perms={perms} v={v} />}

      <UebernahmePart perms={perms} v={v} state={state} />

      {!locked && (
        <Card aria-labelledby="einstellungen">
          <h2 id="einstellungen" className="text-base font-semibold">
            Einstellungen
          </h2>
          <VerfahrenForm
            action={updateVerfahrenAction.bind(null, v.id)}
            submitLabel="Wahlverfahren speichern"
            savedText="Gespeichert."
            kinds={opts.kinds}
            grades={opts.grades}
            years={opts.years}
            classes={classes.map((c) => ({ value: c.id, label: c.name }))}
            defaults={{
              title: v.title,
              kind: v.kind,
              note: v.note ?? "",
              gradeLevel: String(v.gradeLevel),
              classIds: v.classIds,
              courseGrade: String(v.courseGrade),
              schoolYearId: v.schoolYearId ?? "",
              opensOn: v.opensOn,
              closesOn: v.closesOn,
              choices: String(v.choices),
              minCourses: String(v.minCourses),
              maxCourses: String(v.maxCourses),
              chooser: v.chooser,
              parentConfirm: v.parentConfirm,
            }}
          />
        </Card>
      )}
    </main>
  );
}

function offerFacts(a: AngebotView): string {
  const parts = [a.subjectName ?? "ohne Fach"];
  if (a.level) parts.push(a.level);
  parts.push(a.maxSize == null ? "unbegrenzt" : `höchstens ${a.maxSize}`);
  if (a.minSize > 0) parts.push(`mindestens ${a.minSize}`);
  if (a.teacherName) parts.push(a.teacherName);
  if (a.hours) parts.push(`${a.hours} Wochenstunden`);
  return parts.join(" · ");
}

/** Vorschau: so sieht das Wahlformular für die Familien aus (nicht absendbar). */
function Preview({ v, offers }: { v: KurswahlVerfahren; offers: AngebotView[] }) {
  const need = neededChoices(v, offers.length);
  return (
    <section aria-labelledby="vorschau" className="flex flex-col gap-3">
      <h2 id="vorschau" className="font-display text-xl font-bold">
        Vorschau für die Familien
      </h2>
      <Card className="flex flex-col gap-3 bg-surface-2">
        <p className="font-medium">{v.title}</p>
        {v.note && <p className="whitespace-pre-line text-sm text-muted">{v.note}</p>}
        {v.maxCourses > 1 && need > 0 && (
          <p className="text-sm text-muted">
            {v.minCourses === v.maxCourses ? `${v.maxCourses} Kurse` : `${v.minCourses} bis ${v.maxCourses} Kurse`} je Person – für jeden Kurs diese Wünsche:
          </p>
        )}
        {need === 0 ? (
          <p className="text-sm text-muted">Noch keine Angebote.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {Array.from({ length: need }, (_, i) => (
              <Field key={i} label={rankLabel(i + 1)}>
                <Select disabled defaultValue="">
                  <option value="">Bitte wählen</option>
                  {offers.map((a) => (
                    <option key={a.id}>{a.title}</option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
        )}
        <ul className="flex flex-col gap-1 text-sm">
          {offers
            .filter((a) => a.note)
            .map((a) => (
              <li key={a.id}>
                <strong>{a.title}:</strong> {a.note}
              </li>
            ))}
        </ul>
      </Card>
    </section>
  );
}
