import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { canConfigure } from "@/modules/gebaeude/pruefungen";
import { canViewAll } from "@/modules/gebaeude/service";
import { PageHeader } from "@schulos/ui/misc";
import { GebaeudeNav } from "../ui";
import { GebaeudeConfig } from "./config-view";

export const metadata: Metadata = { title: "Prüfarten und Zuständigkeiten" };

/** Prüfarten und Zuständigkeiten im Modul – für `gebaeude.configure` auch ohne Verwaltungszugang (Code-Review Gate 4a N5). */
export default async function PruefartenPage() {
  const { perms } = await requireUser();
  if (!canConfigure(perms)) notFound();
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Gebäude & Technik" title="Prüfarten und Zuständigkeiten" />
      {canViewAll(perms) && <GebaeudeNav current="pruefarten" configure />}
      <GebaeudeConfig />
    </main>
  );
}
