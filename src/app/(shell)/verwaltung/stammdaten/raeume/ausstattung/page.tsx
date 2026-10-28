import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { deleteEquipmentTypeAction, mergeEquipmentTypeAction, renameEquipmentTypeAction } from "@/modules/verwaltung/raum-daten-actions";
import { canManageInfoFields } from "@/modules/verwaltung/raum-rechte";
import { EQUIPMENT_NAME_MAX, listEquipmentTypes } from "@/modules/verwaltung/raumausstattung";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { DeleteTypeButton, MergeTypeForm, RenameTypeForm } from "./catalog-forms";

export const metadata: Metadata = { title: "Ausstattungskatalog" };

/**
 * RS-05: schulweiter Ausstattungskatalog – wächst beim Eintragen am Raum, hier nur Aufräumen (Projektleitung 2026-10-28):
 * umbenennen, Dubletten zusammenführen, Unbenutztes löschen. Stammdaten-Recht (`verwaltung.school`).
 */
export default async function AusstattungskatalogPage() {
  const { perms } = await requireUser();
  if (!canManageInfoFields(perms)) notFound();
  const types = await listEquipmentTypes(await getDb());
  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader eyebrow="Stammdaten · Räume" title="Ausstattungskatalog" />
      <p className="text-sm text-muted">
        Der Katalog wächst von selbst: Wer im Raumsteckbrief eine neue Ausstattung einträgt, nimmt sie hier auf, danach ist sie für
        alle Räume wählbar. Hier werden Einträge nur aufgeräumt – umbenennen gilt in allen Räumen, beim Zusammenführen bekommen
        die Räume den gewählten Eintrag (hat ein Raum beide, gilt die größere Menge).{" "}
        <Link href="/verwaltung/stammdaten?bereich=raeume" className="font-medium text-accent-ink hover:underline">
          Zur Raumliste
        </Link>
      </p>
      <Card>
        <CardHeader title={`${types.length} ${types.length === 1 ? "Eintrag" : "Einträge"}`} />
        {types.length === 0 && <p className="text-sm text-muted">Noch keine Einträge.</p>}
        <ul className="flex flex-col divide-y divide-border">
          {types.map((t) => (
            <li key={t.id} className="flex flex-col gap-3 py-4 first:pt-0" aria-label={t.name}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{t.name}</span>
                  <Badge tone={t.rooms === 0 ? "warn" : "neutral"}>{t.rooms === 0 ? "in keinem Raum" : `${t.rooms} ${t.rooms === 1 ? "Raum" : "Räume"}`}</Badge>
                </span>
                {t.rooms === 0 && <DeleteTypeButton action={deleteEquipmentTypeAction.bind(null, t.id)} label={t.name} />}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <RenameTypeForm action={renameEquipmentTypeAction.bind(null, t.id)} name={t.name} label={t.name} nameMax={EQUIPMENT_NAME_MAX} />
                <MergeTypeForm action={mergeEquipmentTypeAction.bind(null, t.id)} label={t.name} others={types.filter((o) => o.id !== t.id).map((o) => ({ id: o.id, name: o.name }))} />
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}
