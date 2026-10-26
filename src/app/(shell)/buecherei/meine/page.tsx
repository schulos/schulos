import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { cancelReservationAction, renewOwnLoanAction } from "@/modules/buecherei/actions";
import { childrenSchoolbooks, schoolbooksOf, type IssuedBook } from "@/modules/buecherei/ausgabe";
import { childrenCompensations, openCompensationsOf } from "@/modules/buecherei/ersatz";
import { canUse, childrenLibrary, myLibrary, type Library } from "@/modules/buecherei/katalog";
import { formatEuro } from "@/modules/buecherei/labels";
import { currentReturnDay } from "@/modules/buecherei/einstellungen";
import { lernmittelEnabled } from "@/modules/buecherei/lernmittel";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { SpecForm } from "@/ui/spec-form";
import { BuechereiNav } from "../ui";

export const metadata: Metadata = { title: "Meine Ausleihen" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const day = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));

/** Titel – für die eigene Sicht als Link in den Katalog (Eltern haben keinen Katalog). */
function TitleLink({ id, title, link }: { id: string; title: string; link: boolean }) {
  return link ? (
    <Link href={`/buecherei/katalog/${id}`} className="font-medium hover:underline">
      {title}
    </Link>
  ) : (
    <span className="font-medium">{title}</span>
  );
}

