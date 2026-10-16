import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, Pencil } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ } from "@/core/time";
import { submitResponseAction } from "@/modules/umfragen/actions";
import { getSurvey, KIND_LABELS } from "@/modules/umfragen/service";
import { MIN_ANONYMOUS, results, type QuestionResult } from "@/modules/umfragen/teilnahme";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Markdown } from "@schulos/ui/markdown";
import { PageHeader, Progress } from "@schulos/ui/misc";
import { AnswerForm } from "./answer-form";
import { DeleteSurvey } from "./delete-survey";
import { Remind } from "./remind";

export const metadata: Metadata = { title: "Umfrage" };

const fmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

function Result({ q, index }: { q: QuestionResult; index: number }) {
  return (
    <li className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
      <p className="font-medium">
        {index + 1}. {q.text} <span className="font-normal text-muted">· {q.answered === 1 ? "1 Antwort" : `${q.answered} Antworten`}</span>
      </p>
      {q.options && (
        <ul className="flex flex-col gap-2">
          {q.options.map((o) => (
            <li key={o.label} className="flex flex-col gap-1">
              <span className="flex justify-between gap-2 text-sm">
                <span>{o.label}</span>
                <span className="text-muted tabular-nums">
                  {o.count} · {pct(o.count, q.answered)} %
                </span>
              </span>
              <Progress value={pct(o.count, q.answered)} label={`${o.label}: ${o.count} von ${q.answered}`} />
            </li>
          ))}
        </ul>
      )}
      {q.scale && (
        <>
          <p className="text-sm">Mittelwert: {q.scale.average === null ? "–" : q.scale.average.toLocaleString("de-DE")}</p>
          <ul className="flex flex-col gap-2">
            {q.scale.counts.map((c, i) => (
              <li key={i} className="flex flex-col gap-1">
                <span className="flex justify-between gap-2 text-sm">
                  <span>{i + 1}</span>
                  <span className="text-muted tabular-nums">{c}</span>
                </span>
                <Progress value={pct(c, q.answered)} label={`Wert ${i + 1}: ${c} von ${q.answered}`} />
              </li>
            ))}
          </ul>
        </>
      )}
      {q.texts &&
        (q.texts.length === 0 ? (
          <p className="text-sm text-muted">Keine Freitexte.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {q.texts.map((t, i) => (
              <li key={i} className="rounded-xl bg-surface-2 px-3 py-2 text-sm">
                {t.name && <span className="font-medium">{t.name}: </span>}
                {t.text}
              </li>
            ))}
          </ul>
        ))}
    </li>
  );
}

export default async function UmfragePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ danke?: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  const data = await getSurvey(db, perms, (await params).id);
  if (!data) notFound();
  const { survey, questions, targets, status } = data;
  const thanks = (await searchParams).danke === "1" && data.participated;
  const answering = data.targeted && status === "offen" && !data.participated;
  const res = data.canEdit ? await results(db, perms, survey.id) : null;

  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        eyebrow="Umfrage"
        title={survey.title}
        actions={
          data.canEdit && (
            <>
              {!survey.quick && (
              <Button asChild size="sm">
                <Link href={`/umfragen/${survey.id}/bearbeiten`}>
                  <Pencil aria-hidden /> Bearbeiten
                </Link>
              </Button>
              )}
              <DeleteSurvey id={survey.id} responses={data.responses} />
            </>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <Badge tone={status === "offen" ? "success" : "neutral"}>{status}</Badge>
        <span>
          {fmt.format(survey.opensAt)} – {fmt.format(survey.closesAt)}
        </span>
        <span>· {survey.anonymous ? "anonym" : "namentlich"}</span>
        {data.authorName && <span>· von {data.authorName}</span>}
      </div>
      {survey.description && <Markdown>{survey.description}</Markdown>}
      {thanks && (
        <p role="status" className="rounded-xl bg-success-soft px-4 py-3 text-success">
          Danke! Deine Antworten sind gespeichert.
        </p>
      )}
      {data.targeted && data.participated && !thanks && <p role="status">Du hast an dieser Umfrage teilgenommen – danke!</p>}
      {data.targeted && status === "geplant" && <p className="text-muted">Die Umfrage beginnt am {fmt.format(survey.opensAt)}.</p>}

      {res && (
        <Card aria-labelledby="auswertung">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="auswertung" className="text-base font-semibold">
              Auswertung
            </h2>
            {!res.hidden && res.total > 0 && (
              <Button asChild size="sm">
                <a href={`/api/umfragen/${survey.id}/csv`} download>
                  <Download aria-hidden /> CSV
                </a>
              </Button>
            )}
          </div>
          <p className="text-sm">
            {res.participants} von {res.audience} haben teilgenommen ({pct(res.participants, res.audience)} %) · für {targets.labels.join(", ")}
          </p>
          {status === "offen" && <Remind id={survey.id} open={res.open} />}
          {res.hidden && (
            <p className="text-sm text-muted">
              Noch zu wenige Antworten: Anonyme Ergebnisse erscheinen erst ab {MIN_ANONYMOUS} Antworten, damit niemand erkennbar ist.
            </p>
          )}
          {!res.hidden && res.counted < res.total && (
            <p className="text-sm text-muted">
              Ausgewertet sind {res.counted} von {res.total} Antworten: Anonyme Ergebnisse wachsen in Schritten von {MIN_ANONYMOUS}, damit sich keine einzelne Antwort herausrechnen lässt.
            </p>
          )}
        </Card>
      )}
      {res && !res.hidden && res.total > 0 && (
        <ol aria-label="Ergebnisse je Frage" className="flex flex-col gap-3">
          {res.questions.map((q, i) => (
            <Result key={q.id} q={q} index={i} />
          ))}
        </ol>
      )}

      {answering ? (
        <section aria-labelledby={data.canEdit ? "teilnehmen" : undefined} className="flex flex-col gap-3">
          {data.canEdit && (
            <h2 id="teilnehmen" className="text-base font-semibold">
              Selbst teilnehmen
            </h2>
          )}
          <AnswerForm action={submitResponseAction.bind(null, survey.id)} questions={questions} anonymous={survey.anonymous} />
        </section>
      ) : (
        (!res || res.hidden || res.total === 0) && (
          <section aria-labelledby="fragen" className="flex flex-col gap-3">
            <h2 id="fragen" className="text-base font-semibold">
              Fragen
            </h2>
            <ol className="flex flex-col gap-2">
              {questions.map((q, i) => (
                <li key={q.id} className="rounded-card border border-border bg-surface p-4">
                  <p className="font-medium">
                    {i + 1}. {q.text}
                    {!q.required && <span className="font-normal text-muted"> (freiwillig)</span>}
                  </p>
                  <p className="text-sm text-muted">
                    {KIND_LABELS[q.kind]}
                    {q.options.length > 0 && `: ${q.options.join(" · ")}`}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        )
      )}
    </main>
  );
}
