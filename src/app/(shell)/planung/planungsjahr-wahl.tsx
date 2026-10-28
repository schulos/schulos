"use client";

import { useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { CalendarRange } from "lucide-react";
import { Button } from "@schulos/ui/button";
import { Select } from "@schulos/ui/field";
import { cn } from "@schulos/ui/cn";

type Role = "vergangen" | "laufend" | "folgejahr";

export interface PlanningYearBarProps {
  /** Wahl beim Rendern auf dem Server (Cookie) */
  initialYearId: string;
  baseId: string;
  cookieName: string;
  choices: { id: string; name: string; role: Role; roleLabel: string }[];
}

/** Wahl aus dem Cookie – unbekannt oder leer: das laufende Schuljahr (wie `resolvePlanningYear`). */
function readChoice(cookieName: string, ids: string[], baseId: string): string {
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  const id = raw ? decodeURIComponent(raw) : null;
  return id && ids.includes(id) ? id : baseId;
}

const noSubscribe = () => () => undefined;

/**
 * SP3-09a: Seiten, die der Jahreswahl folgen. Die übrigen arbeiten immer im laufenden Schuljahr – Tagesgeschäft (Vertretungen, Aufsichten),
 * Fachbedarf (Prognose fürs nächste Jahr aus dem laufenden) und bis SP3-09b Automatisch planen und Zeitwünsche.
 */
const FOLLOWS = [/^\/planung$/, /^\/planung\/unterricht(?:\/import)?$/, /^\/planung\/stundenplan$/, /^\/planung\/versionen(?:\/korrekturen)?$/, /^\/planung\/fahrplan$/];
/** Seiten einer einzelnen Version (Prüfung, Vorschau, Änderungen, Veröffentlichen) zeigen deren Schuljahr – ohne Hinweis. */
const NEUTRAL = [/^\/planung\/versionen\/(?!korrekturen$)/];

/**
 * Kopf des Planungsbereichs: welches Schuljahr geplant wird, mit Wechsel (GET an die Route – geht auch ohne JavaScript). Das Layout rendert
 * bei Navigation innerhalb des Bereichs nicht neu; darum liest der Kopf die Wahl nach jedem Seitenwechsel aus dem Cookie (eine Seite kann sie
 * per Deeplink umgestellt haben).
 */
export function PlanningYearBar({ initialYearId, baseId, cookieName, choices }: PlanningYearBarProps) {
  const pathname = usePathname();
  const params = useSearchParams();
  // kein Abo nötig: jeder Seitenwechsel rendert den Kopf neu (Pfad/Parameter), dabei wird das Cookie frisch gelesen
  const yearId = useSyncExternalStore(
    noSubscribe,
    () => readChoice(cookieName, choices.map((c) => c.id), baseId),
    () => initialYearId,
  );
  const current = choices.find((c) => c.id === yearId) ?? choices.find((c) => c.id === baseId)!;
  const { name: yearName, role, roleLabel } = current;
  const baseName = choices.find((c) => c.id === baseId)?.name ?? yearName;
  const q = new URLSearchParams(params.toString());
  q.delete("jahr");
  const s = q.toString();
  const weiter = `${pathname}${s ? `?${s}` : ""}`;
  const follows = FOLLOWS.some((r) => r.test(pathname));
  return (
    <section
      aria-label="Planungsjahr"
      data-testid="planungsjahr-wahl"
      data-rolle={role}
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm",
        role === "laufend" ? "border-border bg-surface-2" : "border-warn-border bg-warn-soft",
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="flex items-center gap-2">
          <CalendarRange aria-hidden className="size-4 shrink-0" />
          <span>
            Du planst das Schuljahr <strong>{yearName}</strong> · {roleLabel}
          </span>
        </p>
        {role === "folgejahr" && follows && (
          <p data-testid="planungsjahr-hinweis">
            Folgejahr: Lehraufträge, Matrix, Deputate und Entwürfe gelten erst ab {yearName} – das laufende Schuljahr {baseName} bleibt unverändert.
          </p>
        )}
        {role === "vergangen" && follows && <p data-testid="planungsjahr-hinweis">Abgeschlossenes Schuljahr: alles nur lesbar.</p>}
        {role !== "laufend" && !follows && !NEUTRAL.some((r) => r.test(pathname)) && (
          <p data-testid="planungsjahr-hinweis">Diese Seite arbeitet immer im laufenden Schuljahr {baseName}.</p>
        )}
      </div>
      <form action="/planung/planungsjahr" method="get" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="weiter" value={weiter} />
        <Select key={yearId} name="jahr" defaultValue={yearId} aria-label="Planungsjahr wählen" className="h-9 w-64">
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.roleLabel})
            </option>
          ))}
        </Select>
        <Button type="submit" size="sm">
          Wechseln
        </Button>
      </form>
    </section>
  );
}
