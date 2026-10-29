import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import {
  createBuildingAction,
  createFloorAction,
  deleteBuildingAction,
  deleteFloorAction,
  updateBuildingAction,
  updateFloorAction,
} from "@/modules/verwaltung/gebaeude-actions";
import { BUILDINGS_MAX, FLOORS_PER_BUILDING_MAX, canManagePlaces, listBuildings } from "@/modules/verwaltung/gebaeude-etagen";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { DeletePlaceButton, PlaceForm } from "./place-forms";

export const metadata: Metadata = { title: "Gebäude und Etagen" };

const roomsText = (n: number) => (n === 0 ? "keine Räume" : n === 1 ? "1 Raum" : `${n} Räume`);

/** RS-10: Gebäude und Etagen als Stammdaten (`verwaltung.school`) – Reihenfolge für Raumfinder, Raumliste und Auswahl. */
export default async function GebaeudePage() {
  const { perms } = await requireUser();
  if (!canManagePlaces(perms)) notFound();
  const list = await listBuildings(await getDb());
  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader eyebrow="Stammdaten · Räume" title="Gebäude und Etagen" />
      <p className="text-sm text-muted">
        Gebäude und Etagen ordnen die Räume im Raumfinder und in den Listen. Die Reihenfolge bestimmt die Sortierung (kleine Zahl
        zuerst). Ein Gebäude bzw. eine Etage mit Räumen lässt sich erst löschen, wenn die Räume umgezogen sind. Umbenennen gilt
        sofort für alle Räume.{" "}
        <Link href="/verwaltung/stammdaten?bereich=raeume" className="font-medium text-accent-ink hover:underline">
          Zur Raumliste
        </Link>
      </p>
      {list.length === 0 && <p className="text-sm text-muted">Noch keine Gebäude.</p>}
      {list.map((b) => (
        <Card key={b.id} aria-label={`Gebäude ${b.name}`}>
          <CardHeader title={`${b.name} · ${roomsText(b.rooms)}`} />
          <div className="flex flex-col gap-4">
            <PlaceForm name={`Gebäude ${b.name}`} nameLabel="Gebäude" action={updateBuildingAction.bind(null, b.id)} initial={b} submitLabel="Speichern" />
            <div className="self-end">
              <DeletePlaceButton
                action={deleteBuildingAction.bind(null, b.id)}
                label={`Gebäude ${b.name} löschen`}
                question={`Gebäude „${b.name}“ samt seinen Etagen löschen?`}
              />
            </div>
            <section aria-label={`Etagen ${b.name}`} className="flex flex-col gap-3 border-t border-border pt-4">
              <h3 className="text-sm font-semibold">Etagen</h3>
              {b.floors.length === 0 && <p className="text-sm text-muted">Noch keine Etagen.</p>}
              <ul className="flex flex-col divide-y divide-border">
                {b.floors.map((f) => (
                  <li key={f.id} className="flex flex-col gap-2 py-3 first:pt-0">
                    <p className="text-xs text-muted">{roomsText(f.rooms)}</p>
                    <PlaceForm name={`Etage ${f.name} (${b.name})`} nameLabel="Etage" action={updateFloorAction.bind(null, f.id)} initial={f} submitLabel="Speichern" />
                    <div className="self-end">
                      <DeletePlaceButton action={deleteFloorAction.bind(null, f.id)} label={`Etage ${f.name} (${b.name}) löschen`} question={`Etage „${f.name}“ löschen?`} />
                    </div>
                  </li>
                ))}
              </ul>
              {b.floors.length < FLOORS_PER_BUILDING_MAX && (
                <PlaceForm name={`Neue Etage in ${b.name}`} nameLabel="Neue Etage" action={createFloorAction.bind(null, b.id)} submitLabel="Etage anlegen" />
              )}
            </section>
          </div>
        </Card>
      ))}
      {list.length < BUILDINGS_MAX && (
        <Card>
          <CardHeader title="Neues Gebäude" />
          <PlaceForm name="Neues Gebäude" nameLabel="Gebäude" action={createBuildingAction} submitLabel="Gebäude anlegen" />
        </Card>
      )}
    </main>
  );
}
