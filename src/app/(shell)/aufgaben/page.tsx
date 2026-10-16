import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { canCreate, listForStudent, listForTeacher } from "@/modules/aufgaben/service";
import { dueText, StatusBadge } from "@/modules/aufgaben/ui";
import { Button } from "@schulos/ui/button";
import { EmptyState, PageHeader, Progress } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Aufgaben" };

export default async function AufgabenPage() {
  const { perms } = await requireUser();
  const db = await getDb();

  if (canCreate(perms)) {
    const list = await listForTeacher(db, perms);
    return (
      <main className="flex max-w-4xl flex-col gap-6">
        <PageHeader
          title="Aufgaben"
          actions={
            <Button asChild variant="primary">
              <Link href="/aufgaben/neu">
                <Plus aria-hidden /> Aufgabe stellen
              </Link>
            </Button>
          }
        />
        {list.length === 0 ? (
          <EmptyState title="Noch keine Aufgaben gestellt" />
        ) : (
          <ul className="flex flex-col gap-3">
            {list.map((t) => {
              const toCorrect = t.submitted - t.returned;
              return (
                <li key={t.id}>
                  <Link href={`/aufgaben/${t.id}`} className="flex flex-col gap-2 rounded-card border border-border bg-surface p-5 hover:border-border-strong">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-semibold">{t.title}</span>
                      <span className="text-sm text-muted">{t.groups.join(", ")}</span>
                    </div>
                    <Progress value={t.students ? (t.submitted / t.students) * 100 : 0} label={`${t.submitted} von ${t.students} abgegeben`} />
                    <span className="text-sm text-muted">
                      {t.submitted} von {t.students} abgegeben
                      {toCorrect > 0 && ` · ${toCorrect} ohne Feedback`} · Frist {dueText(t.dueAt)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    );
  }

  const list = await listForStudent(db, perms);
  const open = list.filter((t) => t.status === "offen" || t.status === "fehlt");
  const done = list.filter((t) => !open.includes(t)).reverse();
  const Row = ({ t }: { t: (typeof list)[number] }) => (
    <li>
      <Link href={`/aufgaben/${t.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface px-5 py-4 hover:border-border-strong">
        <span className="flex min-w-0 flex-col">
          <span className="font-semibold">{t.title}</span>
          <span className="text-sm text-muted">
            {t.authorName} · {dueText(t.dueAt)}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {t.grade && <span className="text-sm font-semibold">{t.grade}</span>}
          <StatusBadge status={t.status} />
        </span>
      </Link>
    </li>
  );
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="Aufgaben" />
      <section aria-labelledby="offen" className="flex flex-col gap-3">
        <h2 id="offen" className="text-sm font-semibold tracking-wide text-muted uppercase">
          Zu erledigen ({open.length})
        </h2>
        {open.length === 0 ? <EmptyState title="Alles erledigt" /> : <ul className="flex flex-col gap-2">{open.map((t) => <Row key={t.id} t={t} />)}</ul>}
      </section>
      {done.length > 0 && (
        <section aria-labelledby="erledigt" className="flex flex-col gap-3">
          <h2 id="erledigt" className="text-sm font-semibold tracking-wide text-muted uppercase">
            Erledigt ({done.length})
          </h2>
          <ul className="flex flex-col gap-2">{done.map((t) => <Row key={t.id} t={t} />)}</ul>
        </section>
      )}
    </main>
  );
}
