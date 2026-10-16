import { onEndLiveStreams, subscribe, type LiveEvent } from "./bus";

export interface LiveStreamOptions {
  userId: string;
  unread: number;
  /** Sitzung noch gültig und Konto nutzbar? (nach Sperre, Passwort-/2FA-Reset, Abmeldung nicht mehr) */
  stillValid: () => Promise<boolean>;
  signal?: AbortSignal;
  /** Ping + erneute Prüfung der Sitzung */
  pingMs?: number;
  /** Höchstdauer eines Stroms – danach verbindet der Browser neu und wird dabei neu geprüft */
  maxMs?: number;
}

/**
 * SSE-Strom für einen Benutzer (Gong, Chat, Umfragen, Pinnwände). SEC-04: Die Sitzung wird nicht nur beim Aufbau geprüft,
 * sondern bei jedem Ping erneut – nach Sperre, Passwort- oder 2FA-Reset und Abmeldung endet der Strom spätestens nach
 * einem Ping-Abstand; Sperre/Reset/Abmeldung beenden ihn über `endLiveStreams` sofort. Zusätzlich eine Höchstdauer.
 */
export function liveStream({ userId, unread, stillValid, signal, pingMs = 25_000, maxMs = 15 * 60_000 }: LiveStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const send = (event: string, data: unknown) => enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("hello", { unread });
      const off = subscribe(userId, (e: LiveEvent) => send(e.type, e));
      const offEnd = onEndLiveStreams(userId, () => cleanup());
      // Proxies schließen stille Verbindungen – regelmäßig ein Kommentar; dabei die Sitzung neu prüfen.
      const ping = setInterval(() => {
        void stillValid().then(
          (ok) => (ok ? enqueue(": ping\n\n") : cleanup()),
          () => cleanup(),
        );
      }, pingMs);
      const limit = setTimeout(() => cleanup(), maxMs);
      cleanup = () => {
        if (closed) return;
        closed = true;
        off();
        offEnd();
        clearInterval(ping);
        clearTimeout(limit);
        try {
          controller.close();
        } catch {
          // schon zu
        }
      };
      signal?.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });
}
