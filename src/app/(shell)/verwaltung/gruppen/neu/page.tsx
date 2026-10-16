import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { subjects } from "@/core/db/schema";
import { hasPermission } from "@/core/permissions";
import { createGroupAction } from "@/modules/verwaltung/group-actions";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { groupFormOptions } from "@/modules/verwaltung/stammdaten";
import { GroupForm } from "../group-form";

export const metadata: Metadata = { title: "Gruppe anlegen" };

export default async function NeueGruppePage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.groups")) notFound();
  const db = await getDb();
  const subjectList = await db.select({ id: subjects.id, name: subjects.name }).from(subjects).orderBy(subjects.sortOrder);
  const { grades: gradeList, levels: levelList, rooms: roomList } = await groupFormOptions(db);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Gruppen" title="Gruppe anlegen" />
      <Card>
        <GroupForm action={createGroupAction} subjects={subjectList} grades={gradeList} levels={levelList} rooms={roomList} submitLabel="Anlegen" />
      </Card>
    </main>
  );
}
