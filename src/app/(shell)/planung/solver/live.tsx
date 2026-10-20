"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { passiveHeaders, passiveRefresh } from "@schulos/ui/auto-refresh";
import { Badge } from "@schulos/ui/badge";
import { Progress } from "@schulos/ui/misc";
import { isActive, RUN_STATUS, type RunStatusKey } from "./status";

/** Live-Zustand eines Laufs (Antwort von /api/stundenplan/solver/status) */
export interface LiveState {
  id: string;
  status: RunStatusKey;
  progress: number;
  cancelRequested: boolean;
  heartbeatAt: string | null;
  note: string | null;
}

const LiveContext = createContext<Record<string, LiveState>>({});

const clock = new Intl.DateTimeFormat("de-DE", { timeStyle: "medium", timeZone: "Europe/Berlin" });

/**
 * SP-07: fragt den Zustand wartender/rechnender Läufe sparsam nach (alle 3 s, solange einer rechnet; alle 6 s, solange nur welche
 * warten; nur bei sichtbarem Tab) und zeigt ihn ohne Neuladen. Erst wenn sich ein Status ändert (fertig, abgebrochen …), lädt die
 * Seite einmal neu – dann kommen Kennzahlen und Ergebnis vom Server. Nachfragen zählen nicht als Aktivität (Inaktivitätsablauf).
 */
export function RunLiveProvider({ initial, children }: { initial: LiveState[]; children: React.ReactNode }) {
  const router = useRouter();
  const [states, setStates] = useState<Record<string, LiveState>>(() => Object.fromEntries(initial.map((s) => [s.id, s])));
  const startStatus = useRef(Object.fromEntries(initial.map((s) => [s.id, s.status])));
  const active = Object.values(states).filter((s) => isActive(s.status));
  const ids = active.map((s) => s.id).join(",");
  const anyRunning = active.some((s) => s.status === "running");

  // Takt: nach jeder Antwort (oder jedem übersprungenen Takt) den nächsten planen
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!ids) return;
    let stopped = false;
    const timer = setTimeout(
      async () => {
        try {
          if (document.visibilityState !== "visible") return;
          const res = await fetch(`/api/stundenplan/solver/status?ids=${encodeURIComponent(ids)}`, { headers: passiveHeaders(), credentials: "same-origin", cache: "no-store" });
          if (!res.ok || stopped) return;
          const { runs } = (await res.json()) as { runs: LiveState[] };
          setStates((prev) => ({ ...prev, ...Object.fromEntries(runs.map((r) => [r.id, r])) }));
          if (runs.some((r) => r.status !== startStatus.current[r.id])) {
            for (const r of runs) startStatus.current[r.id] = r.status;
            passiveRefresh(router);
          }
        } catch {
          // Netz weg – beim nächsten Takt wieder
        } finally {
          if (!stopped) setTick((t) => t + 1);
        }
      },
      anyRunning ? 3000 : 6000,
    );
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [ids, anyRunning, router, tick]);

  return <LiveContext.Provider value={states}>{children}</LiveContext.Provider>;
}

/** Status-Plakette eines Laufs, mit Fortschritt, solange er rechnet. */
export function LiveStatusBadge({ id, status }: { id: string; status: RunStatusKey }) {
  const live = useContext(LiveContext)[id];
  const s = live?.status ?? status;
  return (
    <Badge tone={RUN_STATUS[s].tone}>
      {RUN_STATUS[s].label}
      {s === "running" && ` ${live?.progress ?? 0} %`}
      {live?.cancelRequested && isActive(s) ? " · Abbruch angefordert" : ""}
    </Badge>
  );
}

/** Fortschrittsanzeige eines wartenden/rechnenden Laufs (Detailseite). */
export function LiveProgress({ id }: { id: string }) {
  const live = useContext(LiveContext)[id];
  if (!live) return null;
  const beat = live.heartbeatAt ? clock.format(new Date(live.heartbeatAt)) : null;
  return (
    <div className="flex flex-col gap-2">
      <Progress value={live.status === "queued" ? 0 : live.progress} label="Fortschritt" />
      <p className="text-sm text-muted" aria-live="polite">
        {live.status === "queued"
          ? "Wartet: Ein anderer Lauf rechnet gerade; dieser startet danach automatisch."
          : live.status === "running"
            ? `${live.progress} %${live.note ? ` – ${live.note}` : ""}${beat ? ` (letzte Rückmeldung ${beat})` : ""}`
            : `Status: ${RUN_STATUS[live.status].label} – die Seite lädt das Ergebnis.`}
        {live.cancelRequested && isActive(live.status) ? " Abbruch angefordert …" : ""}
      </p>
    </div>
  );
}
