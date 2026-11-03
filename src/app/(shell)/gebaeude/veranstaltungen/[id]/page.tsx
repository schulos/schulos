import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOn } from "@/core/modules/guard";
import { TZ } from "@/core/time";
import { eventStepAction } from "@/modules/gebaeude/actions";
import { EVENT_HISTORY_LABELS, EVENT_NEED_KEYS, EVENT_NEEDS, EVENT_SCOPE_LABELS, EVENT_SCOPES, EVENT_SEATING_LABELS, EVENT_TEXT_MAX } from "@/modules/gebaeude/labels";
import { CONFLICT_LABELS, eventPlace, eventSpan, getEvent } from "@/modules/gebaeude/veranstaltungen";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { SpecForm, type FieldSpec } from "@/ui/spec-form";
import { EventStatusBadge } from "../ui";

export const metadata: Metadata = { title: "Veranstaltung" };

const at = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const day = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: TZ });

const textField = (label: string, required = true, hint?: string): FieldSpec => ({ name: "text", label, type: "textarea", required, maxLength: EVENT_TEXT_MAX, wide: true, hint });

const scopeField = (options: { value: string; label: string }[], hint?: string): FieldSpec => ({ name: "scope", label: "Gilt für", type: "select", options, defaultValue: options[0]!.value, wide: true, hint });

const EDITED: Record<string, string> = {
  gespeichert: "Gespeichert.",
  bestaetigen: "Gespeichert – Zeit oder Räume haben sich geändert, die Hausmeisterei bestätigt neu.",
  freigabe: "Gespeichert – Zeit oder Räume haben sich geändert, die Anmeldung geht erneut zur Freigabe an die Schulleitung.",
};

/**
 * Detail (VA-02/03): Angaben, Konflikthinweise, Raumsperren, Verlauf und die Schritte, die die Person gehen darf. VA-05: „Bearbeiten“
 * für die anmeldende Person; VA-06: Termine der Serie, Bestätigen/Freigeben der ganzen Serie, Absagen „dieser und alle folgenden“.
 */
