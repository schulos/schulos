import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { readModuleSetting } from "@/core/modules/settings";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { isSelfResponsible, selfResponsibleIds } from "@/core/school/majority";
import { toBerlinDate } from "@/core/time";
import { requestLeaveAction, withdrawLeaveAction } from "@/modules/abwesenheiten/actions";
import { leavesFor } from "@/modules/abwesenheiten/beurlaubung";
import { rangeLabel } from "@/modules/abwesenheiten/labels";
import { parentView } from "@/modules/abwesenheiten/service";
import { LEAVE_CLASS_LEAD_DAYS } from "@/modules/abwesenheiten/settings";
import { planDays } from "@/modules/stundenplan/vertretung";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { LEAVE_REASONS, LeaveList, leaveHint } from "../leave-ui";
import { AbsencePrivacyNote } from "../privacy-note";
import { ReportForm } from "../report-form";

export const metadata: Metadata = { title: "Beurlaubung" };

/**
 * Beurlaubung vorab beantragen (Q5-16, F-08): Eltern für minderjährige Kinder, volljährige Schüler:innen für sich selbst.
 * Entschieden wird in /abwesenheiten (Klassenleitung bzw. Schulleitung).
 */
export default async function BeurlaubungPage() {
  const { user } = await requireUser();
  const db = await getDb();
  let students: { id: string; name: string }[] = [];
  if (user.role === "eltern") {
    const { kids } = await parentView(db, user.id);
    const adults = await selfResponsibleIds(db, kids.map((k) => k.id));
    students = kids.filter((k) => !adults.has(k.id));
  } else if (user.role === "schueler" && (await isSelfResponsible(db, user.id))) {
    students = [{ id: user.id, name: user.name }];
  }
  if (students.length === 0) notFound();

  const todayYmd = toBerlinDate(new Date());
  const today = planDays(todayYmd, await loadSchoolCalendar(db))[0]!;
  const limit = Number(await readModuleSetting(db, LEAVE_CLASS_LEAD_DAYS)) || 0;
  const leaves = await leavesFor(db, students.map((s) => s.id));
  const self = user.role === "schueler";

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Abwesenheiten" title="Beurlaubung vorab" />
      <Card aria-labelledby="antrag">
        <h2 id="antrag" className="text-base font-semibold">
          {self ? "Beurlaubung beantragen" : students.length === 1 ? `Beurlaubung für ${students[0]!.name} beantragen` : "Beurlaubung beantragen"}
        </h2>
        <ReportForm
          action={requestLeaveAction}
          students={students.map((s) => ({ id: s.id, label: s.name }))}
          today={today < todayYmd ? todayYmd : today}
          minDate={todayYmd}
          reasons={LEAVE_REASONS}
          hint={leaveHint(limit)}
          submitLabel="Beurlaubung beantragen"
          successText={self ? "Beantragt – du bekommst eine Nachricht, sobald entschieden ist." : "Beantragt – Sie bekommen eine Nachricht, sobald entschieden ist."}
        />
        <AbsencePrivacyNote kind="beurlaubung" self={self} />
      </Card>
      <section aria-labelledby="antraege" className="flex flex-col gap-3">
        <h2 id="antraege" className="font-display text-xl font-bold">
          Anträge
        </h2>
        <LeaveList
          rows={leaves}
          showClass={false}
          empty="Noch keine Anträge."
          actions={(r) =>
            r.status === "beantragt" && r.requestedBy === user.id ? (
              <>
                <Badge tone="warn">beantragt</Badge>
                <form action={withdrawLeaveAction.bind(null, r.id)}>
                  <Button type="submit" size="sm" aria-label={`Antrag zurückziehen: ${r.studentName} ${rangeLabel(r.fromDate, r.toDate)}`}>
                    Zurückziehen
                  </Button>
                </form>
              </>
            ) : undefined
          }
        />
      </section>
      <p className="text-sm text-muted">
        <Link href="/abwesenheiten" className="underline-offset-4 hover:underline">
          Zurück zu den Abwesenheiten
        </Link>
      </p>
    </main>
  );
}
