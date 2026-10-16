import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Paperclip } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ, fromBerlinLocal } from "@/core/time";
import { confirmLetterAction, remindLetterAction } from "@/modules/elternbriefe/actions";
import { letterFor, markRead, remindAllowed } from "@/modules/elternbriefe/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Markdown } from "@schulos/ui/markdown";
import { PageHeader, Progress } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { ConfirmForm } from "./confirm-form";

export const metadata: Metadata = { title: "Elternbrief" };

const dateFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: TZ });

function answerLabel(r: { answerYes: boolean | null; answerText: string | null }): string {
  if (r.answerYes === true) return "Ja";
  if (r.answerYes === false) return "Nein";
  return r.answerText ?? "";
}

export default async function ElternbriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, perms } = await requireUser();
  const db = await getDb();
  // Eltern bzw. eigenständige Schüler:innen (Q5-05) – markRead tut für alle anderen nichts
  if (user.role === "eltern" || user.role === "schueler") await markRead(db, perms, id);
  const view = await letterFor(db, perms, id);
  if (!view) notFound();
  const { letter, receipts } = view;
  const confirmed = receipts.filter((r) => r.confirmedAt).length;
  const meta = [`an ${view.groupNames.join(", ")}`, dateFmt.format(letter.createdAt), letter.dueDate && `Rückmeldung bis ${dateFmt.format(fromBerlinLocal(letter.dueDate))}`]
    .filter(Boolean)
    .join(" · ");

  const letterCard = (
    <Card>
      <p className="text-sm text-muted">{meta}</p>
      <Markdown>{letter.body}</Markdown>
      {letter.question && (
        <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm">
          <span className="font-semibold">Rückfrage:</span> {letter.question}
        </p>
      )}
      {letter.attachmentKey && (
        <a href={`/api/elternbriefe/${letter.id}`} className="flex w-fit items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium hover:bg-surface-2">
          <Paperclip aria-hidden className="size-4" /> {letter.attachmentName}
        </a>
      )}
    </Card>
  );

  if (view.mode === "parent") {
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Elternbrief" title={letter.title} />
        {letterCard}
        {receipts.map((r) => (
          <Card key={r.studentId} aria-label={`Rückmeldung ${r.studentName}`}>
            <h2 className="text-base font-semibold">{r.studentId === user.id ? "Deine Rückmeldung" : `Rückmeldung für ${r.studentName}`}</h2>
            {r.confirmedAt ? (
              <p className="text-success">
                Bestätigt am {dateTimeFmt.format(r.confirmedAt)}
                {r.confirmedByName && ` von ${r.confirmedByName}`}
                {answerLabel(r) && ` · Antwort: ${answerLabel(r)}`}
              </p>
            ) : !r.canConfirm ? (
              <p className="text-sm text-muted">Noch offen – {r.studentName} ist eigenständig und bestätigt selbst.</p>
            ) : (
              <ConfirmForm action={confirmLetterAction.bind(null, letter.id, r.studentId)} childName={r.studentName} responseType={letter.responseType} question={letter.question} />
            )}
          </Card>
        ))}
      </main>
    );
  }

  const open = receipts.length - confirmed;
  const canRemind = open > 0 && remindAllowed(letter);
  const yes = receipts.filter((r) => r.answerYes === true).length;
  const no = receipts.filter((r) => r.answerYes === false).length;
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Elternbrief" title={letter.title} />
      <Card aria-label="Rückmeldungen">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-lg font-semibold">
            {confirmed} von {receipts.length} bestätigt
            {letter.responseType === "yesno" && (
              <span className="font-normal text-muted">
                {" "}
                · {yes}× Ja, {no}× Nein
              </span>
            )}
          </p>
          {open > 0 && (
            <form action={remindLetterAction.bind(null, letter.id)}>
              <Button type="submit" disabled={!canRemind}>
                {open === 1 ? "1 Familie erinnern" : `${open} Familien erinnern`}
              </Button>
            </form>
          )}
        </div>
        <Progress value={(confirmed / Math.max(1, receipts.length)) * 100} label={`${confirmed} von ${receipts.length} bestätigt`} />
        {letter.lastRemindedAt && <p className="text-sm text-muted">Zuletzt erinnert: {dateTimeFmt.format(letter.lastRemindedAt)}</p>}
      </Card>
      {letterCard}
      <Table>
        <thead>
          <tr>
            <th>Schüler:in</th>
            <th>Eltern</th>
            <th>Status</th>
            {letter.responseType !== "none" && <th>Antwort</th>}
          </tr>
        </thead>
        <tbody>
          {receipts.map((r) => (
            <tr key={r.studentId}>
              <td className="font-medium whitespace-nowrap">
                {r.studentName}
                {view.groupNames.length > 1 && r.groupName && <span className="font-normal text-muted"> · {r.groupName}</span>}
              </td>
              <td className="text-muted">{r.parents.join(", ")}</td>
              <td>{r.confirmedAt ? <Badge tone="success">bestätigt</Badge> : r.readAt ? <Badge>gelesen</Badge> : <Badge tone="warn">offen</Badge>}</td>
              {letter.responseType !== "none" && <td>{answerLabel(r)}</td>}
            </tr>
          ))}
        </tbody>
      </Table>
    </main>
  );
}
