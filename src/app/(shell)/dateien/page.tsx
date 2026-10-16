import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { moduleOn } from "@/core/modules/guard";
import { groupFolders, listFolder } from "@/modules/dateien/service";
import { ValidationError } from "@/modules/verwaltung/users";
import { cn } from "@schulos/ui/cn";
import { PageHeader } from "@schulos/ui/misc";
import { Explorer } from "./explorer";

export const metadata: Metadata = { title: "Dateien" };

export default async function DateienPage({ searchParams }: { searchParams: Promise<{ bereich?: string; ordner?: string }> }) {
  const { perms } = await requireUser();
  const sp = await searchParams;
  const space = sp.bereich ?? "personal";
  const db = await getDb();
  const [spaces, boardsOn, data] = await Promise.all([
    groupFolders(db, perms),
    moduleOn("tafeln"),
    listFolder(db, perms, space, sp.ordner ?? null).catch((err) => {
      if (err instanceof ValidationError) return null;
      throw err;
    }),
  ]);
  if (!data) notFound();
  const all = [{ key: "personal", label: "Meine Dateien" }, ...spaces.map((g) => ({ key: `group:${g.id}`, label: g.name }))];

  return (
    <main className="flex flex-col gap-6">
      <PageHeader title="Dateien" />
      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Bereiche" className="flex gap-1 overflow-x-auto lg:flex-col">
          {all.map((s) => (
            <Link
              key={s.key}
              href={`/dateien?bereich=${encodeURIComponent(s.key)}`}
              aria-current={s.key === space ? "page" : undefined}
              className={cn(
                "rounded-xl px-3 py-2 text-sm whitespace-nowrap hover:bg-surface",
                s.key === space && "bg-accent-soft font-semibold text-accent-ink hover:bg-accent-soft",
              )}
            >
              {s.label}
            </Link>
          ))}
        </nav>
        <Explorer
          space={space}
          spaceLabel={all.find((s) => s.key === space)?.label ?? "Dateien"}
          folderId={sp.ordner ?? null}
          crumbs={data.crumbs}
          items={data.items.map((i) => ({ ...i, updatedAt: i.updatedAt.toISOString() }))}
          used={data.used}
          quota={data.quota}
          boards={boardsOn && space.startsWith("group:")}
        />
      </div>
    </main>
  );
}
