import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ArrowLeft, Paperclip } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { users } from "@/core/db/schema";
import { feedbackAction } from "@/modules/aufgaben/actions";
import { getSubmission, getTask, statusOf } from "@/modules/aufgaben/service";
import { formatBytes, StatusBadge } from "@/modules/aufgaben/ui";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { FeedbackForm } from "../../../task-forms";

export const metadata: Metadata = { title: "Abgabe" };
const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

export default async function AbgabePage({ params }: { params: Promise<{ id: string; studentId: string }> }) {
  const { perms } = await requireUser();
  const { id, studentId } = await params;
  const db = await getDb();
  const t = await getTask(db, perms, decodeURIComponent(id));
  if (!t || t.role !== "manage") notFound();
  const sid = decodeURIComponent(studentId);
  const [sub, [student]] = await Promise.all([getSubmission(db, t.id, sid), db.select({ name: users.name }).from(users).where(eq(users.id, sid))]);
  if (!sub || !student) notFound();

  return (
    <main className="flex max-w-3xl flex-col gap-5">
      <Link href={`/aufgaben/${t.id}`} className="inline-flex items-center gap-1.5 self-start text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> {t.title}
      </Link>
      <PageHeader eyebrow={t.title} title={student.name} actions={<StatusBadge status={statusOf(t.dueAt, sub)} />} />
      <Card className="gap-3">
        <CardHeader title="Abgabe" />
        <span className="text-sm text-muted">Abgegeben am {fmt.format(sub.submittedAt)}</span>
        {sub.text && <p className="whitespace-pre-line">{sub.text}</p>}
        {sub.files.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {sub.files.map((f) => (
              <li key={f.id}>
                <a href={`/api/aufgaben/datei/${f.id}`} download className="inline-flex items-center gap-2 font-medium text-accent-ink hover:underline">
                  <Paperclip className="size-4" aria-hidden /> {f.name} <span className="text-sm font-normal text-muted">{formatBytes(f.size)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {t.submissionType === "confirm" && !sub.text && <p className="text-muted">Als erledigt gemeldet.</p>}
      </Card>
      <Card>
        <CardHeader title={sub.returnedAt ? "Feedback (bereits zurückgegeben – erneut speichern ändert es)" : "Feedback geben"} />
        <FeedbackForm action={feedbackAction.bind(null, t.id, sid)} initial={{ feedback: sub.feedback ?? "", grade: sub.grade ?? "" }} />
      </Card>
    </main>
  );
}
