import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { readSchoolSettings } from "@/core/settings";
import { canAuskunft } from "@/modules/anmeldung/auskunft";
import { anmeldungKatalog } from "@/modules/anmeldung/katalog";
import { ANTRAG_STATUS_LABELS } from "@/modules/anmeldung/labels";
import { slotText } from "@/modules/anmeldung/mails";
import { getAntrag } from "@/modules/anmeldung/sekretariat";
import { canDecide, canManage, DECISION_STATUSES, lateAdmissionOpen, listSlots, OPEN_STATUSES } from "@/modules/anmeldung/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { ChecklistForm, DecideOneForm, MoveSlotForm, NoteForm } from "../../../forms";
import { dateTime, VerfahrenNav } from "../../../shared";

export const metadata: Metadata = { title: "Antrag" };
export const dynamic = "force-dynamic";

const EVENT_LABELS: Record<string, string> = { eingegangen: "Eingang", bestaetigt: "Bestätigt", termin: "Termin", status: "Stand", notiz: "Notiz", mail: "Mail" };

/**
 * Antrag im Sekretariat (P4-36): alle Angaben, Checkliste „vorgelegt“, Termin verschieben, Notizen, Verlauf, Druck.
 * Jeder Aufruf wird als Lesezugriff protokolliert (`lesen.anmeldung`).
 */
export default async function AntragPage({ params }: { params: Promise<{ id: string; antragId: string }> }) {
  const { perms } = await requireUser();
  const { id, antragId } = await params;
  const db = await getDb();
  const r = await getAntrag(db, perms, decodeURIComponent(antragId)).catch(() => null);
  if (!r || r.antrag.verfahrenId !== decodeURIComponent(id)) notFound();
  const a = r.antrag;
  const school = await readSchoolSettings(db);
  const katalog = anmeldungKatalog(school.profile.state);
  const manage = canManage(perms) && r.verfahrenStatus !== "abgeschlossen";
  const open = (OPEN_STATUSES as readonly string[]).includes(a.status);
  // Q5-19: nach dem Abschluss nur Nachrücken von der Warteliste (bis Schuljahresbeginn)
  const late = canDecide(perms) && r.verfahrenStatus === "abgeschlossen" && a.status === "warteliste" && lateAdmissionOpen(r.schoolYearStartsOn, new Date());
  const decidable = late || (canDecide(perms) && r.verfahrenStatus !== "abgeschlossen" && (open || (DECISION_STATUSES as readonly string[]).includes(a.status)));
  const slots = manage && (open || a.status === "unbestaetigt") ? await listSlots(db, a.verfahrenId) : [];
  const options = slots.filter((s) => s.id === a.slotId || (s.free > 0 && s.startsAt > new Date())).map((s) => ({ id: s.id, label: `${slotText(s)}${s.id === a.slotId ? " (aktuell)" : ""}` }));
  const row = (label: string, value: React.ReactNode) => (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="break-words">{value || "–"}</dd>
    </>
  );
  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`Schulanmeldung · ${r.number}`}
        title={`${a.childLastName}, ${a.childFirstName}`}
        actions={
          <span className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="secondary">
              <Link href={`/druck/anmeldung/${a.id}`}>Anmeldebogen drucken</Link>
            </Button>
            {canAuskunft(perms) && (
              // Auskunft nach Art. 15 (P4-42) – nur per POST, protokolliert
              <form method="post" action={`/api/verwaltung/anmeldung-auskunft/${encodeURIComponent(a.id)}`}>
                <Button type="submit" size="sm" variant="secondary">
                  Auskunft (JSON)
                </Button>
              </form>
            )}
          </span>
        }
      />
      <VerfahrenNav id={a.verfahrenId} current="antraege" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <Card aria-label="Angaben">
            <CardHeader title="Angaben" />
            <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]">
              {row("Stand", <Badge tone="soft">{ANTRAG_STATUS_LABELS[a.status]}</Badge>)}
              {row("Kind", `${a.childFirstName} ${a.childLastName}`)}
              {row("Geburtsdatum", a.childBirthDate.split("-").reverse().join("."))}
              {row("Grundschule", a.primarySchool)}
              {row("Geschwisterkind", a.sibling ? `ja${a.siblingNote ? ` – ${a.siblingNote}` : ""}` : "nein")}
              {row("Zweitwunsch", a.secondChoiceSchool)}
              {row("Elternteil", a.parent1Name)}
              {row("E-Mail", a.parent1Email)}
              {row("Telefon", a.parent1Phone)}
              {row("Anschrift", [a.addressStreet, [a.addressZip, a.addressCity].filter(Boolean).join(" ")].filter(Boolean).join(", "))}
              {row("Zweiter Elternteil", a.parent2Name)}
              {row("E-Mail (zweiter Elternteil)", a.parent2Email)}
              {row("Hinweise", a.hints && <span className="whitespace-pre-line">{a.hints}</span>)}
              {row("Gesprächstermin", r.slot ? slotText(r.slot, r.slot.room) : null)}
              {row("Eingang", `${dateTime.format(a.createdAt)}${a.parentUserId ? " (Elternkonto)" : ""}`)}
              {row("Datenschutzhinweis gelesen", dateTime.format(a.consentAt))}
            </dl>
          </Card>
          <Card aria-label="Verlauf">
            <CardHeader title="Verlauf" />
            <ol className="flex flex-col gap-2 text-sm">
              {r.events.map((e) => (
                <li key={e.id} className="flex flex-col">
                  <span className="text-xs text-muted">
                    {dateTime.format(e.at)} · {EVENT_LABELS[e.kind] ?? e.kind} · {e.actorName ?? "Eltern/System"}
                  </span>
                  {e.text && <span className="whitespace-pre-line">{e.text}</span>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <div className="flex flex-col gap-6">
          {decidable && (
            <Card aria-label="Entscheidung">
              <CardHeader title="Entscheidung" />
              <p className="text-sm text-muted">
                {open ? "Noch nicht entschieden." : `Entschieden: ${ANTRAG_STATUS_LABELS[a.status]}${a.decidedAt ? ` am ${dateTime.format(a.decidedAt)}` : ""}.`} Geschwister und Wohnort
                sind nur Information; die Eltern erfahren das Ergebnis per Bescheid.
              </p>
              {a.decisionNote && <p className="text-sm whitespace-pre-line">Notiz: {a.decisionNote}</p>}
              <DecideOneForm verfahrenId={a.verfahrenId} antragId={a.id} current={a.status} lateAdmission={late} />
            </Card>
          )}
          <Card aria-label="Unterlagen vorgelegt">
            <CardHeader title="Unterlagen vorgelegt" />
            {manage && open ? (
              <ChecklistForm verfahrenId={a.verfahrenId} antragId={a.id} items={katalog.checklist} checked={r.checklist} />
            ) : (
              <ul className="text-sm">
                {katalog.checklist.map((c) => (
                  <li key={c.key}>
                    {r.checklist[c.key] ? "✓" : "–"} {c.label}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {manage && (open || a.status === "unbestaetigt") && (
            <Card aria-label="Termin">
              <CardHeader title="Termin verschieben" />
              <MoveSlotForm verfahrenId={a.verfahrenId} antragId={a.id} current={a.slotId} options={options} />
            </Card>
          )}
          {manage && (
            <Card aria-label="Notizen">
              <CardHeader title="Notiz" />
              <NoteForm verfahrenId={a.verfahrenId} antragId={a.id} />
            </Card>
          )}
        </div>
      </div>
    </main>
  );
}
