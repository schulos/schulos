import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { decisionList } from "@/modules/anmeldung/entscheidung";
import { canDecide, getVerfahren, lateAdmissionOpen } from "@/modules/anmeldung/service";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { DecisionList, VerfahrenSteps } from "../../forms";
import { VerfahrenBadge, VerfahrenNav } from "../../shared";

export const metadata: Metadata = { title: "Entscheidung" };
export const dynamic = "force-dynamic";

/**
 * Entscheidung über die Anträge (P4-37): Liste mit Kapazität, Geschwister- und Wohnort-Hinweisen (nur Information), Auswahl
 * per Häkchen. Entscheiden und Abschließen nur mit `anmeldung.decide`; das Sekretariat sieht die Liste lesend.
 */
export default async function EntscheidungPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const db = await getDb();
  const v = await getVerfahren(db, perms, decodeURIComponent(id)).catch(() => null);
  if (!v) notFound();
  const { rows, capacity } = await decisionList(db, perms, v.id);
  // Q5-19: nach dem Abschluss nur Nachrücken von der Warteliste, bis zum Beginn des Zielschuljahres
  const late = canDecide(perms) && v.status === "abgeschlossen" && lateAdmissionOpen(v.schoolYearStartsOn, new Date());
  const decide = (canDecide(perms) && v.status !== "abgeschlossen") || late;
  const undecided = capacity.undecided;
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Schulanmeldung" title={v.name} actions={<VerfahrenBadge status={v.status} />} />
      <VerfahrenNav id={v.id} current="entscheidung" />
      <div className="grid gap-4 sm:grid-cols-4" aria-label="Kapazität">
        {[
          ["Plätze", capacity.capacity ?? "–"],
          ["Aufgenommen", capacity.byStatus.aufgenommen + capacity.byStatus.uebernommen],
          ["Warteliste / abgelehnt", `${capacity.byStatus.warteliste} / ${capacity.byStatus.abgelehnt}`],
          ["Ohne Entscheidung", undecided],
        ].map(([label, value]) => (
          <Card key={String(label)} className="flex flex-col gap-1">
            <span className="text-xs text-muted">{label}</span>
            <span className="text-2xl font-semibold tabular-nums">{value}</span>
          </Card>
        ))}
      </div>
      <p className="max-w-3xl text-sm text-muted">
        Geschwisterkinder, Wohnort und Kapazität stehen hier nur zur Information. SchulOS wählt nicht aus und lost nicht – über jede Aufnahme
        entscheidet die Schulleitung (§ 46 SchulG NRW). Die Eltern bekommen nach der ersten Entscheidung nur eine Mail „Bescheid folgt per
        Post“; den Bescheid erstellt die Schule über den Serienbrief-Export.
      </p>
      {late && (
        <p role="note" className="max-w-3xl text-sm">
          Das Verfahren ist abgeschlossen. Bis zum Beginn des Schuljahres ({v.schoolYearStartsOn.split("-").reverse().join(".")}) können Kinder von der
          Warteliste nachrücken; sie werden dann im Schuljahreswechsel (Schritt „Neuaufnahmen“) übernommen.
        </p>
      )}
      {rows.length === 0 ? (
        <EmptyState title="Keine bestätigten Anträge" />
      ) : (
        <DecisionList
          verfahrenId={v.id}
          capacity={capacity.capacity}
          admitted={capacity.byStatus.aufgenommen + capacity.byStatus.uebernommen}
          canDecide={decide}
          lateAdmission={late}
          rows={rows.map((r) => ({
            id: r.id,
            number: r.number,
            child: `${r.childLastName}, ${r.childFirstName}`,
            birth: r.childBirthDate.split("-").reverse().join("."),
            school: r.primarySchool ?? "",
            sibling: r.sibling ? r.siblingNote || "ja" : null,
            place: [r.zip, r.city].filter(Boolean).join(" "),
            status: r.status,
            documentsComplete: r.documentsComplete,
            href: `/verwaltung/anmeldung/${v.id}/antrag/${r.id}`,
          }))}
        />
      )}
      {canDecide(perms) && v.status !== "abgeschlossen" && (
        <Card aria-label="Abschluss">
          <CardHeader title="Verfahren abschließen" />
          <p className="mb-3 text-sm text-muted">
            {v.status !== "geschlossen"
              ? "Erst die Anmeldung schließen (Übersicht), dann abschließen."
              : undecided > 0
                ? `Noch ${undecided} Anträge ohne Entscheidung.`
                : `Nach dem Abschluss sind die Entscheidungen fest; abgelehnte Anträge und die Warteliste werden ${v.rejectKeepDays} Tage später gelöscht. Aufgenommene Kinder übernimmt der Schuljahreswechsel.`}
          </p>
          {v.status === "geschlossen" && undecided === 0 && <VerfahrenSteps id={v.id} steps={["abschliessen"]} />}
        </Card>
      )}
    </main>
  );
}
