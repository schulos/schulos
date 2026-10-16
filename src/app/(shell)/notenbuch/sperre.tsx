"use client";

import { useEffect, useRef, useState } from "react";
import { lockNotenbuchAction, notenbuchKeepAliveAction } from "@/modules/notenbuch/actions";

const PING_MS = 60_000;
const CHECK_MS = 10_000;
const EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart", "focusin"] as const;

/**
 * Inaktivitätsablauf im Browser (P5-12, Q-5A-7): nach `minutes` ohne Tastatur-/Mauseingabe blendet die Seite das Notenbuch aus,
 * meldet die Sperre dem Server und lädt neu (der Server zeigt dann nur noch die Sperre – entsperren nur per neuer Anmeldung).
 * Bei Eingaben schickt sie höchstens einmal pro Minute ein Lebenszeichen, damit langes Tippen ohne Speichern nicht sperrt.
 * Die eigentliche Durchsetzung liegt auf dem Server (sitzung.ts).
 */
export function IdleGuard({ minutes, children }: { minutes: number; children: React.ReactNode }) {
  const [locked, setLocked] = useState(false);
  const lastInput = useRef(0);
  const lastPing = useRef(0);
  const done = useRef(false);

  useEffect(() => {
    lastInput.current = Date.now();
    lastPing.current = Date.now();
    const lockNow = (report: boolean) => {
      if (done.current) return;
      done.current = true;
      setLocked(true);
      (report ? lockNotenbuchAction() : Promise.resolve()).catch(() => undefined).finally(() => window.location.reload());
    };
    const check = () => {
      if (Date.now() - lastInput.current > minutes * 60_000) lockNow(true);
    };
    const onInput = () => {
      check();
      if (done.current) return;
      const now = Date.now();
      lastInput.current = now;
      if (now - lastPing.current < PING_MS) return;
      lastPing.current = now;
      notenbuchKeepAliveAction()
        .then((r) => r.locked && lockNow(false))
        .catch(() => undefined);
    };
    const onVisible = () => document.visibilityState === "visible" && check();
    for (const e of EVENTS) window.addEventListener(e, onInput, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(check, CHECK_MS);
    return () => {
      for (const e of EVENTS) window.removeEventListener(e, onInput, { capture: true });
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [minutes]);

  if (locked)
    return (
      <p role="status" className="rounded-card border border-border bg-surface p-5 text-sm text-muted">
        Das Notenbuch wird gesperrt …
      </p>
    );
  return children;
}
