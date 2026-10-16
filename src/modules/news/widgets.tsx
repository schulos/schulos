import Link from "next/link";
import { Pin } from "lucide-react";
import type { CurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import type { WidgetDef } from "@/core/widgets";
import { Card, CardHeader } from "@schulos/ui/card";
import { listPosts } from "./service";

const rel = new Intl.RelativeTimeFormat("de-DE", { numeric: "auto" });
function when(d: Date) {
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  if (days === 0) {
    const h = Math.round((d.getTime() - Date.now()) / 3_600_000);
    return h === 0 ? "gerade eben" : rel.format(h, "hour");
  }
  return rel.format(days, "day");
}

async function Neuigkeiten({ current }: { current: CurrentUser }) {
  const posts = await listPosts(await getDb(), current.perms, { limit: 3 });
  return (
    <Card>
      <CardHeader title="Neuigkeiten" action={{ href: "/news", label: "Alle News" }} />
      {posts.length === 0 ? (
        <p className="text-sm text-muted">Gerade gibt es nichts Neues.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {posts.map((p) => (
            <li key={p.id}>
              <Link href={`/news/${p.id}`} className={`flex flex-col gap-0.5 rounded-xl px-3 py-2.5 hover:bg-surface-2 ${p.pinned ? "bg-accent-soft hover:bg-accent-soft" : ""}`}>
                <span className={`flex items-center gap-1.5 text-xs ${p.pinned ? "font-semibold text-accent-ink" : "text-muted"}`}>
                  {p.pinned && <Pin className="size-3" aria-hidden />}
                  {p.pinned ? "ANGEHEFTET · " : ""}
                  {p.authorName} · {when(p.publishedAt)}
                </span>
                <span className="font-medium">{p.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export const newsWidgets: WidgetDef[] = [{ id: "news.neuigkeiten", moduleId: "news", order: 20, Component: Neuigkeiten }];
