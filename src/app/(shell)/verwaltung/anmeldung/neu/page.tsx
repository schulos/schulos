import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { firstGrade } from "@/core/school/catalog";
import { readSchoolSettings } from "@/core/settings";
import { addDays, toBerlinDate } from "@/core/time";
import { createVerfahrenAction } from "@/modules/anmeldung/actions";
import { anmeldungKatalog } from "@/modules/anmeldung/katalog";
import { defaultFields } from "@/modules/anmeldung/labels";
import { canManage, REJECT_KEEP_DEFAULT } from "@/modules/anmeldung/service";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { VerfahrenForm } from "../forms";
import { formOptions } from "../shared";

export const metadata: Metadata = { title: "Neues Anmeldeverfahren" };
export const dynamic = "force-dynamic";

export default async function NeuesVerfahrenPage() {
  const { perms } = await requireUser();
  if (!canManage(perms)) notFound();
  const db = await getDb();
  const [{ years, grades }, school] = await Promise.all([formOptions(db), readSchoolSettings(db)]);
  const katalog = anmeldungKatalog(school.profile.state);
  const first = firstGrade(school.profile.state);
  // Vorschlag: nächstes Schuljahr (neuestes angelegtes), Übergangsjahrgang des Landes, Zeitraum ab morgen für 4 Wochen
  const year = years[0];
  const from = addDays(toBerlinDate(new Date()), 1);
  const intro = [
    "Bitte melden Sie Ihr Kind hier vor und wählen Sie einen Termin für das Anmeldegespräch.",
    "Verbindlich wird die Anmeldung im Gespräch. Bitte bringen Sie mit:",
    ...katalog.checklist.map((c) => `– ${c.label}`),
  ].join("\n");
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Schulanmeldung" title="Neues Verfahren" />
      <Card className="max-w-4xl">
        <VerfahrenForm
          action={createVerfahrenAction}
          submitLabel="Anlegen und Termine planen"
          years={years}
          grades={grades}
          initial={{
            name: year ? `Anmeldung Klasse ${first} – Schuljahr ${year.name}` : "",
            kind: "klasse5",
            targetSchoolYearId: year?.id ?? "",
            targetGradeLevel: String(grades.find((g) => g.level === first)?.level ?? grades[0]?.level ?? ""),
            opensAt: `${from}T08:00`,
            closesAt: `${addDays(from, 28)}T18:00`,
            capacity: "",
            intro,
            rejectKeepDays: String(REJECT_KEEP_DEFAULT),
            fields: defaultFields("klasse5"),
          }}
        />
      </Card>
    </main>
  );
}
