"use client";

import { Check, Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@schulos/ui/button";

/** Zeigt Zugangsdaten EINMALIG an – das Passwort wird nirgends gespeichert. */
export function Credentials({ title, username, password }: { title: string; username: string; password: string }) {
  const [copied, setCopied] = useState(false);
  const text = username ? `Benutzername: ${username}\nPasswort: ${password}` : `Passwort: ${password}`;
  return (
    <div role="status" className="flex flex-col gap-3 rounded-card border border-accent/40 bg-accent-soft p-5">
      <p className="flex items-center gap-2 font-semibold text-accent-ink">
        <KeyRound className="size-5" aria-hidden /> {title}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[15px]">
        {username && (
          <>
            <dt className="text-muted">Benutzername</dt>
            <dd data-testid="cred-username">{username}</dd>
          </>
        )}
        <dt className="text-muted">Passwort</dt>
        <dd data-testid="cred-password">{password}</dd>
      </dl>
      <p className="text-sm text-muted">Das Passwort wird nur jetzt angezeigt. Bitte weitergeben oder ausdrucken.</p>
      <Button
        size="sm"
        className="self-start"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => setCopied(true));
        }}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? "Kopiert" : "Kopieren"}
      </Button>
    </div>
  );
}
