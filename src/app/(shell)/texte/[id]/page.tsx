import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { currentState } from "@/modules/texte/live";
import { docAccess, MODE_LABELS } from "@/modules/texte/service";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { DocSettings, TextEditor } from "./editor";

export const metadata: Metadata = { title: "Text" };

export default async function TextPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  const id = (await params).id;
  const data = await docAccess(db, perms, id);
  if (!data) notFound();
  // Der erste Aufbau bekommt den vollen Stand mit – der Editor zeigt sofort Inhalt und gleicht danach per Sync ab.
  const state = (await currentState(db, id)) ?? "";
  const leader = data.role === "leader";
  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader
        eyebrow={data.groupName}
        title={data.doc.title}
        actions={
          <>
            <a href={`/api/texte/${id}/export.md`} className="text-sm font-medium text-accent-ink hover:underline">
              Als Markdown
            </a>
            <Link href={`/druck/text/${id}`} className="text-sm font-medium text-accent-ink hover:underline">
              Druckansicht
            </Link>
            <Link href="/texte" className="text-sm font-medium text-accent-ink hover:underline">
              Alle Texte
            </Link>
          </>
        }
      />
      <p className="text-sm text-muted">
        {MODE_LABELS[data.doc.mode]}
        {data.archived && " · Gruppe archiviert – nur lesen"}
      </p>
      <TextEditor key={id} docId={id} initialState={state} canWrite={data.canWrite} />
      {leader && (
        <Card aria-labelledby="verwalten">
          <h2 id="verwalten" className="text-base font-semibold">
            Text verwalten
          </h2>
          <DocSettings docId={id} title={data.doc.title} mode={data.doc.mode} />
        </Card>
      )}
    </main>
  );
}
