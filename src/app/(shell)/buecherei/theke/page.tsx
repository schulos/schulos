import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { renewLoanAction, resolveFindingAction, returnWithFindingAction, scanAction } from "@/modules/buecherei/actions";
import { MAX_FINDING_LENGTH, canDesk, canFindings, deskPerson, deskSummary, listFindings, searchBorrowers } from "@/modules/buecherei/loans";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { SpecForm } from "@/ui/spec-form";
import { BuechereiNav } from "../ui";
import { PersonSearch } from "./person-search";
import { ScanForm } from "./scan-form";

export const metadata: Metadata = { title: "Bücherei-Theke" };

type Search = { q?: string; person?: string };

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const day = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));

/**
 * Theke (BU-02, Recht `buecherei.desk`): Person suchen und wählen, Exemplare scannen (Ausleihe an die Person bzw. Rückgabe),
 * verlängern. Sichtbar sind nur Name, Klasse und offene Ausleihen der gewählten Person. Befunde nur mit `materials`.
 */
export default async function ThekePage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  if (!canDesk(perms)) notFound();
  const db = await getDb();
  const sp = await searchParams;
  const today = toBerlinDate(new Date());
  const q = sp.q?.trim() ?? "";
  const [person, hits, sum, findings] = await Promise.all([
    sp.person ? deskPerson(db, perms, sp.person, today) : null,
    q ? searchBorrowers(db, perms, q) : [],
    deskSummary(db, perms, today),
    canFindings(perms) ? listFindings(db, perms) : null,
  ]);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Bücherei" title="Theke" />
      <BuechereiNav current="theke" perms={perms} />
      <p className="text-sm text-muted">
        {sum.open} Exemplare ausgeliehen{sum.overdue > 0 && ` · ${sum.overdue} überfällig`}
      </p>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card aria-labelledby="ausleihe">
          <CardHeader title={<span id="ausleihe">{person ? `Ausleihe für ${person.name}` : "Rückgabe"}</span>} />
          {person ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">{person.name}</span>
              {person.className && <Badge tone="soft">{person.className}</Badge>}
              {!person.active && <Badge tone="warn">Konto gesperrt – nur Rückgabe</Badge>}
              <Link href="/buecherei/theke" className="ml-auto font-medium text-accent-ink hover:underline">
                Person abwählen
              </Link>
            </div>
          ) : (
            <p className="text-sm text-muted">Ausgeliehene Exemplare einfach scannen – das bucht sie zurück. Für eine Ausleihe zuerst die Person wählen.</p>
          )}
          <ScanForm
            key={person?.id ?? "-"}
            action={scanAction.bind(null, person?.id ?? null)}
            hint={person ? "Nicht ausgeliehen → Ausleihe an diese Person, ausgeliehen → Rückgabe" : "Exemplarnummer, z. B. B-000001-8 – mit Hand-Scanner oder Tastatur und Enter"}
          />

          {person && (
            <>
              <h2 className="mt-2 text-base font-semibold">Offene Ausleihen</h2>
              {person.loans.length === 0 ? (
                <p className="text-sm text-muted">Keine offenen Ausleihen.</p>
              ) : (
                <Table>
                  <caption className="sr-only">Offene Ausleihen von {person.name}</caption>
                  <thead>
                    <tr>
                      <th>Titel</th>
                      <th>Exemplar</th>
                      <th>fällig</th>
                      <th className="sr-only">Verlängern</th>
                    </tr>
                  </thead>
                  <tbody>
                    {person.loans.map((l) => (
                      <tr key={l.id}>
                        <td className="font-medium">{l.title}</td>
                        <td className="font-mono tabular-nums">{l.barcode}</td>
                        <td className="tabular-nums">
                          {day(l.dueOn)}
                          {l.overdue && (
                            <Badge tone="danger" className="ml-2">
                              überfällig
                            </Badge>
                          )}
                          {l.renewals > 0 && <span className="block text-xs text-muted">{l.renewals}-mal verlängert</span>}
                        </td>
                        <td className="text-right">
                          <SpecForm action={renewLoanAction.bind(null, l.id)} label={`${l.barcode} verlängern`} submit="Verlängern" columns={1} variant="secondary" fields={[]} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card aria-labelledby="person">
            <CardHeader title={<span id="person">Person suchen</span>} />
            <PersonSearch q={q} />
            {q &&
              (hits.length === 0 ? (
                <p className="text-sm text-muted">Niemand gefunden.</p>
              ) : (
                <ul aria-label="Suchergebnis" className="flex flex-col divide-y divide-border">
                  {hits.map((h) => (
                    <li key={h.id}>
                      <Link href={`/buecherei/theke?person=${encodeURIComponent(h.id)}`} className="flex min-h-11 items-center justify-between gap-2 py-1 hover:underline">
                        <span className="font-medium">{h.name}</span>
                        {h.className && <span className="text-sm text-muted">{h.className}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              ))}
          </Card>

          <Card aria-labelledby="befund">
            <CardHeader title={<span id="befund">Rückgabe mit Befund</span>} />
            <p className="text-sm text-muted">Beschädigt oder unvollständig? Dann hier zurückbuchen – die Verwaltung klärt den Befund. Nur die Sache beschreiben, keine Namen.</p>
            <SpecForm
              action={returnWithFindingAction}
              label="Rückgabe mit Befund"
              submit="Mit Befund zurückbuchen"
              columns={1}
              variant="secondary"
              fields={[
                { name: "code", label: "Exemplarnummer", type: "text", required: true, maxLength: 40 },
                { name: "finding", label: "Befund", type: "text", required: true, maxLength: MAX_FINDING_LENGTH, placeholder: "z. B. Wasserschaden, CD fehlt" },
              ]}
            />
          </Card>
        </div>
      </div>

      {findings && (
        <Card aria-labelledby="befunde">
          <CardHeader title={<span id="befunde">Offene Befunde</span>} />
          {findings.length === 0 ? (
            <EmptyState title="Keine offenen Befunde" />
          ) : (
            <Table>
              <caption className="sr-only">Rückgaben mit Befund</caption>
              <thead>
                <tr>
                  <th>Zurück am</th>
                  <th>Titel</th>
                  <th>Befund</th>
                  <th>Person</th>
                  <th className="sr-only">Erledigen</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f) => (
                  <tr key={f.id}>
                    <td className="tabular-nums">{f.returnedOn ? day(f.returnedOn) : "–"}</td>
                    <td>
                      {f.title} <span className="font-mono text-xs text-muted">{f.barcode}</span>
                    </td>
                    <td>{f.finding}</td>
                    <td>{f.name ? `${f.name}${f.className ? ` (${f.className})` : ""}` : "Konto gelöscht"}</td>
                    <td className="text-right">
                      <form action={resolveFindingAction.bind(null, f.id)}>
                        <Button type="submit" size="sm" variant="ghost" aria-label={`Befund ${f.barcode} erledigt`}>
                          erledigt
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </main>
  );
}
