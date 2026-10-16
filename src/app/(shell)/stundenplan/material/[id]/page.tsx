import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { eq } from "drizzle-orm";
import { groups, subjects, timetableLessons } from "@/core/db/schema";
import { TZ, fromBerlinLocal } from "@/core/time";
import { materialFor } from "@/modules/stundenplan/selbstmeldung";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Vertretungsmaterial" };

const longDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });

/** Q5-12: Vertretungsmaterial einer Stunde – nur für die Lehrkraft selbst, die Vertretung, die Planung und (mit Häkchen) die Gruppe. */
export default async function MaterialPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  const m = await materialFor(db, perms, (await params).id);
  if (!m) notFound();
  const [l] = await db
    .select({ periodNr: timetableLessons.periodNr, groupName: groups.name, subjectName: subjects.name })
    .from(timetableLessons)
    .innerJoin(groups, eq(groups.id, timetableLessons.groupId))
    .innerJoin(subjects, eq(subjects.id, timetableLessons.subjectId))
    .where(eq(timetableLessons.id, m.lessonId));
  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`Vertretungsmaterial · ${longDay.format(fromBerlinLocal(m.date))}`}
        title={l ? `${l.periodNr}. Std · ${l.subjectName} · ${l.groupName}` : "Vertretungsmaterial"}
      />
      <Card aria-label="Material" className="gap-3">
        <p className="text-sm text-muted">von {m.teacherName}</p>
        {m.text && <p className="whitespace-pre-line">{m.text}</p>}
        {m.fileKey && (
          <div>
            <Button asChild>
              <a href={`/api/stundenplan/material/${m.id}`}>{m.fileName} herunterladen</a>
            </Button>
          </div>
        )}
      </Card>
    </main>
  );
}
