import type { Metadata } from "next";
import Link from "next/link";
import { FolderTree, Plus } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { canEditAll, listOutline, searchPages } from "@/modules/hilfe/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Input } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Handbuch" };

/** Vorschautext ohne Markdown-Zeichen. */
function teaser(md: string, len = 160) {
  const plain = md.replace(/[*_#>`[\]()|-]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > len ? `${plain.slice(0, len)} …` : plain;
}

export default async function HilfePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { perms } = await requireUser();
  const q = (await searchParams).q?.trim() ?? "";
  const db = await getDb();
  const editor = canEditAll(perms);
  const [outline, hits] = await Promise.all([q ? Promise.resolve([]) : listOutline(db, perms), q ? searchPages(db, perms, q) : Promise.resolve([])]);

  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader
        title="Handbuch"
        actions={
          editor && (
            <>
              <Button asChild>
                <Link href="/hilfe/bereiche">
                  <FolderTree aria-hidden /> Bereiche
                </Link>
              </Button>
              <Button asChild variant="primary">
                <Link href="/hilfe/neu">
                  <Plus aria-hidden /> Seite anlegen
                </Link>
              </Button>
            </>
          )
        }
      />
      <p className="text-muted">So läuft es bei uns: Abläufe und Anleitungen der Schule an einer Stelle.</p>
      <form role="search" action="/hilfe">
        <Input name="q" type="search" defaultValue={q} placeholder="Handbuch durchsuchen …" aria-label="Handbuch durchsuchen" />
      </form>

      {q ? (
        hits.length === 0 ? (
          <EmptyState title={`Keine Seiten zu „${q}“`}>Andere Wörter versuchen oder in der Gliederung nachsehen.</EmptyState>
        ) : (
          <section aria-label="Suchergebnisse" className="flex flex-col gap-3">
            <p className="text-sm text-muted" role="status">
              {hits.length === 1 ? "1 Seite gefunden" : `${hits.length} Seiten gefunden`}
            </p>
            <ul className="flex flex-col gap-3">
              {hits.map((h) => (
                <li key={h.id}>
                  <Link href={`/hilfe/${h.slug}`} className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4 transition hover:border-border-strong">
                    <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      {h.sectionTitle}
                      {h.status === "entwurf" && <Badge tone="warn">Entwurf</Badge>}
                    </span>
                    <span className="font-semibold">{h.title}</span>
                    {h.body && <span className="text-sm text-muted">{teaser(h.body)}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )
      ) : outline.length === 0 ? (
        <EmptyState title="Noch keine Seiten">
          {editor ? "Zuerst unter „Bereiche“ einen Bereich anlegen, dann die erste Seite schreiben." : "Hier stehen bald Anleitungen und Abläufe der Schule."}
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {outline.map((s) => (
            <Card key={s.id} className="gap-3">
              <h2 className="text-lg font-semibold">{s.title}</h2>
              {s.pages.length === 0 ? (
                <p className="text-sm text-muted">Noch keine Seiten in diesem Bereich.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {s.pages.map((p) => (
                    <li key={p.id}>
                      <Link href={`/hilfe/${p.slug}`} className="flex min-h-11 items-center justify-between gap-2 rounded-xl px-2 py-2 hover:bg-surface-2">
                        <span className="font-medium">{p.title}</span>
                        {p.status === "entwurf" && <Badge tone="warn">Entwurf</Badge>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
