import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission, type PermissionSet } from "@/core/permissions";
import { addDays, toBerlinDate } from "@/core/time";
import { createVerfahrenAction } from "@/modules/kurswahl/actions";
import { KIND_LABEL, MANAGE, STATE_LABEL, canViewKurswahl, listVerfahren, verfahrenState } from "@/modules/kurswahl/service";
import { formOptions, progress } from "@/modules/kurswahl/uebersicht";
import { Badge } from "@schulos/ui/badge";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { FamilyOverview } from "./familie";
import { VerfahrenForm } from "./forms";

export const metadata: Metadata = { title: "Kurswahl" };

export default async function KurswahlPage() {
  const { perms } = await requireUser();
  // SP-05: `kurswahl.view` (Stundenplanung) sieht die Liste lesend, ohne „Wahlverfahren anlegen“
  const staffView = canViewKurswahl(perms);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Unterricht" title={staffView ? "Kurswahlen" : "Kurswahl"} />
      {staffView ? <ManageList perms={perms} manage={hasPermission(perms, MANAGE)} /> : <FamilyOverview perms={perms} />}
    </main>
  );
}

async function ManageList({ perms, manage }: { perms: PermissionSet; manage: boolean }) {
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const [list, opts] = await Promise.all([listVerfahren(db, perms), formOptions(db)]);
  const stats = await Promise.all(list.map((v) => progress(db, v)));
  const firstGrade = opts.grades.find((g) => g.value === "7")?.value ?? opts.grades[0]?.value ?? "";
  return (
    <>
      {!manage && (
        <p role="note" className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
          Nur lesen: Verfahren, Angebote und Zahlen. Wahlen einzelner Schüler:innen und Änderungen bleiben bei der Kurswahl-Verwaltung.
        </p>
      )}
      {manage && (
      <Card aria-labelledby="neu">
        <h2 id="neu" className="text-base font-semibold">
          Wahlverfahren anlegen
        </h2>
        <VerfahrenForm
          action={createVerfahrenAction}
          submitLabel="Wahlverfahren anlegen"
          kinds={opts.kinds}
          grades={opts.grades}
          years={opts.years}
          defaults={{
            title: "Wahlpflicht I",
            kind: "wp1",
            note: "",
            gradeLevel: firstGrade,
            classIds: [],
            courseGrade: firstGrade,
            schoolYearId: "",
            opensOn: today,
            closesOn: addDays(today, 14),
            choices: "3",
            minCourses: "1",
            maxCourses: "1",
            chooser: "eltern",
            parentConfirm: false,
          }}
        />
      </Card>
      )}
      <section aria-labelledby="liste" className="flex flex-col gap-3">
        <h2 id="liste" className="font-display text-xl font-bold">
          Wahlverfahren
        </h2>
        {list.length === 0 ? (
          <EmptyState title="Noch kein Wahlverfahren" />
        ) : (
          <ul className="rounded-card border border-border bg-surface px-4">
            {list.map((v, i) => {
              const state = verfahrenState(v, today);
              const s = stats[i]!;
              return (
                <li key={v.id} className="flex flex-wrap items-center gap-3 border-t border-border py-3 first:border-t-0">
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <Link href={`/kurswahl/${v.id}`} className="font-medium hover:underline">
                      {v.title}
                    </Link>
                    <span className="text-sm text-muted">
                      {KIND_LABEL[v.kind]} · {opts.gradeName.get(v.gradeLevel) ?? `Jahrgang ${v.gradeLevel}`} · {s.submitted} von {s.target} gewählt
                    </span>
                  </span>
                  <Badge tone={state === "offen" ? "success" : state === "uebernommen" ? "neutral" : "soft"}>{STATE_LABEL[state]}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
