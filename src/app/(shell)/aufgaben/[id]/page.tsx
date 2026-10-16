import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Paperclip } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { submitAction } from "@/modules/aufgaben/actions";
import { getTask, submissionMatrix } from "@/modules/aufgaben/service";
import { dueText, formatBytes, StatusBadge } from "@/modules/aufgaben/ui";
import { Card, CardHeader } from "@schulos/ui/card";
import { Markdown } from "@schulos/ui/markdown";
import { Table } from "@schulos/ui/table";
import { SubmitForm } from "../task-forms";
import { DeleteTask } from "./delete-task";

export const metadata: Metadata = { title: "Aufgabe" };

const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });
const TYPE_LABEL = { file: "Abgabe als Datei", text: "Abgabe als Text", confirm: "Nur bestätigen" };

function Files({ files }: { files: { id: string; name: string; size: number }[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {files.map((f) => (
        <li key={f.id}>
          <a href={`/api/aufgaben/datei/${f.id}`} download className="inline-flex items-center gap-2 font-medium text-accent-ink hover:underline">
            <Paperclip className="size-4" aria-hidden /> {f.name}
            <span className="text-sm font-normal text-muted">{formatBytes(f.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export default async function AufgabePage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const db = await getDb();
  const t = await getTask(db, perms, decodeURIComponent(id));
  if (!t) notFound();
  const matrix = t.role === "manage" ? await submissionMatrix(db, perms, t.id) : null;

  return (
    <main className="flex max-w-4xl flex-col gap-5">
      <Link href="/aufgaben" className="inline-flex items-center gap-1.5 self-start text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Alle Aufgaben
      </Link>
      <Card className="gap-4 p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
          <span>
            {t.authorName} · {t.groups.map((g) => g.name).join(", ")} · {TYPE_LABEL[t.submissionType]}
          </span>
          {t.role === "student" && <StatusBadge status={t.status} />}
        </div>
        <h1 className="font-display text-3xl font-bold tracking-tight">{t.title}</h1>
        <p className="font-medium">Abgabe bis {dueText(t.dueAt)}</p>
        {t.description && <Markdown>{t.description}</Markdown>}
        {t.files.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <h2 className="text-sm font-semibold">Material</h2>
            <Files files={t.files} />
          </div>
        )}
        {t.role === "manage" && (
          <div className="flex justify-end border-t border-border pt-4">
            <DeleteTask id={t.id} />
          </div>
        )}
      </Card>

      {t.role === "student" && (
        <Card className="gap-4">
          <CardHeader title="Meine Abgabe" />
          {t.mine && (
            <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-4">
              <span className="text-sm text-muted">Abgegeben am {fmt.format(t.mine.submittedAt)}</span>
              {t.mine.text && <p className="whitespace-pre-line">{t.mine.text}</p>}
              {t.mine.files.length > 0 && <Files files={t.mine.files} />}
            </div>
          )}
          {t.mine?.returnedAt ? (
            <div className="flex flex-col gap-2 rounded-xl border border-accent/40 bg-accent-soft p-4">
              <span className="flex items-center justify-between gap-2 font-semibold text-accent-ink">
                Feedback
                {t.mine.grade && <span className="rounded-lg bg-surface px-2.5 py-0.5 text-lg">{t.mine.grade}</span>}
              </span>
              {t.mine.feedback && <p className="whitespace-pre-line">{t.mine.feedback}</p>}
            </div>
          ) : (
            <SubmitForm action={submitAction.bind(null, t.id)} type={t.submissionType} resubmit={!!t.mine} />
          )}
        </Card>
      )}

      {matrix && (
        <Card className="gap-4">
          <CardHeader title={`Abgaben (${matrix.rows.filter((r) => r.status !== "offen" && r.status !== "fehlt").length} von ${matrix.rows.length})`} />
          <Table className="border-0">
            <thead>
              <tr>
                <th>Schüler:in</th>
                <th>Status</th>
                <th>Abgegeben</th>
                <th>Bewertung</th>
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((r) => {
                const has = r.status !== "offen" && r.status !== "fehlt";
                return (
                  <tr key={r.student.id}>
                    <td>
                      {has ? (
                        <Link href={`/aufgaben/${t.id}/abgabe/${r.student.id}`} className="font-medium hover:underline">
                          {r.student.lastName}, {r.student.firstName}
                        </Link>
                      ) : (
                        <span>
                          {r.student.lastName}, {r.student.firstName}
                        </span>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="text-muted">{r.submittedAt ? fmt.format(r.submittedAt) : "–"}</td>
                    <td className="font-semibold">{r.grade ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </main>
  );
}
