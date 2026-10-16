import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { rooms, subjects } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { toBerlinDate } from "@/core/time";
import { getPlan } from "@/modules/sitzplan/service";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { CopyForm, DeletePlanButton, MetaForm } from "../forms";
import { PlanEditor } from "./editor";

export const metadata: Metadata = { title: "Sitzplan" };
export const dynamic = "force-dynamic";

/** Sitzplan bearbeiten (P5-02) – fremde oder unbekannte Pläne 404 (kein Unterschied nach außen). */
export default async function SitzplanEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  const view = await getPlan(db, perms, decodeURIComponent((await params).id), toBerlinDate(new Date()));
  if (!view) notFound();
  const { plan } = view;
  const [subjectRows, roomRows] = await Promise.all([
    db.select({ id: subjects.id, name: subjects.name }).from(subjects).orderBy(subjects.sortOrder, de(subjects.name)),
    db.select({ id: rooms.id, name: rooms.name }).from(rooms).orderBy(rooms.id),
  ]);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow={[view.groupName, view.subjectName, view.roomName].filter(Boolean).join(" · ")}
        title={plan.title}
        actions={
          <>
            <Button asChild size="sm">
              <Link href={`/druck/sitzplan/${plan.id}`}>Drucken</Link>
            </Button>
            <Button asChild size="sm" variant="ghost">
              <Link href="/sitzplan">Alle Sitzpläne</Link>
            </Button>
          </>
        }
      />
      <PlanEditor planId={plan.id} initial={{ rows: plan.rows, cols: plan.cols, desks: plan.desks, seats: view.seats }} students={view.students} />
      <Card aria-labelledby="angaben">
        <h2 id="angaben" className="text-base font-semibold">
          Angaben
        </h2>
        <MetaForm id={plan.id} title={plan.title} subjectId={plan.subjectId ?? ""} roomId={plan.roomId ?? ""} subjects={subjectRows} rooms={roomRows} />
      </Card>
      <Card aria-labelledby="weiteres">
        <h2 id="weiteres" className="text-base font-semibold">
          Kopieren oder löschen
        </h2>
        <CopyForm id={plan.id} title={plan.title} />
        <DeletePlanButton id={plan.id} title={plan.title} />
      </Card>
    </main>
  );
}
