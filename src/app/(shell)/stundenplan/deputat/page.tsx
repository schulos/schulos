import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { REDUCTION_LABELS, reductionKind } from "@/modules/stundenplan/deputate";
import { myDeputy, type OwnSubstitutions } from "@/modules/stundenplan/mein-deputat";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Mein Deputat" };

const num = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });
const fmt = (ymd: string) => dateFmt.format(fromBerlinLocal(ymd));

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-border py-2 first:border-t-0">
      <dt className="text-muted">{label}</dt>
      <dd className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>{value}</dd>
    </div>
  );
}

function Counts({ title, c }: { title: string; c: OwnSubstitutions }) {
  return (
    <Card aria-label={title}>
      <CardHeader title={title} />
      <dl>
        <Row label="vertreten (Mehrarbeit)" value={String(c.covered)} strong />
        {c.coveredOwnSubject > 0 && <Row label="davon mit eigenem Fach" value={String(c.coveredOwnSubject)} />}
        <Row label="eigene Stunden vertreten worden" value={String(c.given)} />
        <Row label="eigene Stunden entfallen" value={String(c.cancelled)} />
      </dl>
    </Card>
  );
}

/** Q5-09 (I-20): eigenes Deputat und eigene Vertretungsstunden – nur die angemeldete Lehrkraft, nur lesen. */
export default async function MeinDeputatPage() {
  const { user } = await requireUser();
  if (user.role !== "lehrkraft") notFound();
  const today = toBerlinDate(new Date());
  const data = await myDeputy(await getDb(), user.id, today);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Stundenplan" title="Mein Deputat" />
      <p className="text-sm text-muted">Nur deine eigenen Zahlen – andere sehen sie hier nicht. Fragen und Korrekturen klärst du mit der Stundenplanung.</p>
      {!data ? (
        <EmptyState title="Noch kein Schuljahr angelegt" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Card aria-label="Deputat">
            <CardHeader title={`Deputat ${data.year.name}`} />
            {!data.account ? (
              <p className="text-sm text-muted">Für dich ist im Schuljahr nichts verplant.</p>
            ) : (
              <dl>
                <Row label={data.account.isDefault ? "Pflichtstunden (Vorgabe der Schulform)" : "Pflichtstunden"} value={num.format(data.account.obligation)} />
                {data.account.reductions.map((r) => (
                  <Row key={r.id} label={`${reductionKind(r.reason)}: ${REDUCTION_LABELS[r.reason]}${r.note ? ` (${r.note})` : ""}`} value={`− ${num.format(r.hours)}`} />
                ))}
                <Row label="Soll" value={num.format(data.account.target)} strong />
                <Row label="Lehraufträge" value={num.format(data.account.assigned)} />
                <Row label="davon im Stundenplan" value={num.format(data.account.planned)} />
                <Row
                  label="Saldo"
                  value={data.account.balance === 0 ? "ausgeglichen" : `${data.account.balance > 0 ? "+" : "−"}${num.format(Math.abs(data.account.balance))} ${data.account.balance > 0 ? "über" : "unter"} Soll`}
                  strong
                />
              </dl>
            )}
          </Card>
          <div className="flex flex-col gap-4">
            <Counts title={`Vertretungen im Schuljahr (seit ${fmt(data.year.startsOn)})`} c={data.inYear} />
            <Counts title={`Vertretungen in diesem Monat (seit ${fmt(data.monthFrom)})`} c={data.inMonth} />
          </div>
        </div>
      )}
    </main>
  );
}
