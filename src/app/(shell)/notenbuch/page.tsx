import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { SCALE_LABELS, SCALES } from "@/modules/notenbuch/berechnung";
import { notenbuchPageLocked } from "@/modules/notenbuch/guard";
import { NOTICE_POINTS, NOTICE_TITLE } from "@/modules/notenbuch/hinweis";
import {
  bookOptions,
  booksForTransfer,
  currentTerm,
  handoverClasses,
  lockedBooks,
  myBooks,
  notenbuchAccess,
  orphanedBooks,
  transferTargets,
} from "@/modules/notenbuch/service";
import { Badge } from "@schulos/ui/badge";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { NotenbuchLocked } from "./gesperrt";
import { ExportForm, NewBookForm, TransferForm, UnlockForm } from "./forms";
import { NotenbuchNoticeDetails } from "./hinweis";
import { FamilyGrades } from "./noten";

export const metadata: Metadata = { title: "Notenbuch" };
export const dynamic = "force-dynamic";

/**
 * Notenbuch (P5-11…P5-13): eigene Notenbücher (→ Notentabelle) und „Neues Notenbuch“ aus eigenen Lehraufträgen; Übergabelisten
 * (Klassenleitung, `term_view`), Export (`export`) und Entsperren (`unlock`). Rechte und 2FA prüft das Layout.
 */
