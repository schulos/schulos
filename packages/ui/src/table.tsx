import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "./cn";

/** Tabelle im Karten-Rahmen; scrollt auf schmalen Bildschirmen horizontal. */
export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto rounded-card border border-border bg-surface", className)}>
      <table className="w-full border-collapse text-left text-sm [&_td]:border-t [&_td]:border-border [&_td]:px-4 [&_td]:py-3 [&_th]:px-4 [&_th]:py-3 [&_th]:text-xs [&_th]:font-semibold [&_th]:tracking-wide [&_th]:text-muted [&_th]:uppercase [&_tbody_tr:hover]:bg-surface-2">
        {children}
      </table>
    </div>
  );
}

/** Seitenblättern über Query-Parameter `page`, alle anderen Parameter bleiben erhalten. */
export function Pagination({
  page,
  total,
  pageSize,
  basePath,
  params,
}: {
  page: number;
  total: number;
  pageSize: number;
  basePath: string;
  params: Record<string, string | undefined>;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => {
    const sp = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])));
    if (p > 1) sp.set("page", String(p));
    else sp.delete("page");
    const qs = sp.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const btn = "inline-flex size-10 items-center justify-center rounded-xl border border-border bg-surface hover:bg-surface-2";
  return (
    <nav aria-label="Seiten" className="flex items-center justify-between gap-3 text-sm text-muted">
      <span>
        {from}–{to} von {total}
      </span>
      <span className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} className={btn} aria-label="Vorherige Seite">
            <ChevronLeft className="size-4" aria-hidden />
          </Link>
        ) : (
          <span className={cn(btn, "opacity-40")} aria-hidden>
            <ChevronLeft className="size-4" />
          </span>
        )}
        <span>
          Seite {page} / {pages}
        </span>
        {page < pages ? (
          <Link href={href(page + 1)} className={btn} aria-label="Nächste Seite">
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        ) : (
          <span className={cn(btn, "opacity-40")} aria-hidden>
            <ChevronRight className="size-4" />
          </span>
        )}
      </span>
    </nav>
  );
}
