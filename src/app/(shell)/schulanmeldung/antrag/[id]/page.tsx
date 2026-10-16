import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { readSchoolSettings } from "@/core/settings";
import { anmeldungKatalog } from "@/modules/anmeldung/katalog";
import { myAntrag } from "@/modules/anmeldung/konto";
import { changeSlotAccountAction, withdrawAccountAction } from "@/modules/anmeldung/konto-actions";
import { publicSlots } from "@/modules/anmeldung/public";
import { toSlotOptions } from "@/modules/anmeldung/slot-options";
import { VorgangActions } from "@/modules/anmeldung/vorgang-actions";
import { Card } from "@schulos/ui/card";
import { VorgangDetails } from "@/modules/anmeldung/vorgang-details";
import { PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Meine Anmeldung" };
export const dynamic = "force-dynamic";

/** Eigener Antrag (Elternkonto, P4-34b) – fremde Anträge → 404. */
export default async function MeinAntragPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ neu?: string }> }) {
  const { perms } = await requireUser();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const db = await getDb();
  const v = await myAntrag(db, perms, decodeURIComponent(id));
  if (!v) notFound();
  const school = await readSchoolSettings(db);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <PageHeader eyebrow="Schulanmeldung" title={v.verfahren} />
      <Link href="/schulanmeldung" className="w-fit text-sm text-muted hover:underline">
        ← Alle Anmeldungen
      </Link>
      {sp.neu && (
        <p role="status" className="rounded-lg border border-border bg-surface-2 px-3 py-2">
          Vielen Dank – Ihre Anmeldung ist eingegangen.
        </p>
      )}
      <VorgangDetails v={v} icsHref={null} documents={anmeldungKatalog(school.profile.state).checklist}>
        {v.open && (
          <Card>
            <VorgangActions
              change={changeSlotAccountAction.bind(null, v.antragId)}
              withdraw={withdrawAccountAction.bind(null, v.antragId)}
              slots={toSlotOptions((await publicSlots(db, v.verfahrenId)).filter((s) => s.id !== v.slot?.id))}
            />
          </Card>
        )}
      </VorgangDetails>
    </main>
  );
}
