import Link from "next/link";
import type { CurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import type { WidgetDef } from "@/core/widgets";
import { Badge } from "@schulos/ui/badge";
import { Card } from "@schulos/ui/card";
import { canOwnBooks, openTermGrades, ownBookLinks } from "./links";
import { currentTerm, TWO_FACTOR_SETUP_HREF, twoFactorReady } from "./service";

const MAX = 6;

/**
 * „Meine Notenbücher“ (P5-16): nur die eigenen Bücher des laufenden Halbjahres mit der Zahl der Lernenden ohne festgelegte
 * Halbjahresnote – keine Noten, keine Namen, keine Statistik über Lehrkräfte. Ohne eingerichtete Zwei-Faktor-Anmeldung nur der
 * Hinweis darauf (F5-07). Links ohne Vorabruf (`no-store`, Q-5A-8).
 */
async function MeineNotenbuecher({ current }: { current: CurrentUser }) {
  const { perms } = current;
  if (!canOwnBooks(perms)) return null;
  const db = await getDb();
  const ready = await twoFactorReady(db, perms);
  const term = ready ? await currentTerm(db, toBerlinDate(new Date())) : null;
  const books = ready ? (await ownBookLinks(db, perms, { currentOnly: true })).filter((b) => !term || b.term === term.term) : [];
  if (ready && books.length === 0) return null;
  const open = await openTermGrades(db, books);
  return (
    <Card aria-label="Meine Notenbücher">
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Meine Notenbücher</h2>
        <Link href="/notenbuch" prefetch={false} className="text-sm font-medium text-accent-ink hover:underline">
          Notenbuch
        </Link>
      </header>
      {!ready ? (
        <p className="text-sm text-muted">
          Für das Notenbuch ist die Zwei-Faktor-Anmeldung Pflicht.{" "}
          <Link href={TWO_FACTOR_SETUP_HREF} prefetch={false} className="font-medium text-accent-ink hover:underline">
            Jetzt einrichten
          </Link>
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {books.slice(0, MAX).map((b) => {
            const n = open.get(b.id) ?? 0;
            return (
              <li key={b.id}>
                <Link
                  href={`/notenbuch/${b.id}`}
                  prefetch={false}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-2 py-2 hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {b.groupName} – {b.subjectName}
                  </span>
                  {b.locked ? (
                    <Badge>abgeschlossen</Badge>
                  ) : n > 0 ? (
                    <span className="text-xs text-muted">{n === 1 ? "1 Halbjahresnote offen" : `${n} Halbjahresnoten offen`}</span>
                  ) : (
                    <Badge tone="success">alle festgelegt</Badge>
                  )}
                </Link>
              </li>
            );
          })}
          {books.length > MAX && <li className="px-2 text-xs text-muted">und {books.length - MAX} weitere</li>}
        </ul>
      )}
    </Card>
  );
}

// Nur Lehrkräfte; das ausdrückliche `notenbuch.own` prüft die Komponente (Admin-`*` zählt nicht, `widgetsFor` kennt das nicht).
export const notenbuchWidgets: WidgetDef[] = [{ id: "notenbuch.meine", moduleId: "notenbuch", order: 47, roles: ["lehrkraft"], Component: MeineNotenbuecher }];
