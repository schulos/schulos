import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { targetableGroups } from "@/core/school/audience";
import { updatePageAction } from "@/modules/hilfe/actions";
import { canEditAll, canEditPage, contactCandidates, getPage, listSections } from "@/modules/hilfe/service";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { PageForm } from "../../page-form";

export const metadata: Metadata = { title: "Seite bearbeiten" };

export default async function HilfeBearbeitenPage({ params }: { params: Promise<{ slug: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  const page = await getPage(db, perms, decodeURIComponent((await params).slug));
  if (!page || !canEditPage(perms, page)) notFound();
  const full = canEditAll(perms);
  const [sections, contacts, groups] = full ? await Promise.all([listSections(db), contactCandidates(db), targetableGroups(db, perms)]) : [[], [], []];
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Handbuch" title="Seite bearbeiten" />
      <Card>
        <PageForm
          action={updatePageAction.bind(null, page.id)}
          full={full}
          sections={sections}
          contacts={contacts}
          groups={groups}
          submitLabel="Speichern"
          initial={{
            sectionId: page.sectionId,
            title: page.title,
            body: page.body,
            status: page.status,
            contactId: page.contactId ?? "",
            targetRoles: page.targetRoles,
            targetGroupIds: page.targetGroupIds,
          }}
        />
      </Card>
    </main>
  );
}
