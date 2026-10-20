import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { resolveIssueFindingAction, scanIssueAction } from "@/modules/buecherei/actions";
import { issueFindings, issueGroup, issueGroups, issuePerson, issueSummary } from "@/modules/buecherei/ausgabe";
import { COPY_CONDITIONS } from "@/modules/buecherei/labels";
import { canMaterials, lernmittelEnabled } from "@/modules/buecherei/lernmittel";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { BuechereiNav } from "../ui";
import { IssueScanForm } from "./issue-scan-form";

export const metadata: Metadata = { title: "Schulbuchausgabe" };

type Search = { gruppe?: string; person?: string };

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const day = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));

const href = (groupId: string | null, personId?: string) => `/buecherei/ausgabe?${new URLSearchParams({ ...(groupId ? { gruppe: groupId } : {}), ...(personId ? { person: personId } : {}) })}`;

/**
 * Schulbuchausgabe (BU-11, Recht `buecherei.materials`, nur mit Schulbuchausleihe): Klasse oder Kurs wählen, Person wählen
 * (Liste oder Ausweis), Schulbücher scannen; Rücknahme nur scannen, mit Zustand bzw. Befund. Die Zuordnung gilt nur im
 * laufenden Schuljahr; Rücknahme ohne Befund löscht sie.
 */
