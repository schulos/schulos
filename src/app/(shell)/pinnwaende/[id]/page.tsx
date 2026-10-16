import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, FileText } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { getBoard, groupFiles, MODE_LABELS } from "@/modules/pinnwaende/service";
import { Badge } from "@schulos/ui/badge";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { AddColumn, BoardSettings, CardActions, CardForm, ColumnMenu, DraggableCard, DropColumn, LiveRefresh, Members, MoveButtons } from "./board-client";

export const metadata: Metadata = { title: "Pinnwand" };

const IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;

export default async function PinnwandPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  const id = (await params).id;
  const data = await getBoard(db, perms, id);
  if (!data) notFound();
  const files = data.canPost ? await groupFiles(db, perms, id) : [];
  const leader = data.role === "leader";
  const { board } = data;
  const neighbor = (i: number) => {
    const col = data.columns[i];
    return col ? { id: col.id, title: col.title, count: col.cards.length } : null;
  };

  return (
    <main className="flex flex-col gap-6">
      <LiveRefresh boardId={board.id} />
      <PageHeader
        eyebrow={data.groupName ?? "Freie Pinnwand"}
        title={board.title}
        actions={
          <>
            <Link href={`/druck/pinnwand/${board.id}`} className="text-sm font-medium text-accent-ink hover:underline">
              Druckansicht
            </Link>
            <Link href="/pinnwaende" className="text-sm font-medium text-accent-ink hover:underline">
              Alle Pinnwände
            </Link>
          </>
        }
      />
      <p className="text-sm text-muted">{MODE_LABELS[board.mode]}</p>
      <div className="flex gap-4 overflow-x-auto pb-2">
        {data.columns.map((col, ci) => (
          <section key={col.id} aria-labelledby={`spalte-${col.id}`} className="flex w-72 shrink-0 flex-col gap-3 rounded-card bg-surface-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <h2 id={`spalte-${col.id}`} className="font-semibold">
                {col.title}
              </h2>
              {leader && <ColumnMenu boardId={board.id} columnId={col.id} title={col.title} />}
            </div>
            <DropColumn boardId={board.id} columnId={col.id} count={col.cards.length} label={`Karten in ${col.title}`}>
              {col.cards.map((c, i) => (
                <DraggableCard key={c.id} boardId={board.id} cardId={c.id} columnId={col.id} index={i} canMove={leader || c.mine}>
                  {!c.approved && <Badge tone="warn">wartet auf Freigabe</Badge>}
                  {c.kind === "file" && c.fileId && c.fileMime && IMAGE.test(c.fileMime) && (
                    // eslint-disable-next-line @next/next/no-img-element -- Bild aus dem Gruppenordner, Zugriff prüft die Dateien-API
                    <img src={`/api/dateien/${c.fileId}?inline`} alt={c.fileName ?? c.title} className="max-h-40 w-full rounded-lg object-cover" />
                  )}
                  <p className="font-medium">{c.title}</p>
                  {c.body && <p className="text-sm whitespace-pre-wrap">{c.body}</p>}
                  {c.kind === "link" && c.url && (
                    <a href={c.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-sm text-accent-ink hover:underline">
                      <ExternalLink className="size-3.5" aria-hidden /> {new URL(c.url).host}
                    </a>
                  )}
                  {c.kind === "file" && c.fileId && (
                    <a href={`/api/dateien/${c.fileId}`} className="inline-flex items-center gap-1 text-sm text-accent-ink hover:underline">
                      <FileText className="size-3.5" aria-hidden /> {c.fileName ?? "Datei"}
                    </a>
                  )}
                  {c.kind === "file" && !c.fileId && <p className="text-sm text-muted">Datei wurde gelöscht.</p>}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted">{c.authorName ?? "Gelöschtes Konto"}</span>
                    <CardActions boardId={board.id} cardId={c.id} title={c.title} approve={leader && !c.approved} remove={leader || c.mine} />
                  </div>
                  {(leader || c.mine) && (
                    <MoveButtons
                      boardId={board.id}
                      cardId={c.id}
                      title={c.title}
                      columnId={col.id}
                      index={i}
                      count={col.cards.length}
                      prevColumn={neighbor(ci - 1)}
                      nextColumn={neighbor(ci + 1)}
                    />
                  )}
                </DraggableCard>
              ))}
            </DropColumn>
            {data.canPost && <CardForm boardId={board.id} columnId={col.id} columnTitle={col.title} files={files} />}
          </section>
        ))}
      </div>
      {leader && (
        <Card aria-labelledby="verwalten">
          <h2 id="verwalten" className="text-base font-semibold">
            Pinnwand verwalten
          </h2>
          <AddColumn boardId={board.id} />
          <BoardSettings boardId={board.id} title={board.title} mode={board.mode} onMonitor={board.onMonitor} />
          {!board.groupId && (
            <>
              <h3 className="text-sm font-semibold">Mitglieder</h3>
              <Members boardId={board.id} members={data.members} />
            </>
          )}
        </Card>
      )}
    </main>
  );
}
