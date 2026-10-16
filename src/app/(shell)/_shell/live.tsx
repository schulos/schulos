"use client";

import { useEffect, useRef } from "react";
import type { LiveEvent } from "@/core/notifications/bus";

/** `live-open`: die Verbindung steht (neu) – wer Zwischenstände verpasst haben könnte (Texte, Tafeln), gleicht jetzt ab. */
export type LiveMessage = { type: "hello"; unread: number } | { type: "live-open" } | LiveEvent;

const TYPES = ["hello", "notification", "read", "chat", "chat-read", "poll", "board", "text", "tafel"] as const;

/** EINE Server-Sent-Events-Verbindung pro Tab; verteilt die Ereignisse als Window-Events. */
export function LiveEvents() {
  useEffect(() => {
    const es = new EventSource("/api/gong/stream");
    const onOpen = () => window.dispatchEvent(new CustomEvent<LiveMessage>("schulos:live", { detail: { type: "live-open" } }));
    es.addEventListener("open", onOpen);
    const handlers = TYPES.map((type) => {
      const h = (e: MessageEvent) => {
        const data = JSON.parse(e.data) as Record<string, unknown>;
        window.dispatchEvent(new CustomEvent<LiveMessage>("schulos:live", { detail: { ...data, type } as LiveMessage }));
      };
      es.addEventListener(type, h);
      return [type, h] as const;
    });
    return () => {
      es.removeEventListener("open", onOpen);
      handlers.forEach(([t, h]) => es.removeEventListener(t, h));
      es.close();
    };
  }, []);
  return null;
}

/** Auf Live-Ereignisse reagieren. Der Handler darf sich bei jedem Render ändern. */
export function useLive(handler: (m: LiveMessage) => void) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const fn = (e: Event) => ref.current((e as CustomEvent<LiveMessage>).detail);
    window.addEventListener("schulos:live", fn);
    return () => window.removeEventListener("schulos:live", fn);
  }, []);
}
