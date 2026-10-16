import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { addDays, toBerlinDate, toBerlinLocal } from "@/core/time";
import { createSurveyAction } from "@/modules/umfragen/actions";
import { canCreate, targetableGroups } from "@/modules/umfragen/service";
import { PageHeader } from "@schulos/ui/misc";
import { SurveyForm } from "../survey-form";

export const metadata: Metadata = { title: "Umfrage anlegen" };

export default async function NeueUmfragePage() {
  const { perms } = await requireUser();
  if (!canCreate(perms)) notFound();
  const groups = await targetableGroups(await getDb(), perms);
  const now = new Date();
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Umfragen" title="Umfrage anlegen" />
      <SurveyForm
        action={createSurveyAction}
        groups={groups}
        submitLabel="Umfrage anlegen"
        showNotify
        questionsLocked={false}
        initial={{
          title: "",
          description: "",
          anonymous: true,
          opensAt: toBerlinLocal(now),
          closesAt: `${addDays(toBerlinDate(now), 7)}T18:00`,
          roles: [],
          groups: [],
          questions: [{ kind: "single", text: "", options: ["", ""], required: true }],
        }}
      />
    </main>
  );
}
