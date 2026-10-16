"use client";

import { ArrowLeft, CheckCheck, SendHorizontal } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import type { ChatMessageEvent } from "@/core/notifications/bus";
import { markReadAction, sendMessageAction } from "@/modules/messenger/actions";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { Avatar } from "@schulos/ui/misc";
import { useLive } from "../../_shell/live";

type Msg = Omit<ChatMessageEvent, "authorName"> & { authorName: string | null };

const time = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Berlin" });

export function Conversation({
  me,
  room,
  initialMessages,
  initialReads,
  polls,
  blocked,
  notice,
}: {
  me: string;
  room: { id: string; kind: "direct" | "group"; title: string; avatar: string; memberCount: number };
  initialMessages: Msg[];
  initialReads: { userId: string; lastReadAt: string }[];
  /** Schnellumfragen im Gruppenchat (P3-05) */
  polls?: React.ReactNode;
  /** Schreiben nicht (mehr) möglich, z. B. wegen einer Moduleinstellung – Grund statt Eingabefeld */
  blocked?: string | null;
  /** fester Hinweis über dem Eingabefeld, z. B. „nur Terminabsprache“ bei Chats mit der Schulsozialarbeit (Q5-17) */
  notice?: string | null;
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [reads, setReads] = useState(initialReads);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [, start] = useTransition();
  const list = useRef<HTMLOListElement>(null);

  // Beim Öffnen gelesen markieren
  useEffect(() => {
    void markReadAction(room.id);
  }, [room.id]);

  // Immer ans Ende scrollen, wenn neue Nachrichten kommen
  useLayoutEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages.length]);

  useLive((m) => {
    if (m.type === "chat" && m.message.roomId === room.id) {
      setMessages((cur) => (cur.some((x) => x.id === m.message.id) ? cur : [...cur, m.message]));
      if (m.message.authorId !== me) void markReadAction(room.id);
    }
    if (m.type === "chat-read" && m.roomId === room.id && m.userId !== me) {
      setReads((cur) => [...cur.filter((r) => r.userId !== m.userId), { userId: m.userId, lastReadAt: m.lastReadAt }]);
    }
  });

  function send() {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    setError(undefined);
    start(async () => {
      const res = await sendMessageAction(room.id, body);
      if ("error" in res) {
        setError(res.error);
        setDraft(body);
      } else setMessages((cur) => (cur.some((x) => x.id === res.message.id) ? cur : [...cur, res.message]));
    });
  }

  // Lesestatus: letzte eigene Nachricht – im Direktchat „Gelesen", in Gruppen „Gelesen von n"
  const lastMine = [...messages].reverse().find((m) => m.authorId === me);
  const readers = lastMine ? reads.filter((r) => r.lastReadAt >= lastMine.createdAt).length : 0;

  return (
    <section aria-label={`Chat ${room.title}`} className="flex min-h-0 flex-col overflow-hidden rounded-card border border-border bg-surface">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Link href="/messenger" className="lg:hidden" aria-label="Zurück zur Chatliste">
          <ArrowLeft className="size-5" aria-hidden />
        </Link>
        <Avatar label={room.avatar} tone={room.kind === "group" ? "warn" : "soft"} />
        <span className="flex flex-col leading-tight">
          <h2 className="font-semibold">{room.title}</h2>
          {room.kind === "group" && <span className="text-xs text-muted">{room.memberCount} Mitglieder</span>}
        </span>
      </header>
      {polls}

      <ol ref={list} aria-label="Nachrichten" aria-live="polite" className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4 py-4">
        {messages.length === 0 && <li className="m-auto text-sm text-muted">Schreib die erste Nachricht.</li>}
        {messages.map((m, i) => {
          const mine = m.authorId === me;
          const prev = messages[i - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const showAuthor = room.kind === "group" && !mine && (prev?.authorId !== m.authorId || newDay);
          return (
            <li key={m.id} className="flex flex-col">
              {newDay && <span className="my-2 self-center rounded-full bg-surface-2 px-3 py-0.5 text-xs text-muted">{dayFmt.format(new Date(m.createdAt))}</span>}
              <div className={cn("flex max-w-[80%] flex-col", mine ? "self-end items-end" : "self-start items-start")}>
                {showAuthor && <span className="mb-0.5 px-1 text-xs font-medium text-muted">{m.authorName}</span>}
                <div className={cn("rounded-2xl px-3.5 py-2 whitespace-pre-wrap break-words", mine ? "rounded-br-md bg-accent text-accent-fg" : "rounded-bl-md bg-surface-2")}>
                  {m.body}
                  <span className={cn("ml-2 align-bottom text-[11px]", mine ? "text-accent-fg/80" : "text-muted")}>{time.format(new Date(m.createdAt))}</span>
                </div>
                {lastMine?.id === m.id && readers > 0 && (
                  <span className="mt-0.5 flex items-center gap-1 px-1 text-xs text-muted" data-testid="read-status">
                    <CheckCheck className="size-3.5" aria-hidden /> {room.kind === "direct" ? "Gelesen" : `Gelesen von ${readers}`}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {notice && (
        <p role="note" className="border-t border-border bg-surface-2 px-4 py-2 text-xs text-muted">
          {notice}.
        </p>
      )}
      {blocked ? (
        <p role="note" className="border-t border-border p-3 text-sm text-muted">
          {blocked}. Der bisherige Verlauf bleibt lesbar.
        </p>
      ) : (
        <form
          className="flex items-end gap-2 border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            maxLength={4000}
            placeholder="Nachricht schreiben …"
            aria-label="Nachricht"
            className="max-h-40 min-h-11 flex-1 resize-none rounded-xl border border-border bg-surface px-3 py-2.5 outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
          />
          <Button type="submit" variant="primary" size="icon" aria-label="Senden" disabled={!draft.trim()}>
            <SendHorizontal aria-hidden />
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="px-4 pb-3 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
