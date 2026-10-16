import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/core/db/client";
import { readSchoolSettings } from "@/core/settings";
import { TZ } from "@/core/time";
import { anmeldungKatalog } from "@/modules/anmeldung/katalog";
import { CONFIRM_HOURS, formStamp, publicSlots, publicVerfahren } from "@/modules/anmeldung/public";
import { freeSlotsAction, submitAntragAction } from "@/modules/anmeldung/public-actions";
import { toSlotOptions } from "@/modules/anmeldung/slot-options";
import { Card, CardHeader } from "@schulos/ui/card";
import { PrivacyNotice } from "@/modules/anmeldung/privacy-notice";
import { AnmeldeForm } from "@/modules/anmeldung/anmelde-form";

export const metadata: Metadata = { title: "Anmeldung" };
export const dynamic = "force-dynamic";

const dateTime = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeStyle: "short", timeZone: TZ });

/** Öffentliches Anmeldeformular (P4-34) – nur, solange das Verfahren veröffentlicht ist und der Zeitraum läuft. */
export default async function AnmeldungFormPage({ params }: { params: Promise<{ verfahren: string }> }) {
  const { verfahren } = await params;
  const db = await getDb();
  const now = new Date();
  const v = await publicVerfahren(db, decodeURIComponent(verfahren), now);
  if (!v) notFound();
  const [slots, school] = await Promise.all([publicSlots(db, v.id, now), readSchoolSettings(db)]);
  const katalog = anmeldungKatalog(school.profile.state);
  return (
    <main className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">{v.name}</h1>
        <p className="mt-1 text-sm text-muted">Anmeldung bis {dateTime.format(v.closesAt)} Uhr</p>
      </div>
      {v.intro && (
        <Card aria-label="Hinweise der Schule">
          <p className="whitespace-pre-line">{v.intro}</p>
        </Card>
      )}
      <Card aria-label="Unterlagen">
        <CardHeader title="Zum Gespräch mitbringen" />
        <ul className="list-disc pl-5 text-sm">
          {katalog.checklist.map((c) => (
            <li key={c.key}>{c.label}</li>
          ))}
        </ul>
      </Card>
      <Card>
        <AnmeldeForm
          action={submitAntragAction.bind(null, v.id)}
          refreshSlots={freeSlotsAction.bind(null, v.id)}
          kind={v.kind}
          fields={v.fields}
          slots={toSlotOptions(slots)}
          stamp={formStamp(v.id, now)}
          privacy={<PrivacyNotice />}
          done={
            <div className="flex flex-col gap-2">
              <h2 className="font-display text-xl font-bold">Fast geschafft – bitte E-Mail bestätigen</h2>
              <p>
                Wir haben Ihnen eine E-Mail mit einem Bestätigungslink geschickt. Erst mit der Bestätigung ist Ihre Anmeldung eingegangen und der Termin
                fest. Der Link gilt {CONFIRM_HOURS} Stunden – danach löschen wir die Angaben.
              </p>
              <p className="text-sm text-muted">Keine E-Mail bekommen? Bitte schauen Sie auch im Spam-Ordner nach.</p>
            </div>
          }
        />
      </Card>
    </main>
  );
}
