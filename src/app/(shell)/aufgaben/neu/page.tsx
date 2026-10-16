import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { addDays, toBerlinDate } from "@/core/time";
import { createTaskAction } from "@/modules/aufgaben/actions";
import { assignableGroups, canCreate } from "@/modules/aufgaben/service";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { NewTaskForm } from "../task-forms";

export const metadata: Metadata = { title: "Aufgabe stellen" };

export default async function NeueAufgabePage() {
  const { perms } = await requireUser();
  if (!canCreate(perms)) notFound();
  const groups = await assignableGroups(await getDb(), perms);
  const inAWeek = addDays(toBerlinDate(new Date()), 7);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Aufgaben" title="Aufgabe stellen" />
      <Card>
        {groups.length === 0 ? (
          <EmptyState title="Du bist in keiner Klasse, keinem Kurs und keiner AG" />
        ) : (
          <NewTaskForm action={createTaskAction} groups={groups} defaults={{ startsAt: "", dueAt: `${inAWeek}T08:00` }} />
        )}
      </Card>
    </main>
  );
}
