import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinLocal } from "@/core/time";
import { updateSurveyAction } from "@/modules/umfragen/actions";
import { getSurvey, targetableGroups } from "@/modules/umfragen/service";
import { PageHeader } from "@schulos/ui/misc";
import { SurveyForm } from "../../survey-form";

export const metadata: Metadata = { title: "Umfrage bearbeiten" };

export default async function UmfrageBearbeitenPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  const data = await getSurvey(db, perms, (await params).id);
  if (!data?.canEdit || data.survey.quick) notFound();
  const { survey } = data;
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Umfragen" title="Umfrage bearbeiten" />
      <SurveyForm
        action={updateSurveyAction.bind(null, survey.id)}
        groups={await targetableGroups(db, perms)}
        submitLabel="Speichern"
        showNotify={false}
        questionsLocked={data.responses > 0}
        initial={{
          title: survey.title,
          description: survey.description,
          anonymous: survey.anonymous,
          opensAt: toBerlinLocal(survey.opensAt),
          closesAt: toBerlinLocal(survey.closesAt),
          roles: data.targets.roles,
          groups: data.targets.groups,
          questions: data.questions.map((q) => ({ kind: q.kind, text: q.text, options: q.options, required: q.required })),
        }}
      />
    </main>
  );
}
