import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { hasPermission } from "@/core/permissions";
import { previewTeacherSubjectCsvAction, runTeacherSubjectCsvAction } from "@/modules/stundenplan/actions";
import { TEACHER_SUBJECT_CSV_HEADER } from "@/modules/stundenplan/lehrfaecher";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { TeacherSubjectImportForm } from "./import-form";

export const metadata: Metadata = { title: "Lehrfächer importieren" };

/** SP2-12: Lehrfächer je Lehrkraft aus einer CSV-Datei (Muster wie der Import der Unterrichtsverteilung, SP2-06). */
export default async function TeacherSubjectImportPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.manage")) notFound();
  return (
    <main className="flex flex-col gap-6">
      <Link href="/planung/unterricht?ansicht=lehrkraefte" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> Lehrkräfte
      </Link>
      <PageHeader eyebrow="Stundenplanung" title="Lehrfächer importieren" />
      <Card aria-labelledby="hinweise">
        <h2 id="hinweise" className="text-base font-semibold">
          So sieht die Datei aus
        </h2>
        <p className="text-sm text-muted">
          Eine Zeile je Lehrkraft. Spalten: <strong>{TEACHER_SUBJECT_CSV_HEADER.join(" ; ")}</strong> – die Kopfzeile ist optional. Beispiel:{" "}
          <code className="rounded bg-surface-2 px-1">ABC;M PH</code>
        </p>
        <ul className="list-disc pl-5 text-sm text-muted">
          <li>Lehrkraft über Kürzel oder Namen, Fächer über Kurzzeichen oder Namen – mehrere mit Leerzeichen, „/“ oder „+“ trennen.</li>
          <li>Die Lehrfächer der genannten Lehrkräfte werden ersetzt; wer nicht in der Datei steht, bleibt wie er ist. Eine leere Fächer-Spalte löscht die Lehrfächer.</li>
          <li>Mit Fehlern wird nichts übernommen.</li>
        </ul>
      </Card>
      <TeacherSubjectImportForm preview={previewTeacherSubjectCsvAction} run={runTeacherSubjectCsvAction} />
    </main>
  );
}
