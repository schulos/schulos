import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { toBerlinDate } from "@/core/time";
import { canManage, dateLabel, getOffer, WEEKDAYS, type SessionRow } from "@/modules/ganztag/service";
import { Badge } from "@schulos/ui/badge";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { DeleteSeries, OfferSettingsForm, SeriesForm, SessionActions, SessionForm } from "./forms";

export const metadata: Metadata = { title: "Ganztag: Angebot" };

const fmt = (ymd: string) => ymd.split("-").reverse().join(".");

function StatusBadge({ s }: { s: SessionRow }) {
  if (s.status === "ausgefallen") return <Badge tone="warn">fällt aus</Badge>;
  if (s.status === "erfasst") return <Badge tone="success">erfasst</Badge>;
  return <Badge>geplant</Badge>;
}

function SessionList({ items, label, manager }: { items: SessionRow[]; label: string; manager: boolean }) {
  return (
    <ul className="flex flex-col gap-2" aria-label={label}>
      {items.map((s) => {
        const name = `${dateLabel(s.date)} ${s.startsAt}`;
        return (
          <li key={s.id} className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex flex-wrap items-center gap-2">
              {s.status === "ausgefallen" ? (
                <span className="font-medium text-muted line-through">{name}</span>
              ) : (
                <Link href={`/ganztag/termin/${s.id}`} className="font-medium hover:underline">
                  {name}
                </Link>
              )}
              <span className="text-sm text-muted">bis {s.endsAt}</span>
              <StatusBadge s={s} />
              {!s.seriesId && <Badge>Einzeltermin</Badge>}
            </span>
            {s.status !== "erfasst" || manager ? <SessionActions id={s.id} label={name} cancelled={s.status === "ausgefallen"} canDelete={s.status !== "erfasst" || manager} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

export default async function GruppePage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const offer = await getOffer(await getDb(), perms, decodeURIComponent(id));
  if (!offer) notFound();
  const today = toBerlinDate(new Date());
  const manager = canManage(perms);
  const upcoming = offer.sessions.filter((s) => s.date >= today);
  const past = offer.sessions.filter((s) => s.date < today).reverse();

  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader eyebrow={`Ganztag · ${GROUP_KIND_LABELS[offer.group.kind]}`} title={offer.group.name} />
      <p className="text-muted">
        {offer.leaders.length ? `Leitung: ${offer.leaders.join(", ")}` : "Ohne Leitung"} · {offer.members === 1 ? "1 Mitglied" : `${offer.members} Mitglieder`}
        {offer.settings.mandatory && " · verpflichtendes Angebot"}
      </p>

      <Card className="gap-3">
        <h2 className="text-lg font-semibold">Nächste Termine</h2>
        {upcoming.length === 0 ? <p className="text-sm text-muted">Keine Termine geplant – unten eine Serie oder einen Einzeltermin anlegen.</p> : <SessionList items={upcoming.slice(0, 12)} label="Nächste Termine" manager={manager} />}
        {upcoming.length > 12 && <p className="text-sm text-muted">und {upcoming.length - 12} weitere</p>}
      </Card>

      {past.length > 0 && (
        <Card className="gap-3">
          <h2 className="text-lg font-semibold">Vergangene Termine</h2>
          <SessionList items={past.slice(0, 10)} label="Vergangene Termine" manager={manager} />
        </Card>
      )}

      <Card className="gap-3">
        <h2 className="text-lg font-semibold">Serien</h2>
        {offer.series.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label="Serien">
            {offer.series.map((s) => {
              const label = `${WEEKDAYS[s.weekday]} ${s.startsAt}–${s.endsAt}`;
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3">
                  <span className="flex flex-col">
                    <span className="font-medium">{label}</span>
                    <span className="text-xs text-muted">
                      {fmt(s.validFrom)} bis {fmt(s.validTo)} · {s.sessions === 1 ? "1 Termin" : `${s.sessions} Termine`}
                    </span>
                  </span>
                  <DeleteSeries id={s.id} label={label} />
                </li>
              );
            })}
          </ul>
        )}
        <SeriesForm groupId={offer.group.id} defaults={offer.defaults} />
      </Card>

      <Card className="gap-3">
        <h2 className="text-lg font-semibold">Einzeltermin</h2>
        <SessionForm groupId={offer.group.id} today={today} />
      </Card>

      {manager && (
        <Card className="gap-3">
          <h2 className="text-lg font-semibold">Einstellungen</h2>
          <OfferSettingsForm groupId={offer.group.id} settings={offer.settings} />
        </Card>
      )}
    </main>
  );
}
