import type { Metadata } from "next";
import { getDb } from "@/core/db/client";
import { publicIp } from "@/core/public-action";
import { readSchoolSettings } from "@/core/settings";
import { anmeldungKatalog } from "@/modules/anmeldung/katalog";
import { loadVorgang, publicSlots } from "@/modules/anmeldung/public";
import { changeSlotAction, withdrawAction } from "@/modules/anmeldung/public-actions";
import { toSlotOptions } from "@/modules/anmeldung/slot-options";
import { VorgangActions } from "@/modules/anmeldung/vorgang-actions";
import { VorgangDetails } from "@/modules/anmeldung/vorgang-details";
import { Card } from "@schulos/ui/card";

export const metadata: Metadata = { title: "Ihre Anmeldung" };
export const dynamic = "force-dynamic";

/**
 * Vorgangsseite für Eltern (P4-34/P4-35) über den geheimen Bearbeitungslink: Stand, Termin, Unterlagen – keine Namen,
 * keine Anschrift (wer den Link abgreift, erfährt nichts über die Familie).
 */
export default async function VorgangPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ bestaetigt?: string }> }) {
  const [{ token }, sp] = await Promise.all([params, searchParams]);
  const t = decodeURIComponent(token);
  const db = await getDb();
  const r = await loadVorgang(db, t, { ip: await publicIp(), now: new Date() });
  if (r.state !== "ok")
    return (
      <main className="flex flex-col gap-6">
        <h1 className="font-display text-3xl font-bold tracking-tight">Ihre Anmeldung</h1>
        <Card>
          <p role="alert">
            {r.state === "limited"
              ? "Zu viele Versuche in kurzer Zeit. Bitte später noch einmal versuchen."
              : "Der Link ist ungültig oder abgelaufen. Bei Fragen wenden Sie sich bitte an das Sekretariat."}
          </p>
        </Card>
      </main>
    );
  const v = r.value;
  const school = await readSchoolSettings(db);
  return (
    <main className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">Ihre Anmeldung</h1>
        <p className="mt-1 text-muted">{v.verfahren}</p>
      </div>
      {sp.bestaetigt && (
        <p role="status" className="rounded-lg border border-border bg-surface-2 px-3 py-2">
          Vielen Dank – Ihre Anmeldung ist bestätigt. Sie bekommen gleich eine E-Mail mit diesem Link. Bitte heben Sie die E-Mail auf.
        </p>
      )}
      <VorgangDetails v={v} icsHref={`/anmeldung/vorgang/${t}/termin.ics`} documents={anmeldungKatalog(school.profile.state).checklist}>
        {v.open && (
          <Card>
            <VorgangActions
              change={changeSlotAction.bind(null, t)}
              withdraw={withdrawAction.bind(null, t)}
              slots={toSlotOptions((await publicSlots(db, v.verfahrenId)).filter((s) => s.id !== v.slot?.id))}
            />
          </Card>
        )}
      </VorgangDetails>
    </main>
  );
}