export default async function AusgabePage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  if (!canMaterials(perms) || !(await lernmittelEnabled(db))) notFound();
  const sp = await searchParams;
  const today = toBerlinDate(new Date());
  const [sum, groupList, group, person, findings] = await Promise.all([
    issueSummary(db, perms, today),
    sp.gruppe ? null : issueGroups(db, perms),
    sp.gruppe ? issueGroup(db, perms, sp.gruppe, today) : null,
    sp.person ? issuePerson(db, perms, sp.person, today) : null,
    issueFindings(db, perms),
  ]);
  if (sp.gruppe && !group) notFound();
  const groupId = group?.group.id ?? null;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Bücherei · Schulbuchausleihe" title={group ? `Schulbuchausgabe ${group.group.name}` : "Schulbuchausgabe"} />
      <BuechereiNav current="ausgabe" perms={perms} />
      <p className="text-sm text-muted">
        {sum.year ? `Schuljahr ${sum.year}` : "Kein laufendes Schuljahr – Ausgabe erst nach dem Anlegen unter Verwaltung → Stammdaten"} · {sum.issued} Schulbücher ausgegeben
        {sum.overdue > 0 && ` · ${sum.overdue} nicht zurückgegeben (Frist abgelaufen)`}
        {sum.findings > 0 && ` · ${sum.findings} offene Befunde`}
      </p>

      <Card aria-labelledby="scannen">
        <CardHeader title={<span id="scannen">{person ? `Ausgabe an ${person.name}` : "Rücknahme"}</span>} />
        {person ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">{person.name}</span>
            {person.className && <Badge tone="soft">{person.className}</Badge>}
            {!person.active && <Badge tone="warn">Konto gesperrt – nur Rücknahme</Badge>}
            <Link href={href(groupId)} className="ml-auto font-medium text-accent-ink hover:underline">
              Person abwählen
            </Link>
          </div>
        ) : (
          <p className="text-sm text-muted">Ausgegebene Schulbücher einfach scannen – das nimmt sie zurück. Für die Ausgabe zuerst den Ausweis scannen oder unten die Person wählen.</p>
        )}
        <IssueScanForm
          key={person?.id ?? "-"}
          action={scanIssueAction.bind(null, person?.id ?? null, groupId)}
          conditions={COPY_CONDITIONS}
          hint={
            person
              ? "Schulbuch: nicht ausgegeben → an diese Person, ausgegeben → Rücknahme · Ausweis: andere Person wählen"
              : "Ausweis → Person wählen · Schulbuch (z. B. L-000001-8) → Rücknahme – Zustand und Befund gelten für den nächsten Scan"
          }
        />
        {person && (
          <>
            <h2 className="mt-2 text-base font-semibold">Schulbücher von {person.name}</h2>
            {person.books.length === 0 ? (
              <p className="text-sm text-muted">Keine Schulbücher ausgegeben.</p>
            ) : (
              <ul aria-label={`Schulbücher von ${person.name}`} className="flex flex-col gap-1 text-sm">
                {person.books.map((b) => (
                  <li key={b.issueId} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{b.title}</span>
                    <span className="font-mono text-xs text-muted">{b.inventoryNumber}</span>
                    {b.previousYear && <Badge tone="warn">aus dem Vorjahr</Badge>}
                    {b.overdue && <Badge tone="danger">{b.dunningLevel > 0 ? `${b.dunningLevel}. Mahnung` : "Frist abgelaufen"}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      {group ? (
        <Card aria-labelledby="klasse">
          <CardHeader title={<span id="klasse">{group.group.name}</span>} action={{ href: "/buecherei/ausgabe", label: "andere Klasse oder Kurs" }} />
          {group.materials.length > 0 ? (
            <p className="text-sm text-muted">Ausleihe für diesen Jahrgang: {group.materials.map((m) => (m.course ? `${m.title} (${m.course})` : m.title)).join(" · ")}</p>
          ) : (
            <p className="text-sm text-muted">Für diesen Jahrgang sind keine Lernmittel zur Ausleihe angelegt.</p>
          )}
          {group.students.length === 0 ? (
            <EmptyState title="Keine Schüler:innen in dieser Gruppe" />
          ) : (
            <Table>
              <caption className="sr-only">Schulbücher je Schüler:in in {group.group.name}</caption>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>ausgegeben</th>
                  <th>fehlt noch</th>
                </tr>
              </thead>
              <tbody>
                {group.students.map((s) => (
                  <tr key={s.id} aria-current={s.id === person?.id ? "true" : undefined} className={s.id === person?.id ? "bg-accent-soft" : undefined}>
                    <td className="font-medium">
                      <Link href={href(groupId, s.id)} className="hover:underline">
                        {s.name}
                      </Link>
                    </td>
                    <td className="text-sm">
                      {s.books.length === 0
                        ? "–"
                        : s.books.map((b) => (
                            <span key={b.issueId} className="block">
                              {b.title} <span className="font-mono text-xs text-muted">{b.inventoryNumber}</span>
                              {b.previousYear && (
                                <Badge tone="warn" className="ml-1">
                                  Vorjahr
                                </Badge>
                              )}
                            </span>
                          ))}
                    </td>
                    <td className="text-sm text-muted">{s.missing.length === 0 ? (group.materials.length ? "vollständig" : "–") : s.missing.map((m) => m.title).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      ) : (
        <Card aria-labelledby="gruppen">
          <CardHeader title={<span id="gruppen">Klasse oder Kurs wählen</span>} />
          {!groupList?.length ? (
            <EmptyState title="Keine Klassen mit Schüler:innen" />
          ) : (
            <ul aria-label="Klassen und Kurse" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {groupList.map((g) => (
                <li key={g.id}>
                  <Link href={href(g.id)} className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 hover:border-accent">
                    <span className="font-medium">{g.name}</span>
                    <span className="text-xs text-muted">
                      {g.students} Schüler:innen · {g.books} Bücher
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card aria-labelledby="befunde">
        <CardHeader title={<span id="befunde">Offene Befunde (Schulbücher)</span>} />
        {findings.length === 0 ? (
          <EmptyState title="Keine offenen Befunde" />
        ) : (
          <Table>
            <caption className="sr-only">Rücknahmen mit Befund</caption>
            <thead>
              <tr>
                <th>Zurück am</th>
                <th>Schulbuch</th>
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
                    {f.title} <span className="font-mono text-xs text-muted">{f.inventoryNumber}</span>
                  </td>
                  <td>{f.finding}</td>
                  <td>{f.name ? `${f.name}${f.className ? ` (${f.className})` : ""}` : "Konto gelöscht"}</td>
                  <td className="text-right">
                    <form action={resolveIssueFindingAction.bind(null, f.id)}>
                      <Button type="submit" size="sm" variant="ghost" aria-label={`Befund ${f.inventoryNumber} erledigt`}>
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
    </main>
  );
}
