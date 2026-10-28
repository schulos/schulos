import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { targetableGroups } from "@/core/school/audience";
import { createPageAction } from "@/modules/hilfe/actions";
import { canEditAll, contactCandidates, listSections, STAFF_TARGET_ROLES } from "@/modules/hilfe/service";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { PageForm } from "../page-form";

export const metadata: Metadata = { title: "Seite anlegen" };

export default async function HilfeNeuPage({ searchParams }: { searchParams: Promise<{ bereich?: string }> }) {
  const { perms } = await requireUser();
  if (!canEditAll(perms)) notFound();
  const db = await getDb();
  const [sections, contacts, groups] = await Promise.all([listSections(db), contactCandidates(db), targetableGroups(db, perms)]);
  const wanted = (await searchParams).bereich;
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Handbuch" title="Seite anlegen" />
      {sections.length === 0 ? (
        <EmptyState title="Noch kein Bereich">
          <p>Seiten liegen in Bereichen. Bitte zuerst einen Bereich anlegen.</p>
          <Button asChild variant="primary" className="mt-3">
            <Link href="/hilfe/bereiche">Bereiche verwalten</Link>
          </Button>
        </EmptyState>
      ) : (
        <Card>
          <PageForm
            action={createPageAction}
            full
            sections={sections}
            contacts={contacts}
            groups={groups}
            submitLabel="Seite anlegen"
            // Projektleitung 2026-10-28: eigene Seiten zunächst nur für Personal
            initial={{
              sectionId: sections.find((s) => s.id === wanted)?.id ?? sections[0]!.id,
              title: "",
              body: "",
              status: "entwurf",
              contactId: "",
              targetRoles: STAFF_TARGET_ROLES,
              targetGroupIds: [],
            }}
          />
        </Card>
      )}
    </main>
  );
}
