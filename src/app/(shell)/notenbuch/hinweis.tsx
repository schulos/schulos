"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { acknowledgeNoticeAction } from "@/modules/notenbuch/actions";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";

/**
 * Datenschutzhinweis beim ersten Öffnen (P5-17): ersetzt jede Notenbuch-Seite, bis die Person ihn bestätigt hat – keine Daten,
 * keine Aktivität im Notenbuch. Nach dem Bestätigen lädt die Seite neu (Layout und Seite laufen dann regulär).
 */
export function NotenbuchNotice({ title, points }: { title: string; points: readonly string[] }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(acknowledgeNoticeAction, {});
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Unterricht" title="Notenbuch" />
      <Card aria-labelledby="nb-hinweis" className="max-w-3xl">
        <h2 id="nb-hinweis" className="text-base font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted">Bevor du das Notenbuch nutzt, lies bitte diese Punkte. Du bestätigst sie einmal je Schuljahr.</p>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
          {points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <form action={formAction} aria-label={title} className="flex flex-col gap-3">
          <label className="flex items-start gap-2 text-sm font-medium">
            <input type="checkbox" name="gelesen" value="1" required className="mt-0.5 size-4 accent-[var(--accent)]" />
            Ich habe den Hinweis gelesen und halte mich daran.
          </label>
          <div>
            <Button type="submit" variant="primary" disabled={pending || state.ok}>
              Bestätigen und weiter
            </Button>
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          )}
        </form>
      </Card>
    </main>
  );
}

/** Der Hinweis zum Nachlesen (auf `/notenbuch`, eingeklappt). */
export function NotenbuchNoticeDetails({ title, points }: { title: string; points: readonly string[] }) {
  return (
    <details className="max-w-3xl rounded-card border border-border bg-surface px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">{title}</summary>
      <ul className="mt-2 flex list-disc flex-col gap-2 pl-5">
        {points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </details>
  );
}