export default async function NotenbuchPage() {
  const { perms } = await requireUser();
  const db = await getDb();
  const access = await notenbuchAccess(db, perms);
  // P5-14: Schüler:innen und Eltern (das Layout hat die Einstellung schon geprüft)
  if (!access.any) return <FamilyGrades perms={perms} />;
  const gate = await notenbuchPageLocked(db, perms.userId);
  if (gate) return <NotenbuchLocked reason={gate} />;
  const today = toBerlinDate(new Date());
  const [books, options, term, classes, exportClasses, locked, transferable, orphans, targets] = await Promise.all([
    myBooks(db, perms),
    bookOptions(db, perms, today),
    currentTerm(db, today),
    handoverClasses(db, perms, "view"),
    handoverClasses(db, perms, "export"),
    access.unlock ? lockedBooks(db, perms) : Promise.resolve([]),
    access.transfer ? booksForTransfer(db, perms) : Promise.resolve([]),
    access.transfer ? orphanedBooks(db) : Promise.resolve([]),
    access.transfer ? transferTargets(db, perms) : Promise.resolve([]),
  ]);
  const orphanIds = new Set(orphans.map((o) => o.id));
  const transferList = [...transferable].sort((a, b) => Number(orphanIds.has(b.id)) - Number(orphanIds.has(a.id)));

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Unterricht" title="Notenbuch" />
      <p className="max-w-3xl text-sm text-muted">
        Teilnoten und Kommentare siehst nur du und die anderen Lehrkräfte des Notenbuchs – nicht die Klassenleitung, die Schulleitung, die
        Verwaltung oder Admin-Konten. Klassen- und Schulleitung sehen nur Halbjahreswerte, und jeder Abruf wird protokolliert. Amtliche
        Zeugnisnoten stehen weiter in der Schulverwaltungssoftware.
      </p>
      <NotenbuchNoticeDetails title={NOTICE_TITLE} points={NOTICE_POINTS} />
      {access.own && options.length > 0 && term && (
        <Card aria-labelledby="neu">
          <h2 id="neu" className="text-base font-semibold">
            Neues Notenbuch
          </h2>
          <NewBookForm
            options={options.map((o) => ({ value: `${o.groupId}|${o.subjectId}`, label: `${o.groupName} – ${o.subjectName}` }))}
            scales={SCALES.map((s) => ({ value: s, label: SCALE_LABELS[s] }))}
            defaultTerm={term.term}
          />
        </Card>
      )}
      <section aria-labelledby="liste" className="flex flex-col gap-3">
        <h2 id="liste" className="font-display text-xl font-bold">
          Meine Notenbücher
        </h2>
        {books.length === 0 ? (
          <EmptyState title="Noch kein Notenbuch">Notenbücher gibt es für Lerngruppen, in denen du laut Unterrichtsverteilung oder Stundenplan unterrichtest.</EmptyState>
        ) : (
          <ul className="rounded-card border border-border bg-surface px-4">
            {books.map((b) => (
              <li key={b.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border py-3 first:border-t-0">
                <Link href={`/notenbuch/${b.id}`} prefetch={false} className="font-medium text-accent-ink hover:underline">
                  {b.groupName} – {b.subjectName}
                </Link>
                <span className="text-sm text-muted">
                  {b.schoolYearName} · {b.term}. Halbjahr · {SCALE_LABELS[b.scale]}
                </span>
                {b.locked && <Badge>abgeschlossen</Badge>}
                {b.pastYear && <Badge tone="soft">Vorjahr – nur lesbar</Badge>}
              </li>
            ))}
          </ul>
        )}
      </section>
      {classes.length > 0 && (
        <section aria-labelledby="uebergabe" className="flex flex-col gap-3">
          <h2 id="uebergabe" className="font-display text-xl font-bold">
            Übergabelisten (Halbjahreswerte)
          </h2>
          <p className="max-w-3xl text-sm text-muted">
            Festgelegte Halbjahresnoten und Vorschläge aller Fächer je Klasse – ohne Teilnoten. Entwurf; amtlich ist die Schulverwaltungssoftware.
            Jeder Abruf wird protokolliert.
          </p>
          <ul className="flex flex-wrap gap-2">
            {classes.map((c) => (
              <li key={c.id}>
                <Link href={`/notenbuch/klasse/${encodeURIComponent(c.id)}`} prefetch={false} className="inline-flex rounded-xl border border-border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2">
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {exportClasses.length > 0 && term && (
        <Card aria-labelledby="export">
          <h2 id="export" className="text-base font-semibold">
            Export für die Schulverwaltungssoftware
          </h2>
          <ExportForm classes={exportClasses} schoolYearId={term.schoolYearId} defaultTerm={term.term} />
        </Card>
      )}
      {access.transfer && (
        <section aria-labelledby="uebertragen" className="flex flex-col gap-3">
          <h2 id="uebertragen" className="font-display text-xl font-bold">
            Notenbücher übertragen
          </h2>
          <p className="max-w-3xl text-sm text-muted">
            Bei Abgang, längerer Vertretung oder Ausfall einer Lehrkraft: Notenbücher gehören der Schule und bleiben erhalten. Übertragen trägt eine
            Lehrkraft ein (auf Wunsch eine andere aus) – ohne dass du Noten siehst; jede Übertragung wird protokolliert.
            {orphans.length > 0 && ` ${orphans.length} ${orphans.length === 1 ? "Notenbuch hat" : "Notenbücher haben"} keine aktive Lehrkraft mehr.`}
          </p>
          {transferList.length === 0 ? (
            <p className="text-sm text-muted">Es gibt noch keine Notenbücher.</p>
          ) : (
            <ul className="rounded-card border border-border bg-surface px-4">
              {transferList.map((b) => (
                <li key={b.id} className="flex flex-col gap-2 border-t border-border py-3 first:border-t-0">
                  <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">
                      {b.groupName} – {b.subjectName}
                    </span>
                    <span className="text-sm text-muted">
                      {b.schoolYearName} · {b.term}. Halbjahr · {b.teachers.length ? b.teachers.map((t) => t.name).join(", ") : "keine Lehrkraft"}
                    </span>
                    {orphanIds.has(b.id) && <Badge tone="warn">ohne aktive Lehrkraft</Badge>}
                  </span>
                  <TransferForm bookId={b.id} label={`${b.groupName} – ${b.subjectName} (${b.term}. Halbjahr)`} teachers={b.teachers} targets={targets} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {access.unlock && (
        <section aria-labelledby="entsperren" className="flex flex-col gap-3">
          <h2 id="entsperren" className="font-display text-xl font-bold">
            Abgeschlossene Notenbücher
          </h2>
          {locked.length === 0 ? (
            <p className="text-sm text-muted">Kein Notenbuch ist abgeschlossen.</p>
          ) : (
            <ul className="rounded-card border border-border bg-surface px-4">
              {locked.map((b) => (
                <li key={b.id} className="flex flex-col gap-2 border-t border-border py-3 first:border-t-0">
                  <span>
                    <span className="font-medium">
                      {b.groupName} – {b.subjectName}
                    </span>{" "}
                    <span className="text-sm text-muted">
                      {b.schoolYearName} · {b.term}. Halbjahr · {b.teachers.map((t) => t.name).join(", ")}
                    </span>
                  </span>
                  <UnlockForm bookId={b.id} label={`${b.groupName} – ${b.subjectName}`} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
