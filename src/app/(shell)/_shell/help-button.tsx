"use client";

import { CircleHelp } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { helpHref } from "@/modules/hilfe/context";

/** HB-03: „?“ in der Kopfzeile – öffnet das Handbuch – kontextbezogen (HB-07): führt zur Seite des aktuellen Moduls, falls es sie für die Person gibt. */
export function HelpButton({ pages }: { pages: Record<string, string> }) {
  const pathname = usePathname();
  return (
    <Link
      href={helpHref(pathname, pages)}
      aria-label="Handbuch"
      title="Handbuch"
      className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-surface text-ink hover:bg-surface-2"
    >
      <CircleHelp className="size-5" aria-hidden strokeWidth={1.8} />
    </Link>
  );
}
