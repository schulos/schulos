import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { roomHref } from "@/core/room-href";
import { FLOOR_PLAN_ALT_MAX, FLOOR_PLAN_MAX_MB, canEditFloorPlans, floorPlanEditor } from "@/modules/verwaltung/grundriss";
import { deleteFloorPlanAction, setFloorPlanAction, setFloorPlanAltAction, setRoomPlanPointAction } from "@/modules/verwaltung/grundriss-actions";
import { FloorPlanNotice, floorPlanSrc } from "@/ui/grundriss";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { DeletePlanButton, PlanAltForm, PlanPointEditor, PlanUploadForm } from "./plan-forms";

export const metadata: Metadata = { title: "Grundriss" };

/**
 * RS-13: Grundriss einer Etage pflegen (`verwaltung.school`): Bild hochladen/ersetzen mit Pflicht-Alternativtext, Räume der
 * Etage als Punkt verorten (Klick/Touch, Pfeiltasten oder Prozentwerte), Plan löschen.
 */
export default async function GrundrissPage({ params }: { params: Promise<{ etage: string }> }) {
  const { perms } = await requireUser();
  if (!canEditFloorPlans(perms)) notFound();
  const floorId = decodeURIComponent((await params).etage);
  const data = await floorPlanEditor(await getDb(), perms, floorId);
  if (!data) notFound();
  const { plan } = data;
  const placed = data.rooms.filter((r) => r.x !== null).length;
  return (
    <main className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        eyebrow="Stammdaten · Gebäude und Etagen"
        title={`Grundriss ${data.building} · ${data.floor}`}
        actions={
          <Button asChild>
            <Link href="/verwaltung/stammdaten/raeume/gebaeude">Zu Gebäude und Etagen</Link>
          </Button>
        }
      />
      <p className="text-sm text-muted">
        Ein Plan je Etage. Der Grundriss ergänzt den Raumfinder und den Raumsteckbrief („Lage“); die Raumliste bleibt die
        Hauptansicht. Wer ihn sieht, legt die Moduleinstellung „Grundriss je Etage“ fest (Vorgabe: alle Angemeldeten).
      </p>
      <FloorPlanNotice />

      <Card aria-labelledby="plan">
        <CardHeader title={<span id="plan">{plan ? "Plan ersetzen" : "Plan hochladen"}</span>} />
        <PlanUploadForm action={setFloorPlanAction.bind(null, data.floorId)} maxMb={FLOOR_PLAN_MAX_MB} altMax={FLOOR_PLAN_ALT_MAX} altDefault={plan?.alt ?? ""} replace={Boolean(plan)} />
      </Card>

      {plan && (
        <>
          <Card aria-labelledby="verorten">
            <CardHeader title={<span id="verorten">Räume verorten</span>} />
            <p className="mb-4 text-sm text-muted">
              {placed} von {data.rooms.length} {data.rooms.length === 1 ? "Raum" : "Räumen"} dieser Etage verortet. Räume kommen über
              die Stammdaten (Gebäude und Etage) auf die Etage; ein Etagenwechsel entfernt den Punkt.
            </p>
            {data.rooms.length === 0 ? (
              <p className="text-sm text-muted">Auf dieser Etage gibt es noch keine Räume.</p>
            ) : (
              <PlanPointEditor action={setRoomPlanPointAction} src={floorPlanSrc(plan.floorId, plan.version)} width={plan.width} height={plan.height} alt={`Grundriss ${data.building} · ${data.floor}: ${plan.alt}`} rooms={data.rooms} />
            )}
          </Card>

          <Card aria-labelledby="raeume-liste">
            <CardHeader title={<span id="raeume-liste">Räume dieser Etage</span>} />
            <ul className="flex flex-col divide-y divide-border text-sm">
              {data.rooms.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={roomHref(r.id)} className="font-medium text-accent-ink hover:underline">
                    {r.id}
                    {r.name !== r.id && r.name !== `Raum ${r.id}` ? ` – ${r.name}` : ""}
                  </Link>
                  <span className="text-muted">
                    {r.x === null || r.y === null
                      ? "noch nicht verortet"
                      : `${(r.x * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} % von links, ${(r.y * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} % von oben`}
                    {r.active ? "" : " · stillgelegt"}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card aria-labelledby="alt">
            <CardHeader title={<span id="alt">Alternativtext und Löschen</span>} />
            <div className="flex flex-col gap-4">
              <PlanAltForm action={setFloorPlanAltAction.bind(null, data.floorId)} alt={plan.alt} altMax={FLOOR_PLAN_ALT_MAX} />
              <p className="text-xs text-muted">
                {plan.width} × {plan.height} px
              </p>
              <DeletePlanButton action={deleteFloorPlanAction.bind(null, data.floorId)} />
            </div>
          </Card>
        </>
      )}
    </main>
  );
}
