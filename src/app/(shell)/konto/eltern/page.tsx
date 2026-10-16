import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ } from "@/core/time";
import { parentsInformedState } from "@/modules/verwaltung/volljaehrig";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { ParentsInformedForm } from "./form";

export const metadata: Metadata = { title: "Eltern informieren" };
export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });

/** Q5-05: Eigenständige (volljährige) Schüler:innen entscheiden selbst, ob ihre Eltern weiter informiert werden; alle anderen: 404. */
export default async function ElternInformierenPage() {
  const { user } = await requireUser();
  if (user.role !== "schueler") notFound();
  const state = await parentsInformedState(await getDb(), user.id);
  if (!state.selfResponsible) notFound();
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Mein Konto" title="Eltern informieren" />
      <Card className="max-w-2xl" aria-labelledby="eltern-info">
        <CardHeader title={state.since ? `Eltern werden informiert (seit ${dateFmt.format(state.since)})` : "Eltern sehen nichts"} />
        <div id="eltern-info" className="flex flex-col gap-3 text-sm">
          <p>
            Du bist in SchulOS als <strong>eigenständig</strong> eingetragen: Elternbriefe und Eltern-Umfragen gehen an dich, Abwesenheiten und
            Beurlaubungen meldest du selbst. Deine verknüpften Eltern sehen deine Daten nicht.
          </p>
          <p className="text-muted">
            Wenn du einwilligst, sehen deine Eltern wieder deinen Stundenplan, Termine, Klausuren, Elternbriefe und deine Fehlzeiten und bekommen
            Hinweise wie „nicht entschuldigt“. Melden, beantragen und bestätigen kannst weiterhin nur du; die Gründe deiner Krankmeldungen sehen sie
            nicht. Du kannst die Einwilligung jederzeit widerrufen.
          </p>
          <ParentsInformedForm on={Boolean(state.since)} />
        </div>
      </Card>
    </main>
  );
}