/** Offene Ausleihen und Vormerkungen; `own` = eigene (mit Verlängern/Löschen), sonst nur lesend (Eltern). */
function LibraryView({ lib, who, own }: { lib: Library; who: string; own: boolean }) {
  if (!lib.loans.length && !lib.reservations.length) return <p className="text-sm text-muted">Nichts ausgeliehen oder vorgemerkt.</p>;
  return (
    <div className="flex flex-col gap-4">
      {lib.loans.length > 0 && (
        <Table>
          <caption className="sr-only">Ausleihen von {who}</caption>
          <thead>
            <tr>
              <th>Titel</th>
              <th>fällig</th>
              {own && <th className="sr-only">Verlängern</th>}
            </tr>
          </thead>
          <tbody>
            {lib.loans.map((l) => (
              <tr key={l.id}>
                <td>
                  <TitleLink id={l.titleId} title={l.title} link={own} />
                  <span className="block font-mono text-xs text-muted">{l.barcode}</span>
                </td>
                <td className="tabular-nums">
                  {day(l.dueOn)}
                  {l.overdue && (
                    <Badge tone="danger" className="ml-2">
                      {l.dunningLevel > 0 ? `${l.dunningLevel}. Mahnung` : "überfällig"}
                    </Badge>
                  )}
                  {l.renewals > 0 && <span className="block text-xs text-muted">{l.renewals}-mal verlängert</span>}
                </td>
                {own && (
                  <td className="text-right">
                    {l.renewBlock ? (
                      <span className="text-xs text-muted">{l.renewBlock}</span>
                    ) : (
                      <SpecForm action={renewOwnLoanAction.bind(null, l.id)} label={`${l.title} verlängern`} submit="Verlängern" columns={1} variant="secondary" fields={[]} />
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {lib.reservations.length > 0 && (
        <Table>
          <caption className="sr-only">Vormerkungen von {who}</caption>
          <thead>
            <tr>
              <th>Vorgemerkt</th>
              <th>Stand</th>
              {own && <th className="sr-only">Löschen</th>}
            </tr>
          </thead>
          <tbody>
            {lib.reservations.map((r) => (
              <tr key={r.id}>
                <td>
                  <TitleLink id={r.titleId} title={r.title} link={own} />
                  {r.author && <span className="block text-xs text-muted">{r.author}</span>}
                </td>
                <td>
                  {r.readyOn && r.holdUntil ? <Badge tone="success">liegt bereit bis {day(r.holdUntil)}</Badge> : <span className="text-sm">Platz {r.position} in der Reihe</span>}
                </td>
                {own && (
                  <td className="text-right">
                    <SpecForm action={cancelReservationAction.bind(null, r.id)} label={`Vormerkung ${r.title} löschen`} submit="Löschen" columns={1} variant="secondary" fields={[]} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

/** BU-11: Schulbücher des Schuljahres (nur lesend – Rückgabe an der Schulbuchausgabe). */
function SchoolbookList({ books, who }: { books: IssuedBook[]; who: string }) {
  return (
    <Table>
      <caption className="sr-only">Schulbücher von {who}</caption>
      <thead>
        <tr>
          <th>Schulbuch</th>
          <th>zurück bis</th>
        </tr>
      </thead>
      <tbody>
        {books.map((b) => (
          <tr key={b.issueId}>
            <td>
              <span className="font-medium">{b.title}</span>
              <span className="block font-mono text-xs text-muted">{b.inventoryNumber}</span>
            </td>
            <td className="tabular-nums">
              {day(b.dueOn)}
              {b.overdue && (
                <Badge tone="danger" className="ml-2">
                  {b.dunningLevel > 0 ? `${b.dunningLevel}. Mahnung` : "bitte zurückgeben"}
                </Badge>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** BU-12: offene Ersatzforderungen (nur lesend – geklärt wird mit der Schule). */
function CompensationList({ items, who }: { items: Awaited<ReturnType<typeof openCompensationsOf>>; who: string }) {
  return (
    <Table>
      <caption className="sr-only">Ersatzforderungen an {who}</caption>
      <thead>
        <tr>
          <th>Ersatz für</th>
          <th>Grund</th>
          <th className="text-right">Betrag</th>
        </tr>
      </thead>
      <tbody>
        {items.map((c) => (
          <tr key={c.id}>
            <td className="font-medium">{c.item}</td>
            <td>{c.reason}</td>
            <td className="text-right tabular-nums">{formatEuro(c.amountCents)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * „Meine Ausleihen“ (BU-03): eigene offene Ausleihen (selbst verlängern) und Vormerkungen; Eltern sehen die ihrer Kinder nur
 * lesend. Bewusst ohne Verlauf – Zurückgegebenes wird nicht gespeichert.
 */
export default async function MeinePage() {
  const { perms } = await requireUser();
  const own = canUse(perms);
  if (!own && perms.role !== "eltern") notFound();
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const stage2 = await lernmittelEnabled(db);
  const returnDay = stage2 ? await currentReturnDay(db) : null;
  const [mine, kids, myBooks, kidsBooks, myComps, kidsComps] = await Promise.all([
    own ? myLibrary(db, perms, today) : null,
    childrenLibrary(db, perms, today),
    own && stage2 ? schoolbooksOf(db, perms.userId, today) : [],
    childrenSchoolbooks(db, perms, today),
    own ? openCompensationsOf(db, perms.userId) : [],
    childrenCompensations(db, perms),
  ]);
  const booksOfKid = new Map(kidsBooks.map((k) => [k.id, k.books]));

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Bücherei" title={own ? "Meine Ausleihen" : "Ausleihen meiner Kinder"} />
      <BuechereiNav current="meine" perms={perms} />
      <p className="text-sm text-muted">Hier steht nur, was gerade ausgeliehen oder vorgemerkt ist. Zurückgegebene Medien speichert die Bücherei nicht.</p>
      {mine && (
        <Card aria-labelledby="eigene">
          <CardHeader title={<span id="eigene">Ausgeliehen und vorgemerkt</span>} />
          <LibraryView lib={mine} who="mir" own />
          <Link href="/buecherei/katalog" className="text-sm font-medium text-accent-ink hover:underline">
            Im Katalog stöbern
          </Link>
        </Card>
      )}
      {myBooks.length > 0 && (
        <Card aria-labelledby="schulbuecher">
          <CardHeader title={<span id="schulbuecher">Meine Schulbücher</span>} />
          {returnDay && <p className="text-sm text-muted">Rückgabetag der Schulbücher in diesem Schuljahr: {day(returnDay.day)}.</p>}
          <SchoolbookList books={myBooks} who="mir" />
        </Card>
      )}
      {myComps.length > 0 && (
        <Card aria-labelledby="ersatz">
          <CardHeader title={<span id="ersatz">Ersatzforderungen</span>} />
          <p className="text-sm text-muted">Für ein beschädigtes oder verlorenes Medium – wie bezahlt oder ersetzt wird, sagt das Sekretariat.</p>
          <CompensationList items={myComps} who="mich" />
        </Card>
      )}
      {perms.role === "eltern" &&
        (kids.length === 0 ? (
          <EmptyState title="Keine Kinder zugeordnet">Hier erscheinen die Ausleihen Ihrer Kinder, sobald die Schule sie Ihrem Konto zugeordnet hat.</EmptyState>
        ) : (
          kids.map((k) => (
            <Card key={k.id} aria-labelledby={`kind-${k.id}`}>
              <CardHeader title={<span id={`kind-${k.id}`}>{k.name}</span>} />
              <LibraryView lib={k} who={k.name} own={false} />
              {(booksOfKid.get(k.id)?.length ?? 0) > 0 && (
                <>
                  <h3 className="text-sm font-semibold">Schulbücher</h3>
                  {returnDay && <p className="text-sm text-muted">Rückgabetag in diesem Schuljahr: {day(returnDay.day)}.</p>}
                  <SchoolbookList books={booksOfKid.get(k.id)!} who={k.name} />
                </>
              )}
              {(kidsComps.get(k.id)?.length ?? 0) > 0 && (
                <>
                  <h3 className="text-sm font-semibold">Ersatzforderungen</h3>
                  <CompensationList items={kidsComps.get(k.id)!} who={k.name} />
                </>
              )}
            </Card>
          ))
        ))}
    </main>
  );
}
