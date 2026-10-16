import { EventEmitter } from "node:events";

/**
 * Prozessinterner Event-Bus für Live-Updates (SSE). Reicht für eine Instanz;
 * bei mehreren Instanzen später durch Postgres LISTEN/NOTIFY ersetzen.
 */
export interface GongItem {
  id: string;
  moduleId: string;
  title: string;
  body: string | null;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface ChatMessageEvent {
  id: string;
  roomId: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string;
}

/** Schnellumfrage (P3-05): Stand für alle Mitglieder der Gruppe – ohne Angaben dazu, wer geantwortet hat */
export interface PollState {
  id: string;
  groupId: string;
  question: string;
  options: string[];
  closesAt: string;
  open: boolean;
  total: number;
  /** eingerechnete Antworten: volle Fünferschritte (anonym) */
  counted: number;
  /** Anzahl je Option über die eingerechneten Antworten – erst ab MIN_ANONYMOUS Antworten, sonst null */
  counts: number[] | null;
}

export type GongEvent = { type: "notification" | "read"; unread: number; notification?: GongItem };
export type ChatEvent = { type: "chat"; message: ChatMessageEvent } | { type: "chat-read"; roomId: string; userId: string; lastReadAt: string; unreadTotal?: number };
export type PollEvent = { type: "poll"; poll: PollState };
/** Pinnwand (P3-08) geändert – Clients laden die Ansicht neu (Inhalt prüft der Server je Person) */
export type BoardEvent = { type: "board"; boardId: string };
/**
 * Text (P3-11): Yjs-Update (Base64) an alle, die den Text gerade offen haben – nur Mitglieder der Gruppe (live.ts prüft
 * die Mitgliedschaft vor jedem Versand); `title`/`removed` nach Umbenennen bzw. Löschen.
 */
export type TextEvent = { type: "text"; docId: string; update?: string; title?: string; removed?: true };
/**
 * Tafel (P3-12): geänderte Excalidraw-Elemente (je Element die gewinnende Fassung) an alle, die die Tafel gerade offen
 * haben – nur Mitglieder der Gruppe (tafeln/live.ts prüft vor jedem Versand). `notSaved`: Speichern scheiterte am Kontingent
 * (true) bzw. gelingt wieder (false).
 */
export type TafelEvent = { type: "tafel"; boardId: string; elements: Record<string, unknown>[]; notSaved?: boolean };
export type LiveEvent = GongEvent | ChatEvent | PollEvent | BoardEvent | TextEvent | TafelEvent;

const g = globalThis as unknown as { __schulosBus?: EventEmitter };
// Über globalThis: Route-Handler und Server Actions liegen in getrennten Bundle-Schichten
// (eigene Modul-Instanzen) – sie müssen trotzdem denselben Bus sehen.
const bus = (g.__schulosBus ??= new EventEmitter().setMaxListeners(0));

export function publish(userId: string, event: LiveEvent): void {
  bus.emit(`user:${userId}`, event);
}

export function subscribe(userId: string, listener: (e: LiveEvent) => void): () => void {
  const key = `user:${userId}`;
  bus.on(key, listener);
  return () => bus.off(key, listener);
}

/**
 * Alle offenen Live-Ströme eines Benutzers sofort beenden (SEC-04): bei Sperre, Passwort-/2FA-Reset und Abmeldung. Der
 * Strom prüft die Sitzung zusätzlich bei jedem Ping – das hier schließt die Lücke bis dahin.
 */
export function endLiveStreams(userId: string): void {
  bus.emit(`end:${userId}`);
}

export function onEndLiveStreams(userId: string, listener: () => void): () => void {
  const key = `end:${userId}`;
  bus.on(key, listener);
  return () => bus.off(key, listener);
}
