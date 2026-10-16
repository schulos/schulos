"use client";

import { Bell, CheckCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { Popover } from "radix-ui";
import { useEffect, useState, useTransition } from "react";
import type { GongItem } from "@/core/notifications/bus";
import { passiveRefresh } from "@schulos/ui/auto-refresh";
import { cn } from "@schulos/ui/cn";
import { listGongAction, markGongReadAction } from "./gong-actions";
import { useLive } from "./live";

const rel = new Intl.RelativeTimeFormat("de-DE", { numeric: "auto" });
function ago(iso: string): string {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s > -60) return "gerade eben";
  if (s > -3600) return rel.format(Math.round(s / 60), "minute");
  if (s > -86400) return rel.format(Math.round(s / 3600), "hour");
  return rel.format(Math.round(s / 86400), "day");
}

export function Gong({ initialUnread }: { initialUnread: number }) {
  const [unread, setUnread] = useState(initialUnread);
  const [items, setItems] = useState<GongItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  const router = useRouter();

  // Live-Updates über den gemeinsamen SSE-Kanal der Shell
  useLive((m) => {
    if (m.type === "hello" || m.type === "read") setUnread(m.unread);
    if (m.type === "notification") {
      setUnread(m.unread);
      // gebündelte Gongs (Q5-03) kommen mit derselben id erneut – ersetzen statt doppelt anzeigen
      if (m.notification) setItems((cur) => (cur ? [m.notification!, ...cur.filter((n) => n.id !== m.notification!.id)] : cur));
      // Serverdaten der aktuellen Seite (z. B. Widgets) auffrischen – Client-Zustand bleibt erhalten. Kein Zeichen von
      // Aktivität der Person (G4E-C01).
      passiveRefresh(router);
    }
  });

  useEffect(() => {
    if (open && items === null) void listGongAction().then(setItems);
  }, [open, items]);

  const label = unread > 0 ? `Gong – ${unread} neue Benachrichtigungen` : "Gong – keine neuen Benachrichtigungen";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          title="Gong"
          className="relative grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-surface text-ink hover:bg-surface-2"
        >
          <Bell className="size-5" aria-hidden strokeWidth={1.8} />
          {unread > 0 && (
            <span
              data-testid="gong-count"
              className="absolute top-1.5 right-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-fg"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          // A11Y-01f: Dialog braucht einen Namen; Kopf als div – ein <header> außerhalb von <main> wäre ein zweites „banner“
          aria-labelledby="gong-titel"
          className="z-50 flex max-h-[min(70vh,520px)] w-[min(380px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-border bg-surface text-ink shadow-card"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 id="gong-titel" className="font-semibold">
              Gong
            </h2>
            {unread > 0 && (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-accent-ink hover:bg-accent-soft"
                onClick={() =>
                  start(async () => {
                    setUnread(await markGongReadAction());
                    setItems((cur) => cur?.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })) ?? cur);
                  })
                }
              >
                <CheckCheck className="size-4" aria-hidden /> Alle gelesen
              </button>
            )}
          </div>
          <ul aria-label="Benachrichtigungen" className="flex-1 overflow-y-auto p-1.5">
            {items === null && <li className="px-3 py-8 text-center text-sm text-muted">Lädt …</li>}
            {items?.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted">Noch keine Benachrichtigungen.</li>}
            {items?.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className="flex w-full gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-surface-2"
                  onClick={() =>
                    start(async () => {
                      if (!n.readAt) {
                        setUnread(await markGongReadAction([n.id]));
                        setItems((cur) => cur?.map((i) => (i.id === n.id ? { ...i, readAt: new Date().toISOString() } : i)) ?? cur);
                      }
                      if (n.href) {
                        setOpen(false);
                        router.push(n.href);
                      }
                    })
                  }
                >
                  <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-accent")} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className={cn("text-sm", !n.readAt && "font-semibold")}>{n.title}</span>
                    {n.body && <span className="line-clamp-2 text-sm text-muted">{n.body}</span>}
                    <span className="text-xs text-muted">{ago(n.createdAt)}</span>
                  </span>
                  {!n.readAt && <span className="sr-only">(ungelesen)</span>}
                </button>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
