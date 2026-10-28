"use client";

import { CircleHelp } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { helpHref } from "@/modules/hilfe/context";

/** HB-03: „?“ in der Kopfzeile – öffnet das Handbuch (später kontextbezogen, HB-07). */
export function HelpButton() {
  const pathname = usePathname();
  return (
    <Link
      href={helpHref(pathname)}
      aria-label="Handbuch"
      title="Handbuch"
      className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-surface text-ink hover:bg-surface-2"
    >
      <CircleHelp className="size-5" aria-hidden strokeWidth={1.8} />
    </Link>
  );
}
