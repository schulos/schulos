import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { boardAccess } from "@/modules/tafeln/service";
import { PageHeader } from "@schulos/ui/misc";
import { BoardLoader } from "./board-loader";

export const metadata: Metadata = { title: "Tafel" };

export default async function TafelPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const id = (await params).id;
  const access = await boardAccess(await getDb(), perms, id);
  if (!access) notFound();
  return (
    <main className="flex flex-col gap-4">
      <PageHeader
        eyebrow={access.groupName}
        title={access.title}
        actions={
          <>
            <a href={`/api/dateien/${id}`} download className="text-sm font-medium text-accent-ink hover:underline">
              Datei herunterladen
            </a>
            <Link href="/tafeln" className="text-sm font-medium text-accent-ink hover:underline">
              Alle Tafeln
            </Link>
          </>
        }
      />
      {access.archived && <p className="text-sm text-muted">Gruppe archiviert – nur ansehen</p>}
      {/* Excalidraw (~2 MB) nur hier laden: next/dynamic ohne SSR in board-loader.tsx */}
      <BoardLoader key={id} boardId={id} title={access.title} canWrite={access.canWrite} />
    </main>
  );
}
