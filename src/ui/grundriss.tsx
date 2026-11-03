// RS-13: Grundriss einer Etage mit Räumen als Punkt (nur lesen) – für Raumfinder und „Lage“ im Raumsteckbrief. Ohne Hooks,
// auch serverseitig nutzbar. Barrierefreiheit: der Plan ist eine Ergänzung, die Raumliste bleibt die Hauptansicht; das Bild
// trägt den Pflicht-Alternativtext, jeder Punkt ist ein Link mit Raumkürzel und -name (Tab-Reihenfolge nach Kürzel), Trefferfläche
// 44 × 44 px, sichtbarer Fokus. Darunter steht immer die feste Zeile „Nicht als Flucht- und Rettungsplan verwenden“.
import Link from "next/link";
import { roomHref } from "@/core/room-href";
import type { FloorPlanMeta, FloorPlanRoom } from "@/modules/verwaltung/grundriss";
import { cn } from "@schulos/ui/cn";

/** Feste Zeile an jedem Plan (rs-6). Hier statt im Dienst, weil auch Client-Komponenten diese Datei laden. */
export const FLOOR_PLAN_NOTICE = "Nicht als Flucht- und Rettungsplan verwenden.";

/** Bild-URL des Grundrisses; `v` ändert sich mit jedem neuen Plan (Cache). */
export const floorPlanSrc = (floorId: string, version: number, klein = false) =>
  `/api/raeume/grundriss/${encodeURIComponent(floorId)}?v=${version}${klein ? "&klein=1" : ""}`;

/** Rein: Position eines Punkts als CSS-Prozentwerte. */
export const pointStyle = (x: number, y: number) => ({ left: `${(x * 100).toFixed(2)}%`, top: `${(y * 100).toFixed(2)}%` });

const roomLabel = (r: { id: string; name: string }) => (r.name && r.name !== r.id && r.name !== `Raum ${r.id}` ? `Raum ${r.id} – ${r.name}` : `Raum ${r.id}`);

/** Feste Zeile an jedem Plan (rs-6). */
export function FloorPlanNotice({ className }: { className?: string }) {
  return (
    <p role="note" className={cn("rounded-lg bg-warn-soft px-3 py-2 text-sm font-medium text-warn", className)}>
      {FLOOR_PLAN_NOTICE}
    </p>
  );
}

/** Ein Punkt: unsichtbare Trefferfläche 44 px, sichtbar ein Schild mit dem Raumkürzel. */
export function PlanMarker({ room, highlight = false, href }: { room: FloorPlanRoom; highlight?: boolean; href?: string }) {
  const pill = (
    <span
      aria-hidden
      className={cn(
        "flex h-6 min-w-6 items-center justify-center rounded-full border-2 px-1.5 text-[11px] leading-none font-bold whitespace-nowrap shadow-sm",
        highlight ? "h-8 min-w-8 border-surface bg-accent text-sm text-accent-fg ring-4 ring-accent/40" : "border-surface bg-ink text-surface",
      )}
    >
      {room.id}
    </span>
  );
  const cls = "absolute flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:ring-4 focus-visible:ring-surface";
  if (room.x === null || room.y === null) return null;
  return href ? (
    <Link href={href} aria-label={roomLabel(room)} className={cls} style={pointStyle(room.x, room.y)}>
      {pill}
    </Link>
  ) : (
    <span role="img" aria-label={roomLabel(room)} className={cls} style={pointStyle(room.x, room.y)}>
      {pill}
    </span>
  );
}

/**
 * Grundriss mit Punkten. `highlight` hebt einen Raum hervor (Steckbrief „Lage“); `onlyHighlight` zeigt nur diesen Punkt.
 * Die Punkte stehen in einer Liste („Räume auf dem Plan“), damit Screenreader sie zählen und überspringen können.
 */
export function FloorPlan({
  plan,
  rooms,
  highlight,
  onlyHighlight = false,
  small = false,
  className,
}: {
  plan: FloorPlanMeta;
  rooms: FloorPlanRoom[];
  highlight?: string;
  onlyHighlight?: boolean;
  small?: boolean;
  className?: string;
}) {
  const shown = rooms.filter((r) => r.x !== null && r.y !== null && (!onlyHighlight || r.id === highlight));
  const title = `Grundriss ${plan.building} · ${plan.floor}`;
  return (
    <figure className={cn("flex flex-col gap-2", className)}>
      <div className="relative overflow-hidden rounded-lg border border-border bg-surface-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- geschützte Route mit Sitzung, keine Bildoptimierung */}
        <img src={floorPlanSrc(plan.floorId, plan.version, small)} alt={`${title}: ${plan.alt}`} width={plan.width} height={plan.height} loading="lazy" className="block h-auto w-full" />
        {shown.length > 0 && (
          <ul aria-label={`Räume auf dem ${title}`} className="absolute inset-0">
            {shown.map((r) => (
              <li key={r.id}>
                <PlanMarker room={r} highlight={r.id === highlight} href={r.id === highlight ? undefined : roomHref(r.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <figcaption className="flex flex-col gap-2 text-sm text-muted">
        <span>
          {title}
          {!onlyHighlight && ` · ${shown.length === 1 ? "1 Raum verortet" : `${shown.length} Räume verortet`}`}
        </span>
        <FloorPlanNotice />
      </figcaption>
    </figure>
  );
}
