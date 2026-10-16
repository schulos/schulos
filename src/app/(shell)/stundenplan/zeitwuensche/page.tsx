import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { PrefGrid } from "@/app/(shell)/verwaltung/unterricht/zeitwuensche/pref-grid";
import { saveOwnPrefsAction } from "@/modules/stundenplan/actions";
import { WEEKDAYS } from "@/modules/stundenplan/manage";
import { timetableMasterData } from "@/modules/stundenplan/service";
import { prefsWithSource } from "@/modules/stundenplan/zeitwuensche";
import { formatDay, openWindow, readPrefWindow, submissions, windowState } from "@/modules/stundenplan/zeitwunsch-fenster";
import { Badge } from "@schulos/ui/badge";
import { PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Meine Zeitwünsche" };

/** Q5-10 (I-47): eigene Zeitwünsche – im offenen Eingabefenster bearbeiten, sonst nur lesen. Nur die angemeldete Lehrkraft. */
export default async function MeineZeitwuenschePage() {
  const { user } = await requireUser();
  if (user.role !== "lehrkraft") notFound();
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const [open, window, master, grid, done] = await Promise.all([openWindow(db, today), readPrefWindow(db), timetableMasterData(db), prefsWithSource(db, "teacher", user.id), submissions(db)]);
  const initial = Object.fromEntries([...grid].map(([k, x]) => [k, x.value === null ? "x" : String(x.value)]));
  // GATE-4f C-07: Vorgaben der Planung (z. B. Sperren) sieht die Lehrkraft, ändert sie aber nicht
  const locked = [...grid].filter(([, x]) => x.source === "planung").map(([k]) => k);
  const state = windowState(window, today);
  const submittedAt = done.get(user.id);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Stundenplan" title="Meine Zeitwünsche" />
      <p className="-mt-3 text-sm text-muted">
        −3 = sehr ungünstig … +3 = sehr erwünscht, „gesperrt“ = dann geht es gar nicht (bitte sparsam). Nur die Stundenplanung sieht deine Wünsche;
        sie kann sie anpassen, wenn der Plan sonst nicht aufgeht.
        {locked.length > 0 && " Gestrichelte Felder hat die Stundenplanung festgelegt – sie bleiben, wenn du speicherst."}
      </p>
      <p aria-label="Eingabefenster" className="flex flex-wrap items-center gap-2 text-sm">
        {open ? (
          <>
            <Badge tone="success">Eingabe offen</Badge>
            <span>bis einschließlich {formatDay(open.closesOn)}</span>
          </>
        ) : state === "planned" && window ? (
          <>
            <Badge tone="soft">Eingabe ab {formatDay(window.opensOn)}</Badge>
            <span className="text-muted">bis dahin nur lesen</span>
          </>
        ) : (
          <>
            <Badge>Eingabe geschlossen</Badge>
            <span className="text-muted">Die Stundenplanung öffnet das Eingabefenster, wenn der nächste Plan entsteht.</span>
          </>
        )}
        {submittedAt && <Badge tone="soft">abgegeben</Badge>}
      </p>
      <PrefGrid
        action={saveOwnPrefsAction}
        weekdays={[...WEEKDAYS]}
        periods={master.periods.map((p) => ({ nr: p.nr, label: `${p.nr}. (${p.startsAt})` }))}
        initial={initial}
        title={user.name}
        readOnly={!open}
        locked={locked}
      />
    </main>
  );
}
