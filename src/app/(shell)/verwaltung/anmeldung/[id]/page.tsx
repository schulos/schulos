import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinLocal } from "@/core/time";
import { updateVerfahrenAction } from "@/modules/anmeldung/actions";
import { ANTRAG_STATUSES, ANTRAG_STATUS_LABELS, VERFAHREN_KIND_LABELS } from "@/modules/anmeldung/labels";
import { canDecide, canManage, capacitySummary, getVerfahren } from "@/modules/anmeldung/service";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { VerfahrenForm, VerfahrenSteps } from "../forms";
import { dateTime, formOptions, VerfahrenBadge, VerfahrenNav } from "../shared";

export const metadata: Metadata = { title: "Anmeldeverfahren" };
export const dynamic = "force-dynamic";

export default async function VerfahrenPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const db = await getDb();
  const v = await getVerfahren(db, perms, decodeURIComponent(id)).catch(() => null);
  if (!v) notFound();
  const [cap, { years, grades }] = await Promise.all([capacitySummary(db, v.id), formOptions(db)]);
  const manage = canManage(perms);
  const manageSteps = !manage
    ? []
    : v.status === "entwurf"
      ? (["veroeffentlichen", "loeschen"] as const)
      : v.status === "offen"
        ? (["schliessen"] as const)
        : v.status === "geschlossen"
          ? (["veroeffentlichen"] as const)
          : [];
  // Abschließen (P4-37): Schulleitung, wenn geschlossen und über alle Anträge entschieden
  const steps = [...manageSteps, ...(canDecide(perms) && v.status === "geschlossen" && cap.undecided === 0 ? (["abschliessen"] as const) : [])];
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow={`Schulanmeldung · ${VERFAHREN_KIND_LABELS[v.kind]}`} title={v.name} actions={<VerfahrenBadge status={v.status} />} />
      <VerfahrenNav id={v.id} current="uebersicht" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Einstellungen" />
          {manage && v.status !== "abgeschlossen" ? (
            <VerfahrenForm
              action={updateVerfahrenAction.bind(null, v.id)}
              submitLabel="Speichern"
              years={years}
              grades={grades}
              locked={v.status !== "entwurf"}
              initial={{
                name: v.name,
                kind: v.kind,
                targetSchoolYearId: v.targetSchoolYearId,
                targetGradeLevel: String(v.targetGradeLevel),
                opensAt: toBerlinLocal(v.opensAt),
                closesAt: toBerlinLocal(v.closesAt),
                capacity: v.capacity === null ? "" : String(v.capacity),
                intro: v.intro,
                rejectKeepDays: String(v.rejectKeepDays),
                fields: v.fieldSet,
              }}
            />
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Schuljahr</dt>
              <dd>{v.schoolYearName}</dd>
              <dt className="text-muted">Zeitraum</dt>
              <dd>
                {dateTime.format(v.opensAt)} – {dateTime.format(v.closesAt)}
              </dd>
              <dt className="text-muted">Plätze</dt>
              <dd>{v.capacity ?? "–"}</dd>
            </dl>
          )}
        </Card>
        <div className="flex flex-col gap-6">
          {steps.length > 0 && (
            <Card aria-label="Veröffentlichung">
              <CardHeader title="Veröffentlichung" />
              <p className="mb-3 text-sm text-muted">
                {v.status === "entwurf"
                  ? "Erst nach dem Veröffentlichen sehen Eltern das Verfahren unter /anmeldung – im eingestellten Zeitraum. Vorher Gesprächstermine anlegen."
                  : v.status === "offen"
                    ? "Nach dem Schließen nimmt das Verfahren keine neuen Anträge mehr an; bestehende werden weiter bearbeitet."
                    : v.status === "geschlossen" && manage
                      ? "Wieder veröffentlichen, um weitere Anträge anzunehmen."
                      : "Über alle Anträge ist entschieden – das Verfahren lässt sich abschließen."}
              </p>
              <VerfahrenSteps id={v.id} steps={[...steps]} />
            </Card>
          )}
          <Card aria-label="Stand">
            <CardHeader title="Stand" />
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Plätze</dt>
              <dd className="text-right tabular-nums">{cap.capacity ?? "–"}</dd>
              {cap.free !== null && (
                <>
                  <dt className="text-muted">noch frei (nach Aufnahmen)</dt>
                  <dd className="text-right tabular-nums">{cap.free}</dd>
                </>
              )}
              {ANTRAG_STATUSES.map((s) => (
                <div key={s} className="contents">
                  <dt className="text-muted">{ANTRAG_STATUS_LABELS[s]}</dt>
                  <dd className="text-right tabular-nums">{cap.byStatus[s]}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-muted">Nur zur Information – SchulOS wählt nicht automatisch aus.</p>
          </Card>
        </div>
      </div>
    </main>
  );
}
