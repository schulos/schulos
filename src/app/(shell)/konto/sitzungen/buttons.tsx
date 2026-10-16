"use client";

import { LogOut } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@schulos/ui/button";
import { endAllSessionsAction, endSessionAction } from "./actions";

export function EndSessionButton({ id, offline }: { id: string; offline: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() => {
          const warn = offline
            ? " Auf diesem Gerät ist die Offline-Eingabe des Notenbuchs eingeschaltet – noch nicht übertragene Eingaben gehen verloren."
            : "";
          if (confirm(`Dieses Gerät abmelden?${warn}`)) start(async () => setError((await endSessionAction(id)).error ?? null));
        }}
      >
        Abmelden
      </Button>
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

export function EndAllButton({ offline }: { offline: number }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="danger"
      disabled={pending}
      onClick={() => {
        const warn =
          offline > 0
            ? `\n\nAchtung: Auf ${offline === 1 ? "einem Gerät" : `${offline} Geräten`} ist die Offline-Eingabe des Notenbuchs eingeschaltet. Noch nicht übertragene Offline-Eingaben gehen verloren.`
            : "";
        if (confirm(`Auf allen Geräten abmelden – auch auf diesem?${warn}`)) start(() => endAllSessionsAction());
      }}
    >
      <LogOut aria-hidden /> Überall abmelden
    </Button>
  );
}
