import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOn } from "@/core/modules/guard";
import { toBerlinDate } from "@/core/time";
import { createMaintenanceAction, deleteMaintenanceAction } from "@/modules/gebaeude/actions";
import { roomOptions, canConfigure } from "@/modules/gebaeude/pruefungen";
import { canManage, canViewAll } from "@/modules/gebaeude/service";
import { listMaintenance } from "@/modules/gebaeude/wartung";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { SpecForm, type FieldSpec } from "../spec-form";
import { GebaeudeNav } from "../ui";

export const metadata: Metadata = { title: "Wartung" };

type Item = Awaited<ReturnType<typeof listMaintenance>>[number];

function MaintenanceList({ items, label, manage }: { items: Item[]; label: string; manage: boolean }) {
  return (
    <ul aria-label={label} className="flex flex-col gap-2">
      {items.map((m) => (
        <li key={m.id} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="font-medium">{m.title}</span>
            <span className="text-sm">{m.span}</span>
            <span className="text-xs text-muted">
              {[m.provider, m.rooms.length ? `Raum ${m.rooms.join(", ")}` : null, m.building].filter(Boolean).join(" · ")}
            </span>
            <span className="flex flex-wrap gap-1.5">
              {m.blocked && <Badge tone="warn">Räume gesperrt</Badge>}
              {m.calendarEventId && <Badge tone="soft">im Schulkalender</Badge>}
            </span>
            {m.note && <p className="text-sm whitespace-pre-line">{m.note}</p>}
          </div>
          {manage && (
            <form action={deleteMaintenanceAction.bind(null, m.id)}>
              <Button type="submit" size="sm" variant="ghost" aria-label={`${m.title} absagen`}>
                Absagen
              </Button>
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Wartungstermine von Firmen: optional Raumsperre und Schulkalender, Gong an Lehrkräfte der betroffenen Räume. */
export default async function WartungPage() {
  const { perms } = await requireUser();
  if (!canViewAll(perms)) notFound();
  const db = await getDb();
  const now = new Date();
  const manage = canManage(perms);
  const [upcoming, past, rooms, kalender] = await Promise.all([
    listMaintenance(db, perms, now),
    listMaintenance(db, perms, now, true),
    manage ? roomOptions(db) : Promise.resolve([]),
    moduleOn("kalender"),
  ]);
  const day = toBerlinDate(new Date(now.getTime() + 86_400_000));
  const fields: FieldSpec[] = [
    { name: "title", label: "Was wird gewartet?", type: "text", required: true, maxLength: 120, wide: true, placeholder: "z. B. Wartung Heizung" },
    { name: "provider", label: "Firma", type: "text", maxLength: 120 },
    { name: "building", label: "Gebäude", type: "text", maxLength: 60 },
    { name: "start", label: "Beginn", type: "datetime-local", required: true, defaultValue: `${day}T08:00` },
    { name: "end", label: "Ende", type: "datetime-local", required: true, defaultValue: `${day}T12:00` },
    { name: "roomIds", label: "Räume", type: "multiselect", options: rooms, wide: true, hint: "mehrere mit Strg bzw. ⌘; Lehrkräfte, die dort unterrichten, bekommen einen Gong" },
    { name: "blockRooms", label: "Räume für den Zeitraum sperren (ganze Tage)", type: "checkbox", wide: true },
    ...(kalender ? [{ name: "calendar", label: "Im Schulkalender eintragen", type: "checkbox" as const, checked: true, wide: true }] : []),
    { name: "note", label: "Hinweis", type: "textarea", maxLength: 2000, wide: true },
  ];

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Gebäude & Technik" title="Wartung" />
      <GebaeudeNav current="wartung" configure={canConfigure(perms)} />
      <section aria-labelledby="kommend" className="flex flex-col gap-3">
        <h2 id="kommend" className="font-display text-xl font-bold">
          Kommende Termine
        </h2>
        {upcoming.length === 0 ? <EmptyState title="Keine Wartung geplant" /> : <MaintenanceList items={upcoming} label="Kommende Wartungstermine" manage={manage} />}
      </section>
      {manage && (
        <Card aria-labelledby="neu">
          <CardHeader title={<span id="neu">Wartungstermin eintragen</span>} />
          <SpecForm action={createMaintenanceAction} label="Wartungstermin eintragen" submit="Eintragen" fields={fields} />
        </Card>
      )}
      {past.length > 0 && (
        <section aria-labelledby="vergangen" className="flex flex-col gap-3">
          <h2 id="vergangen" className="font-display text-xl font-bold">
            Vergangen (90 Tage)
          </h2>
          <MaintenanceList items={past} label="Vergangene Wartungstermine" manage={false} />
        </section>
      )}
    </main>
  );
}
