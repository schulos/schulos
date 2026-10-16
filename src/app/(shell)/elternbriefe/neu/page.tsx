import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { createLetterAction } from "@/modules/elternbriefe/actions";
import { sendableGroups } from "@/modules/elternbriefe/service";
import { PageHeader } from "@schulos/ui/misc";
import { LetterForm } from "./letter-form";

export const metadata: Metadata = { title: "Neuer Elternbrief" };

export default async function NeuerElternbriefPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "elternbriefe.send")) notFound();
  const groups = await sendableGroups(await getDb(), perms);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Elternbriefe" title="Neuer Elternbrief" />
      <LetterForm action={createLetterAction} groups={groups} />
    </main>
  );
}
