import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { saveBooklistAction } from "@/modules/buecherei/actions";
import { BooklistView } from "@/modules/buecherei/booklist-view";
import { MAX_BOOKLIST_TEXT, booklist, booklistOverview, canMaterials, canReadBooklist, lernmittelEnabled, ownGrades, publishedGrades } from "@/modules/buecherei/lernmittel";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { SpecForm } from "@/ui/spec-form";
import { BuechereiNav } from "../ui";

export const metadata: Metadata = { title: "Bücherliste" };

/**
 * Bücherliste je Jahrgang (BU-10): Wer Lernmittel pflegt, sieht alle Jahrgänge (auch Entwürfe), schreibt den Hinweistext und
 * gibt frei; alle anderen mit Bücherei-Zugang und Eltern sehen nur freigegebene Listen – vorausgewählt der Jahrgang der eigenen
 * Klasse bzw. der Kinder. Kein Personenbezug.
 */
export default async function BuecherlistePage({ searchParams }: { searchParams: Promise<{ jahrgang?: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  if (!canReadBooklist(perms) || !(await lernmittelEnabled(db))) notFound();
  const manage = canMaterials(perms);
  const sp = await searchParams;
  const grades = manage ? await booklistOverview(db, perms) : (await publishedGrades(db)).map((g) => ({ ...g, materials: null, published: true }));
  const own = await ownGrades(db, perms);
  const fallback = own.find((g) => grades.some((x) => x.level === g)) ?? grades[0]?.level;
  const grade = grades.find((g) => g.level === Number(sp.jahrgang))?.level ?? fallback;
  const list = grade !== undefined ? await booklist(db, perms, grade) : null;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Bücherei · Schulbuchausleihe" title="Bücherliste" />
      <BuechereiNav current="buecherliste" perms={perms} />
      {grades.length === 0 ? (
        <EmptyState title="Noch keine Bücherliste">Die Schule hat noch keine Bücherliste veröffentlicht.</EmptyState>
      ) : (
        <>
          <nav aria-label="Jahrgang" className="flex flex-wrap gap-2">
            {grades.map((g) => (
              <Button key={g.level} asChild size="sm" variant={g.level === grade ? "secondary" : "ghost"}>
                <Link href={`/buecherei/buecherliste?jahrgang=${g.level}`} aria-current={g.level === grade ? "page" : undefined}>
                  {g.name}
                  {manage && !g.published && <span className="ml-1 text-xs text-muted">(Entwurf)</span>}
                  {own.includes(g.level) && <span className="sr-only"> (eigener Jahrgang)</span>}
                </Link>
              </Button>
            ))}
          </nav>
          {list && (
            <Card aria-labelledby="liste">
              <CardHeader
                title={
                  <span id="liste" className="flex flex-wrap items-center gap-2">
                    Bücherliste {list.gradeName}
                    {manage && <Badge tone={list.published ? "success" : "neutral"}>{list.published ? "für Eltern freigegeben" : "Entwurf"}</Badge>}
                  </span>
                }
                action={{ href: `/druck/buecherliste?jahrgang=${list.grade}`, label: "Drucken" }}
              />
              <BooklistView list={list} />
            </Card>
          )}
          {manage && list && (
            <Card aria-labelledby="hinweis">
              <CardHeader title={<span id="hinweis">Hinweistext und Freigabe {list.gradeName}</span>} />
              <p className="text-sm text-muted">
                Die Lernmittel kommen aus der{" "}
                <Link href={`/buecherei/lernmittel?jahrgang=${list.grade}`} className="font-medium text-accent-ink hover:underline">
                  Lernmittel-Liste
                </Link>{" "}
                (Jahrgang, „leiht die Schule aus“ bzw. „selbst kaufen“ mit Preis). Hier nur der Text für die Eltern, z. B. Abgabetermin, Schutzumschläge, Eigenanteil.
              </p>
              <SpecForm
                action={saveBooklistAction.bind(null, list.grade)}
                label={`Bücherliste ${list.gradeName} speichern`}
                submit="Speichern"
                columns={1}
                fields={[
                  { name: "text", label: "Hinweistext", type: "textarea", maxLength: MAX_BOOKLIST_TEXT, defaultValue: list.text, hint: "erscheint über der Liste – keine Personennamen" },
                  { name: "published", label: "für Eltern, Schüler:innen und Lehrkräfte freigeben", type: "checkbox", checked: list.published },
                ]}
              />
            </Card>
          )}
        </>
      )}
    </main>
  );
}
