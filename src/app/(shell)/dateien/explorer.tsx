"use client";

import { ChevronRight, Download, Eye, File, FileImage, FileText, Folder, FolderPlus, Pencil, Trash2, Upload, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { useRef, useState, useTransition } from "react";
import { createFolderAction, deleteAction, renameAction } from "@/modules/dateien/actions";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { EmptyState, Progress } from "@schulos/ui/misc";

interface Item {
  id: string;
  kind: "folder" | "file";
  name: string;
  size: number;
  mime: string | null;
  updatedAt: string;
  canModify: boolean;
}

const fmtDate = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "Europe/Berlin" });
export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1).replace(".", ",")} MB`;
  return `${(n / 1024 ** 3).toFixed(2).replace(".", ",")} GB`;
}
const previewable = (m: string | null) => !!m && /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf)$/.test(m);

function Icon({ item }: { item: Item }) {
  if (item.kind === "folder") return <Folder className="size-5 text-accent-ink" aria-hidden />;
  if (item.mime?.startsWith("image/")) return <FileImage className="size-5 text-muted" aria-hidden />;
  if (item.mime === "application/pdf" || item.mime?.startsWith("text/")) return <FileText className="size-5 text-muted" aria-hidden />;
  return <File className="size-5 text-muted" aria-hidden />;
}

export function Explorer({
  space,
  spaceLabel,
  folderId,
  crumbs,
  items,
  used,
  quota,
  boards = false,
}: {
  space: string;
  spaceLabel: string;
  folderId: string | null;
  crumbs: { id: string; name: string }[];
  items: Item[];
  used: number;
  quota: number;
  /** Tafeln (P3-12) eingeschaltet und Gruppenordner: „*.excalidraw“ öffnet die Tafel statt des Downloads */
  boards?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<Item | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const base = `/dateien?bereich=${encodeURIComponent(space)}`;

  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (list.length === 0) return;
    setUploading(true);
    setMessage(null);
    try {
      // je Datei eine Anfrage: der Proxy puffert höchstens 30 MB je Anfrage (next.config.ts, SEC-05)
      let ok = 0;
      const errs: string[] = [];
      for (const f of list) {
        const form = new FormData();
        form.set("space", space);
        if (folderId) form.set("parent", folderId);
        form.append("files", f);
        const res = await fetch("/api/dateien/upload", { method: "POST", body: form });
        const data = (await res.json().catch(() => ({ error: `„${f.name}“ konnte nicht hochgeladen werden` }))) as {
          uploaded?: { name: string }[];
          errors?: string[];
          error?: string;
        };
        ok += data.uploaded?.length ?? 0;
        errs.push(...(data.errors ?? (data.error ? [data.error] : [])));
      }
      setMessage(errs.length ? { tone: "error", text: `${ok} hochgeladen. ${errs.join(" · ")}` } : { tone: "ok", text: `${ok} ${ok === 1 ? "Datei" : "Dateien"} hochgeladen` });
      router.refresh();
    } finally {
      setUploading(false);
    }
  }

  const act = (fn: () => Promise<{ ok: true } | { error: string }>) =>
    start(async () => {
      const r = await fn();
      setMessage("error" in r ? { tone: "error", text: r.error } : null);
    });

  return (
    <section
      aria-label={spaceLabel}
      className={cn("flex min-w-0 flex-col gap-4 rounded-card border bg-surface p-4 sm:p-5", dragging ? "border-accent ring-2 ring-accent/30" : "border-border")}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void upload(e.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Pfad" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
          <Link href={base} className="font-semibold hover:underline">
            {spaceLabel}
          </Link>
          {crumbs.map((c) => (
            <span key={c.id} className="flex items-center gap-1">
              <ChevronRight className="size-4 text-muted" aria-hidden />
              <Link href={`${base}&ordner=${c.id}`} className="hover:underline">
                {c.name}
              </Link>
            </span>
          ))}
        </nav>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              const name = prompt("Name des neuen Ordners");
              if (name) act(() => createFolderAction(space, folderId, name));
            }}
          >
            <FolderPlus aria-hidden /> Ordner
          </Button>
          <Button size="sm" variant="primary" disabled={uploading} onClick={() => input.current?.click()}>
            <Upload aria-hidden /> {uploading ? "Lädt hoch …" : "Hochladen"}
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            className="sr-only"
            aria-label="Dateien auswählen"
            onChange={(e) => {
              if (e.target.files) void upload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={cn("text-sm", message.tone === "error" ? "text-danger" : "text-success")}>
          {message.text}
        </p>
      )}

      {items.length === 0 ? (
        <EmptyState title="Dieser Ordner ist leer">Dateien hierher ziehen oder „Hochladen“ wählen.</EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-3 py-2">
              <Icon item={it} />
              {it.kind === "folder" ? (
                <Link href={`${base}&ordner=${it.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                  {it.name}
                </Link>
              ) : boards && /.\.excalidraw$/i.test(it.name) ? (
                <Link href={`/tafeln/${it.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline" title="Als Tafel öffnen">
                  {it.name}
                </Link>
              ) : (
                <a href={`/api/dateien/${it.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline" download>
                  {it.name}
                </a>
              )}
              <span className="hidden w-20 text-right text-sm text-muted tabular-nums sm:block">{it.kind === "file" ? formatBytes(it.size) : ""}</span>
              <span className="hidden w-28 text-right text-sm text-muted md:block">{fmtDate.format(new Date(it.updatedAt))}</span>
              <span className="flex shrink-0 justify-end sm:w-44">
                {it.kind === "file" && previewable(it.mime) && (
                  <Button size="sm" variant="ghost" aria-label={`${it.name} ansehen`} onClick={() => setPreview(it)}>
                    <Eye aria-hidden />
                  </Button>
                )}
                {it.kind === "file" && (
                  <Button asChild size="sm" variant="ghost">
                    <a href={`/api/dateien/${it.id}`} download aria-label={`${it.name} herunterladen`}>
                      <Download aria-hidden />
                    </a>
                  </Button>
                )}
                {it.canModify && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${it.name} umbenennen`}
                      disabled={pending}
                      onClick={() => {
                        const name = prompt("Neuer Name", it.name);
                        if (name && name !== it.name) act(() => renameAction(space, it.id, name));
                      }}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${it.name} löschen`}
                      disabled={pending}
                      onClick={() => {
                        if (confirm(it.kind === "folder" ? `Ordner „${it.name}“ mit allem Inhalt löschen?` : `„${it.name}“ löschen?`)) act(() => deleteAction(space, it.id));
                      }}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <footer className="flex flex-col gap-1.5 border-t border-border pt-3">
        <Progress value={(used / quota) * 100} label="Belegter Speicher" color={used / quota > 0.9 ? "var(--danger)" : undefined} />
        <span className="text-xs text-muted">
          {formatBytes(used)} von {formatBytes(quota)} belegt
        </span>
      </footer>

      <Dialog.Root open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(10_12_16/0.6)]" />
          <Dialog.Content aria-describedby={undefined} className="fixed inset-3 z-50 flex flex-col overflow-hidden rounded-2xl border border-border bg-surface sm:inset-10">
            <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
              <Dialog.Title className="truncate font-semibold">{preview?.name}</Dialog.Title>
              <Dialog.Close asChild>
                <Button size="sm" variant="ghost" aria-label="Schließen">
                  <X aria-hidden />
                </Button>
              </Dialog.Close>
            </header>
            {preview && (
              <div className="grid min-h-0 flex-1 place-items-center bg-ground">
                {preview.mime === "application/pdf" ? (
                  <iframe src={`/api/dateien/${preview.id}?inline`} title={preview.name} className="size-full" />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- geschützte API-Route, kein next/image
                  <img src={`/api/dateien/${preview.id}?inline`} alt={preview.name} className="max-h-full max-w-full object-contain" />
                )}
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