export default async function VeranstaltungPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ neu?: string; geaendert?: string; termine?: string }>;
}) {
  const { perms } = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const d = await getEvent(db, perms, id);
  if (!d) notFound();
  const e = d.event;
  const kalender = d.can.decide ? await moduleOn("kalender") : false;
  const lessons = d.conflicts.filter((c) => c.kind === "unterricht");
  const needs = EVENT_NEED_KEYS.filter((k) => e[k]).map((k) => EVENT_NEEDS[k]);
  const step = (s: Parameters<typeof eventStepAction>[1]) => eventStepAction.bind(null, e.id, s);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Veranstaltung" title={e.title} />
      <Link href="/gebaeude/veranstaltungen" className="text-sm font-medium text-accent-ink hover:underline">
        Zurück zu den Veranstaltungen
      </Link>
      {sp.neu && (
        <p role="status" className="rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          Angemeldet{d.series ? ` – ${d.history.find((h) => h.kind === "angemeldet")?.text ?? `Serie mit ${d.series.items.length} Terminen`}` : ""}.{" "}
          {e.status === "freigabe" ? "Die Schulleitung gibt sie frei, dann geht sie an die Hausmeisterei." : "Die Hausmeisterei ist benachrichtigt."}
        </p>
      )}
      {sp.geaendert && EDITED[sp.geaendert] && (
        <p role="status" className="rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          {EDITED[sp.geaendert]}
          {sp.geaendert === "gespeichert" && e.status === "bestaetigt" ? " Die Bestätigung bleibt." : ""}
          {Number(sp.termine) > 1 ? ` (${Number(sp.termine)} Termine geändert)` : ""}
        </p>
      )}
      <Card aria-label="Angaben">
        <div className="flex flex-wrap items-center gap-2">
          <EventStatusBadge status={e.status} />
          {e.calendarEventId && <Badge tone="soft">im Schulkalender</Badge>}
          {d.series && (
            <Badge tone="soft">
              Serie · Termin {d.series.position} von {d.series.items.length}
            </Badge>
          )}
          {d.can.edit && (
            <Button asChild className="ml-auto">
              <Link href={`/gebaeude/veranstaltungen/${e.id}/bearbeiten`}>Bearbeiten</Link>
            </Button>
          )}
        </div>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted">Zeit</dt>
          <dd>{e.span}</dd>
          {(e.setupAt < e.startsAt || e.teardownAt > e.endsAt) && (
            <>
              <dt className="text-muted">Mit Auf-/Abbau</dt>
              <dd>{eventSpan(e.setupAt, e.teardownAt)}</dd>
            </>
          )}
          <dt className="text-muted">Ort</dt>
          <dd>{eventPlace(e)}</dd>
          <dt className="text-muted">Personen</dt>
          <dd>{e.persons}</dd>
          <dt className="text-muted">Bestuhlung</dt>
          <dd>{EVENT_SEATING_LABELS[e.seating]}</dd>
          <dt className="text-muted">Bedarf</dt>
          <dd>{needs.length ? needs.join(" · ") : "nichts weiter"}</dd>
          {e.details && (
            <>
              <dt className="text-muted">Einzelheiten</dt>
              <dd className="whitespace-pre-line">{e.details}</dd>
            </>
          )}
          {!d.own && (
            <>
              <dt className="text-muted">Angemeldet von</dt>
              <dd>{e.organizerName ?? "gelöschtes Konto"}</dd>
            </>
          )}
        </dl>
      </Card>

      {d.conflicts.length > 0 && (
        <Card aria-label="Hinweise zu den Räumen">
          <CardHeader title="Hinweise zu den Räumen" />
          <ul className="flex flex-col gap-1 text-sm">
            {d.conflicts.map((c, i) => (
              <li key={i}>
                <span className="font-medium">
                  Raum {c.roomId} · {CONFLICT_LABELS[c.kind]}
                </span>
                <span className="text-muted"> · {c.text}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">
            {lessons.length
              ? "Bei Unterricht sperrt die Bestätigung die betroffenen Stunden (Vertretungsplanung sieht es); alles andere ist nur ein Hinweis."
              : "Nur ein Hinweis – SchulOS sperrt hier nichts."}
          </p>
        </Card>
      )}

      {d.blocks.length > 0 && (
        <Card aria-label="Raumsperren">
          <CardHeader title="Raumsperren" />
          <ul className="flex flex-col gap-1 text-sm">
            {d.blocks.map((b) => (
              <li key={b.id}>
                Raum {b.roomId} · {day.format(new Date(`${b.startsOn}T12:00:00Z`))}
                {b.fromPeriod !== null && b.toPeriod !== null ? ` · ${b.fromPeriod === b.toPeriod ? `${b.fromPeriod}. Std` : `${b.fromPeriod}.–${b.toPeriod}. Std`}` : ""}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {d.series && (
        <Card aria-labelledby="serie">
          <CardHeader title={<span id="serie">Termine der Serie</span>} />
          <ol aria-label="Termine der Serie" className="flex flex-col gap-1 text-sm">
            {d.series.items.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2">
                {o.id === e.id ? (
                  <span aria-current="page" className="font-medium">
                    {o.label} (dieser Termin)
                  </span>
                ) : (
                  <Link href={`/gebaeude/veranstaltungen/${o.id}`} className="text-accent-ink hover:underline">
                    {o.label}
                  </Link>
                )}
                <EventStatusBadge status={o.status} />
              </li>
            ))}
          </ol>
        </Card>
      )}

      {d.can.approve && (
        <Card aria-labelledby="freigabe">
          <CardHeader title={<span id="freigabe">Freigabe (Schulleitung)</span>} />
          <SpecForm
            action={step("freigeben")}
            label="Freigeben"
            submit="Freigeben"
            fields={
              d.series && d.series.approval > 1
                ? [
                    scopeField([
                      { value: "serie", label: `alle wartenden Termine der Serie (${d.series.approval})` },
                      { value: "einzeln", label: "nur dieser Termin" },
                    ]),
                  ]
                : []
            }
            okText="Freigegeben."
          />
          <SpecForm action={step("ablehnen")} label="Ablehnen" submit="Ablehnen" variant="secondary" fields={[textField("Begründung")]} okText="Abgelehnt." />
        </Card>
      )}

      {d.can.decide && (
        <Card aria-labelledby="entscheiden">
          <CardHeader title={<span id="entscheiden">Bestätigen oder zurückfragen</span>} />
          <SpecForm
            action={step("bestaetigen")}
            label="Bestätigen"
            submit="Bestätigen"
            fields={[
              ...(d.series && d.series.open > 1
                ? [
                    scopeField(
                      [
                        { value: "serie", label: `alle offenen Termine der Serie (${d.series.open})` },
                        { value: "einzeln", label: "nur dieser Termin" },
                      ],
                      "Termine mit Konflikt (Wartung, Raumsperre, Buchung, andere Veranstaltung) bleiben einzeln offen",
                    ),
                  ]
                : []),
              {
                name: "blockRooms",
                label: "Räume sperren, wo Unterricht betroffen ist",
                type: "checkbox",
                checked: true,
                wide: true,
                hint: lessons.length ? `${lessons.length === 1 ? "1 Tag/Raum" : `${lessons.length} Tage/Räume`} mit Unterricht` : "zurzeit kein Unterricht betroffen",
              },
              ...(kalender ? [{ name: "calendar", label: "Im Schulkalender eintragen", type: "checkbox" as const, wide: true }] : []),
              textField("Hinweis an die anmeldende Person", false),
            ]}
          />
          <SpecForm action={step("rueckfrage")} label="Rückfrage" submit="Rückfrage senden" variant="secondary" fields={[textField("Rückfrage")]} okText="Rückfrage gesendet." />
          <SpecForm action={step("ablehnen")} label="Ablehnen" submit="Ablehnen" variant="secondary" fields={[textField("Begründung")]} okText="Abgelehnt." />
        </Card>
      )}

      {d.can.answer && (
        <Card aria-labelledby="antworten">
          <CardHeader title={<span id="antworten">Rückfrage beantworten</span>} />
          <SpecForm action={step("antworten")} label="Antworten" submit="Antworten" fields={[textField("Antwort")]} okText="Antwort gesendet." />
        </Card>
      )}

      <Card aria-labelledby="verlauf">
        <CardHeader title={<span id="verlauf">Verlauf</span>} />
        <ol aria-label="Verlauf" className="flex flex-col gap-2 text-sm">
          {d.history.map((h) => (
            <li key={h.id} className="flex flex-col">
              <span>
                <span className="font-medium">{EVENT_HISTORY_LABELS[h.kind]}</span>
                <span className="text-muted">
                  {" "}
                  · {at.format(h.at)}
                  {h.actorName ? ` · ${h.actorName}` : ""}
                </span>
              </span>
              {h.text && <span className="whitespace-pre-line">{h.text}</span>}
            </li>
          ))}
        </ol>
      </Card>

      {d.can.cancel && (
        <Card aria-labelledby="absagen">
          <CardHeader title={<span id="absagen">Absagen</span>} />
          <SpecForm
            action={step("absagen")}
            label="Absagen"
            submit="Veranstaltung absagen"
            variant="secondary"
            fields={[
              ...(d.series && d.series.following > 1 ? [scopeField(EVENT_SCOPES.map((s) => ({ value: s, label: EVENT_SCOPE_LABELS[s] })))] : []),
              textField("Grund (optional)", false),
            ]}
            okText="Abgesagt."
          />
        </Card>
      )}
    </main>
  );
}
