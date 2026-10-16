import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { requireModulePage } from "@/core/modules/guard";
import { canConfigure } from "@/modules/gebaeude/pruefungen";
import { PageHeader } from "@schulos/ui/misc";
import { GebaeudeConfig } from "../../gebaeude/pruefarten/config-view";

export const metadata: Metadata = { title: "Gebäude & Technik verwalten" };

/** Verwaltung → Gebäude & Technik: Prüfarten und Zuständigkeiten (dieselbe Ansicht wie /gebaeude/pruefarten). */
export default async function GebaeudeVerwaltungPage() {
  await requireModulePage("gebaeude");
  const { perms } = await requireUser();
  if (!canConfigure(perms)) notFound();
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Verwaltung" title="Gebäude & Technik" />
      <GebaeudeConfig />
    </main>
  );
}
