import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { readSchoolSettings } from "@/core/settings";
import { AnmeldeForm } from "@/modules/anmeldung/anmelde-form";
import { anmeldungKatalog } from "@/modules/anmeldung/katalog";
import { accountPrefill, canApplyWithAccount } from "@/modules/anmeldung/konto";
import { submitAccountAntragAction } from "@/modules/anmeldung/konto-actions";
import { PrivacyNotice } from "@/modules/anmeldung/privacy-notice";
import { publicSlots, publicVerfahren } from "@/modules/anmeldung/public";
import { freeSlotsAction } from "@/modules/anmeldung/public-actions";
import { toSlotOptions } from "@/modules/anmeldung/slot-options";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Kind anmelden" };
export const dynamic = "force-dynamic";

/** Anmeldeformular für Eltern mit Konto (P4-34b): dasselbe Formular, vorbelegt, ohne Mailbestätigung. */
export default async function KontoAnmeldungPage({ params }: { params: Promise<{ verfahren: string }> }) {
  const { perms } = await requireUser();
  if (!canApplyWithAccount(perms)) notFound();
  const { verfahren } = await params;
  const db = await getDb();
  const now = new Date();
  const v = await publicVerfahren(db, decodeURIComponent(verfahren), now);
  if (!v) notFound();
  const [slots, school, prefill] = await Promise.all([publicSlots(db, v.id, now), readSchoolSettings(db), accountPrefill(db, perms)]);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Schulanmeldung" title={v.name} />
      {v.intro && (
        <Card aria-label="Hinweise der Schule">
          <p className="text-sm whitespace-pre-line">{v.intro}</p>
        </Card>
      )}
      <Card aria-label="Unterlagen">
        <CardHeader title="Zum Gespräch mitbringen" />
        <ul className="list-disc pl-5 text-sm">
          {anmeldungKatalog(school.profile.state).checklist.map((c) => (
            <li key={c.key}>{c.label}</li>
          ))}
        </ul>
      </Card>
      <Card>
        <AnmeldeForm
          action={submitAccountAntragAction.bind(null, v.id)}
          refreshSlots={freeSlotsAction.bind(null, v.id)}
          kind={v.kind}
          fields={v.fields}
          slots={toSlotOptions(slots)}
          prefill={prefill}
          privacy={<PrivacyNotice />}
          done={<p>Ihre Anmeldung ist eingegangen.</p>}
        />
      </Card>
    </main>
  );
}
