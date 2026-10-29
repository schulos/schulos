"use client";

import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import Link from "next/link";
import { useState, useSyncExternalStore, useTransition } from "react";
import { passkeyOptionsAction, passkeyVerifyAction } from "./actions";

const noSubscribe = () => () => {};
/** Kann der Browser WebAuthn? (auf dem Server: annehmen, dass ja – kein Flackern) */
function useWebAuthnSupport(): boolean {
  return useSyncExternalStore(noSubscribe, browserSupportsWebAuthn, () => true);
}

/** SEC-03: Anmeldung mit Sicherheitsschlüssel/Passkey als zweiter Faktor (nach dem Passwort). */
export function PasskeySignIn({ next, primary }: { next: string; primary: boolean }) {
  const [error, setError] = useState<{ error: string; expired?: boolean } | null>(null);
  const supported = useWebAuthnSupport();
  const [pending, start] = useTransition();

  function run() {
    setError(null);
    start(async () => {
      const res = await passkeyOptionsAction();
      if ("error" in res) {
        setError(res);
        return;
      }
      let response;
      try {
        response = await startAuthentication({ optionsJSON: res.options });
      } catch (err) {
        setError({
          error:
            err instanceof Error && err.name === "NotAllowedError"
              ? "Abgebrochen oder Zeit abgelaufen. Bitte noch einmal versuchen."
              : "Der Schlüssel hat nicht geantwortet. Bitte noch einmal versuchen.",
        });
        return;
      }
      const done = await passkeyVerifyAction(response, next);
      if (done?.error) setError(done);
    });
  }

  if (!supported) return <p className="text-sm text-muted">Dieser Browser unterstützt keine Sicherheitsschlüssel.</p>;
  return (
    <div className="flex flex-col gap-3" role="group" aria-label="Sicherheitsschlüssel">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className={
          primary
            ? "h-11 rounded-xl bg-accent font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-60"
            : "h-11 rounded-xl border border-border bg-surface font-medium text-ink transition hover:bg-surface-2 disabled:opacity-60"
        }
      >
        {pending ? "Warte auf den Schlüssel …" : "Mit Sicherheitsschlüssel anmelden"}
      </button>
      {error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error.error}
          {error.expired && (
            <>
              {" "}
              <Link href="/login" className="font-medium underline">
                Zur Anmeldung
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}
