"use client";

import { MessageSquarePlus, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { useEffect, useState, useTransition } from "react";
import { ROLE_LABELS } from "@/core/labels";
import type { Role } from "@/core/roles";
import { findPeopleAction, openDirectAction } from "@/modules/messenger/actions";
import { passiveRefresh } from "@schulos/ui/auto-refresh";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { Input } from "@schulos/ui/field";
import { Avatar } from "@schulos/ui/misc";
import { useLive } from "../_shell/live";

interface Room {
  id: string;
  kind: "direct" | "group";
  title: string;
  avatar: string;
  lastMessage: { body: string; authorName: string | null; createdAt: string } | null;
  unread: number;
}

const time = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const day = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", timeZone: "Europe/Berlin" });
function when(iso: string) {
  const d = new Date(iso);
  return new Date().toDateString() === d.toDateString() ? time.format(d) : day.format(d);
}

export function RoomList({ initial, me }: { initial: Room[]; me: string }) {
  const [rooms, setRooms] = useState(initial);
  const pathname = usePathname();
  const router = useRouter();
  const activeId = pathname.split("/")[2];

  useLive((m) => {
    if (m.type === "chat") {
      // Nachricht aus einem Raum, den wir noch nicht kennen (z. B. neuer Direktchat) → Serverdaten neu laden
      if (!rooms.some((r) => r.id === m.message.roomId)) {
        passiveRefresh(router); // G4E-C01: Live-Ereignis, keine Aktivität der Person
        return;
      }
      setRooms((cur) => {
        const room = cur.find((r) => r.id === m.message.roomId);
        if (!room) return cur;
        const mine = m.message.authorId === me;
        const updated: Room = {
          ...room,
          lastMessage: { body: m.message.body, authorName: m.message.authorName, createdAt: m.message.createdAt },
          unread: mine || room.id === activeId ? room.unread : room.unread + 1,
        };
        return [updated, ...cur.filter((r) => r.id !== room.id)];
      });
    }
    if (m.type === "chat-read" && m.userId === me) setRooms((cur) => cur.map((r) => (r.id === m.roomId ? { ...r, unread: 0 } : r)));
  });

  return (
    <aside aria-label="Chats" className={cn("flex min-h-0 flex-col overflow-hidden rounded-card border border-border bg-surface", activeId && "hidden lg:flex")}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h1 className="font-display text-xl font-bold tracking-tight">Messenger</h1>
        <NewChat />
      </header>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {rooms.map((r) => (
          <li key={r.id}>
            <Link
              href={`/messenger/${r.id}`}
              aria-current={r.id === activeId ? "page" : undefined}
              className={cn("flex items-center gap-3 rounded-xl px-2.5 py-2.5 hover:bg-surface-2", r.id === activeId && "bg-accent-soft hover:bg-accent-soft")}
            >
              <Avatar label={r.avatar} tone={r.kind === "group" ? "warn" : "soft"} className="size-10 text-xs" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={cn("truncate", r.unread > 0 ? "font-semibold" : "font-medium")}>{r.title}</span>
                  {r.lastMessage && <span className="shrink-0 text-xs text-muted">{when(r.lastMessage.createdAt)}</span>}
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-muted">
                    {r.lastMessage ? `${r.kind === "group" && r.lastMessage.authorName ? `${r.lastMessage.authorName.split(" ")[0]}: ` : ""}${r.lastMessage.body}` : "Noch keine Nachrichten"}
                  </span>
                  {r.unread > 0 && (
                    <span data-testid={`unread-${r.id}`} className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-accent px-1.5 text-xs font-semibold text-accent-fg">
                      {r.unread}
                    </span>
                  )}
                </span>
              </span>
            </Link>
          </li>
        ))}
        {rooms.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted">Noch keine Chats.</li>}
      </ul>
    </aside>
  );
}

function NewChat() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<Awaited<ReturnType<typeof findPeopleAction>>>([]);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = setTimeout(() => void findPeopleAction(q).then(setPeople), 150);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button size="sm" aria-label="Neuer Chat">
          <MessageSquarePlus aria-hidden /> Neu
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(10_12_16/0.45)]" />
        <Dialog.Content aria-describedby={undefined} className="fixed top-[15vh] left-1/2 z-50 flex w-[min(480px,calc(100vw-24px))] -translate-x-1/2 flex-col gap-3 rounded-2xl border border-border bg-surface p-4 text-ink shadow-card">
          <Dialog.Title className="font-semibold">Neuer Chat</Dialog.Title>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                if (e.target.value.trim().length < 2) setPeople([]);
              }}
              placeholder="Name oder Kürzel"
              aria-label="Person suchen"
              className="pl-9"
            />
          </div>
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {people.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    start(() =>
                      openDirectAction(p.id).then((r) => {
                        if (r?.error) setError(r.error);
                        else setOpen(false);
                      }),
                    )
                  }
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-surface-2"
                >
                  <Avatar label={p.shortCode ?? p.name.split(" ").map((x) => x[0]).join("")} tone="soft" className="size-8 text-xs" />
                  <span className="flex flex-col leading-tight">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-muted">{ROLE_LABELS[p.role as Role]}</span>
                  </span>
                </button>
              </li>
            ))}
            {q.trim().length >= 2 && people.length === 0 && <li className="px-2 py-4 text-sm text-muted">Niemand gefunden.</li>}
          </ul>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
