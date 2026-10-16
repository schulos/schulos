import type { Metadata } from "next";
import Link from "next/link";
import { Pin, Plus } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { canWrite, listPosts } from "@/modules/news/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Input } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "News" };

const fmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", timeZone: "Europe/Berlin" });

/** Vorschautext ohne Markdown-Zeichen. */
function teaser(md: string, len = 180) {
  const plain = md.replace(/[*_#>`[\]()-]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > len ? `${plain.slice(0, len)} …` : plain;
}

export default async function NewsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { perms } = await requireUser();
  const { q } = await searchParams;
  const posts = await listPosts(await getDb(), perms, { q });

  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader
        title="News"
        actions={
          canWrite(perms) && (
            <Button asChild variant="primary">
              <Link href="/news/neu">
                <Plus aria-hidden /> Beitrag schreiben
              </Link>
            </Button>
          )
        }
      />
      <form role="search">
        <Input name="q" type="search" defaultValue={q} placeholder="Beiträge durchsuchen …" aria-label="News durchsuchen" />
      </form>
      {posts.length === 0 ? (
        <EmptyState title={q ? `Keine Beiträge zu „${q}“` : "Noch keine Beiträge"} />
      ) : (
        <ul className="flex flex-col gap-3">
          {posts.map((p) => (
            <li key={p.id}>
              <Link
                href={`/news/${p.id}`}
                className={`flex flex-col gap-2 rounded-card border bg-surface p-5 transition hover:border-border-strong ${p.pinned ? "border-accent/40" : "border-border"}`}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {p.pinned && (
                    <Badge tone="soft">
                      <Pin className="size-3" aria-hidden /> Angeheftet
                    </Badge>
                  )}
                  <span className="text-muted">
                    {p.authorName ?? "Unbekannt"} · {fmt.format(p.publishedAt)}
                  </span>
                  {p.targets.length > 0 && <span className="text-muted">· an {p.targets.join(", ")}</span>}
                </div>
                <h2 className="text-lg font-semibold">{p.title}</h2>
                <p className="text-muted">{teaser(p.body)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
