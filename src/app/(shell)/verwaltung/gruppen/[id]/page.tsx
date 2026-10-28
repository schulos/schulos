import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { subjects } from "@/core/db/schema";
import { GROUP_KIND_LABELS, ROLE_LABELS } from "@/core/labels";
import { hasPermission } from "@/core/permissions";
import { MODULES } from "@/modules";
import { updateGroupAction } from "@/modules/verwaltung/group-actions";
import { availableGroupFeatures, getGroup } from "@/modules/verwaltung/groups";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { groupFormOptions, leaderLabel } from "@/modules/verwaltung/stammdaten";
import { GroupForm } from "../group-form";
import { DeleteGroup, FeatureToggles, MemberManager } from "./group-client";

export const metadata: Metadata = { title: "Gruppe" };

export default async function GruppeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.groups")) notFound();
  const { id } = await params;
  const db = await getDb();
  const data = await getGroup(db, decodeURIComponent(id));
  if (!data) notFound();
  const { group, members, features } = data;
  const subjectList = await db.select({ id: subjects.id, name: subjects.name }).from(subjects).orderBy(subjects.sortOrder);
  const { grades: gradeList, levels: levelList, rooms: roomList } = await groupFormOptions(db);
  const featureList = availableGroupFeatures(MODULES, { kind: group.kind });

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`${GROUP_KIND_LABELS[group.kind]} · ${group.slug}`}
        title={group.name}
        actions={<DeleteGroup id={group.id} name={group.name} />}
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader title={`Mitglieder (${members.length})`} />
          <MemberManager
            groupId={group.id}
            leaderLabel={leaderLabel(group.kind, gradeList.find((g) => g.level === group.gradeLevel)?.stage ?? null)}
            members={members.map((m) => ({
              id: m.id,
              name: `${m.lastName}, ${m.firstName}`,
              detail: m.shortCode ? `${ROLE_LABELS[m.role]} · ${m.shortCode}` : ROLE_LABELS[m.role],
              leader: m.memberRole === "leader",
            }))}
          />
        </Card>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Einstellungen" />
            <GroupForm
              action={updateGroupAction.bind(null, group.id)}
              initial={{ name: group.name, kind: group.kind, description: group.description, gradeLevel: group.gradeLevel, level: group.level, subjectId: group.subjectId, homeRoomId: group.homeRoomId }}
              subjects={subjectList}
              grades={gradeList}
              levels={levelList}
              rooms={roomList}
              submitLabel="Speichern"
            />
          </Card>
          <Card>
            <CardHeader title="Gruppenmerkmale" />
            <FeatureToggles groupId={group.id} features={featureList} enabled={features} />
          </Card>
        </div>
      </div>
    </main>
  );
}
