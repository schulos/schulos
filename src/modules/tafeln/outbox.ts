// Tafeln (P3-12) – Sendelogik des Browsers, rein (ohne React/Excalidraw), damit sie sich mit Vitest testen lässt
// (Review P312-01/02/04/05). board.tsx hängt sie an Excalidraw an.
//
// `known` hält fest, welche Fassung der Server von jedem Element hat; was lokal gewinnt, geht beim nächsten Bündeln raus.
// Gebündelt wird nach Anzahl UND Bytes (der Server nimmt ≤ 512 KB je Update), der Rest folgt sofort im nächsten POST.
// Was während eines laufenden POST entsteht, geht danach raus (neu berechnet, nicht aus dem alten Stand).
// Lehnt der Server ein Bündel endgültig ab (400/413/422 – zu groß, Tafel voll, Kontingent), verstummt der Client nicht: die
// abgelehnten Fassungen werden gemerkt (nicht erneut gesendet), board.tsx holt für sie den Serverstand zurück und zeigt den
// Grund; alles, was danach geändert wird, geht wieder normal raus.
import { ELEMENT_TYPES } from "./scene";

export type Ver = { version: number; versionNonce: number };
export interface SyncEl extends Ver {
  id: string;
  type: string;
  isDeleted: boolean;
  fileId?: unknown;
}

/** gewinnt `a` gegen `b`? (höhere Version, bei Gleichstand kleinere Nonce – wie scene.ts und Excalidraw) */
export const beats = (a: Ver, b: Ver | undefined): boolean => !b || a.version > b.version || (a.version === b.version && a.versionNonce < b.versionNonce);
export const ver = (e: Ver): Ver => ({ version: e.version, versionNonce: e.versionNonce });

/** Darf das Element auf die Tafel? (wie sanitizeElement auf dem Server: keine Bilder, keine eingebetteten Webseiten) */
export const allowedElement = (el: Pick<SyncEl, "type" | "fileId">): boolean => ELEMENT_TYPES.has(el.type) && el.fileId == null;

/** Elemente ohne die unerlaubten (Web-Einbettung, Bilder aus der Bibliothek); null = nichts zu entfernen. */
export function stripDisallowed<T extends Pick<SyncEl, "type" | "fileId">>(elements: readonly T[]): T[] | null {
  const kept = elements.filter(allowedElement);
  return kept.length === elements.length ? null : kept;
}

export function resetKnown(known: Map<string, Ver>, elements: readonly SyncEl[]): void {
  known.clear();
  for (const e of elements) known.set(e.id, ver(e));
}

export function learnKnown(known: Map<string, Ver>, elements: readonly SyncEl[]): void {
  for (const e of elements) if (beats(e, known.get(e.id))) known.set(e.id, ver(e));
}

/**
 * Was lokal neuer ist als beim Server. Nicht: unerlaubte Elemente, unbekannte Grabsteine (da gibt es nichts zu löschen) und
 * Fassungen, die der Server schon einmal endgültig abgelehnt hat.
 */
export function pendingElements<T extends SyncEl>(elements: readonly T[], known: ReadonlyMap<string, Ver>, rejected?: ReadonlyMap<string, Ver>): T[] {
  return elements.filter((el) => {
    if (!allowedElement(el)) return false;
    const r = rejected?.get(el.id);
    if (r && !beats(el, r)) return false;
    const k = known.get(el.id);
    return k ? beats(el, k) : !el.isDeleted;
  });
}

const utf8 = new TextEncoder();

/**
 * Bündel schneiden: höchstens `maxCount` Elemente und `maxBytes` Bytes Body (mindestens ein Element – ist schon das allein zu
 * groß, lehnt der Server es ab und es wird zurückgenommen). Der Body wird hier gebaut, solange die Elemente noch den Stand
 * haben, der rausgeht (Excalidraw ändert Elemente an Ort und Stelle).
 */
export function takeBatch<T>(elements: readonly T[], maxCount: number, maxBytes: number): { batch: T[]; body: string; more: boolean } {
  const head = '{"elements":[';
  const parts: string[] = [];
  let bytes = utf8.encode(head).length + 2;
  for (const el of elements) {
    if (parts.length >= maxCount) break;
    const part = JSON.stringify(el);
    const size = utf8.encode(part).length + (parts.length ? 1 : 0);
    if (parts.length && bytes + size > maxBytes) break;
    parts.push(part);
    bytes += size;
  }
  return { batch: elements.slice(0, parts.length), body: `${head}${parts.join(",")}]}`, more: parts.length < elements.length };
}

/** Lokale Elemente: die mit `ids` durch die Serverfassung ersetzen bzw. entfernen, wenn der Server sie nicht hat. */
export function revertElements<T extends { id: string }>(local: readonly T[], remote: readonly T[], ids: ReadonlySet<string>): T[] {
  const theirs = new Map(remote.filter((e) => ids.has(e.id)).map((e) => [e.id, e]));
  const out: T[] = [];
  for (const el of local) {
    if (!ids.has(el.id)) out.push(el);
    else if (theirs.has(el.id)) out.push(theirs.get(el.id)!);
  }
  return out;
}

/** Hinweis, wenn der Server einzelne Elemente nicht übernommen hat (neutral – der Grund ist dem Client nicht bekannt) */
export const DROPPED_MESSAGE = "Einige Elemente wurden vom Server nicht übernommen";

/**
 * Elemente mit Excalidraws `restoreElements` übernehmen, ohne dass ein kaputtes Element alles mitreißt (G3B-01):
 * `restore` wirft für das ganze Array, wenn ein Element einen unerwarteten Typ hat. Dann jedes einzeln probieren, die
 * defekten verwerfen und den Rest gemeinsam wiederherstellen (Reihenfolge/Indizes wie beim normalen Aufruf).
 */
export function restoreSafely<T, R>(items: readonly T[], restore: (items: T[]) => R[]): { elements: R[]; dropped: T[] } {
  try {
    return { elements: restore([...items]), dropped: [] };
  } catch {
    // unten einzeln
  }
  const ok: T[] = [];
  const dropped: T[] = [];
  for (const item of items) {
    try {
      restore([item]);
      ok.push(item);
    } catch {
      dropped.push(item);
    }
  }
  try {
    return { elements: restore(ok), dropped };
  } catch {
    return { elements: [], dropped: [...items] };
  }
}

/**
 * Elemente, die auf den Serverstand zurückgesetzt werden müssen (G3B-04): bleiben vorgemerkt, bis ein Sync gelungen ist –
 * scheitert der erste (429, Netz, 5xx), nimmt der nächste (Heartbeat, Verbindungsaufbau, Sichtbarwerden) sie mit.
 */
export class RevertQueue {
  private readonly ids = new Set<string>();
  add(ids: Iterable<string>): void {
    for (const id of ids) this.ids.add(id);
  }
  /** Momentaufnahme für einen Sync; undefined = nichts vorgemerkt */
  take(): ReadonlySet<string> | undefined {
    return this.ids.size ? new Set(this.ids) : undefined;
  }
  /** Sync mit dieser Momentaufnahme gelungen – erst jetzt vergessen (inzwischen Hinzugekommenes bleibt) */
  done(taken: ReadonlySet<string> | undefined): void {
    if (taken) for (const id of taken) this.ids.delete(id);
  }
  get size(): number {
    return this.ids.size;
  }
}

export const OUTBOX = {
  flushMs: 250,
  maxBackoffMs: 10_000,
  /** wie LIMITS.updateElements auf dem Server */
  maxCount: 2000,
  /** Server: 512 KB + 1 KB Rahmen – mit Abstand darunter */
  maxBytes: 400 * 1024,
  /** keepalive-Anfragen dürfen höchstens ~64 KB haben */
  keepaliveBytes: 60 * 1024,
};

export type OutboxEvent =
  | { kind: "sending" }
  | { kind: "reply"; editors: number; crowded: boolean; dropped: number }
  | { kind: "synced" }
  | { kind: "offline" }
  | { kind: "readonly" }
  | { kind: "removed" }
  | { kind: "rejected"; error: string; ids: string[] };

export interface OutboxDeps {
  /** alle Elemente der Szene inkl. gelöschter */
  elements(): readonly SyncEl[];
  send(body: string, keepalive: boolean): Promise<{ status: number; json: () => Promise<unknown> }>;
  emit(e: OutboxEvent): void;
}

export class Outbox {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private backoff = OUTBOX.flushMs;
  private stopped = false;
  /** Server hat endgültig „nein“ gesagt (Nur lesen, gelöscht) – nichts mehr senden, auch nicht beim Verlassen */
  private dead = false;
  /** endgültig abgelehnte Fassungen (bis das Element sich wieder ändert) */
  readonly rejected = new Map<string, Ver>();

  constructor(
    private readonly deps: OutboxDeps,
    readonly known: Map<string, Ver> = new Map(),
  ) {}

  /** Nach dem Zurücknehmen (Serverstand übernommen): ab jetzt zählt wieder jede neue Fassung dieser Elemente. */
  forgetRejected(ids: Iterable<string>): void {
    for (const id of ids) this.rejected.delete(id);
  }

  pending(): SyncEl[] {
    return pendingElements(this.deps.elements(), this.known, this.rejected);
  }

  schedule(ms: number = OUTBOX.flushMs): void {
    if (this.timer || this.stopped || this.dead) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  async flush(): Promise<void> {
    // läuft schon ein POST, entscheidet dessen Ende anhand des dann aktuellen Stands, ob noch etwas rausmuss (P312-02)
    if (this.inflight || this.stopped || this.dead) return;
    const all = this.pending();
    if (all.length === 0) {
      this.deps.emit({ kind: "synced" });
      return;
    }
    const { batch, body } = takeBatch(all, OUTBOX.maxCount, OUTBOX.maxBytes);
    const sent = batch.map((el) => [el.id, ver(el)] as const);
    this.inflight = true;
    this.deps.emit({ kind: "sending" });
    let next: number | null = null;
    try {
      const res = await this.deps.send(body, false);
      if (res.status >= 200 && res.status < 300) {
        const j = (await res.json().catch(() => ({}))) as { editors?: number; crowded?: boolean; dropped?: number; droppedIds?: unknown };
        // vom Server einzeln verworfene Fassungen (G3B-02): nicht als angekommen merken, sondern wie eine Ablehnung behandeln –
        // board.tsx holt für sie den Serverstand zurück
        const sentIds = new Set(sent.map(([id]) => id));
        const droppedIds = new Set(Array.isArray(j.droppedIds) ? j.droppedIds.filter((id): id is string => typeof id === "string" && sentIds.has(id)) : []);
        for (const [id, v] of sent) {
          if (droppedIds.has(id)) this.rejected.set(id, v);
          else if (beats(v, this.known.get(id))) this.known.set(id, v);
        }
        this.backoff = OUTBOX.flushMs;
        this.deps.emit({ kind: "reply", editors: j.editors ?? 1, crowded: !!j.crowded, dropped: Math.max(0, (j.dropped ?? 0) - droppedIds.size) });
        if (droppedIds.size) this.deps.emit({ kind: "rejected", error: DROPPED_MESSAGE, ids: [...droppedIds] });
        next = 0;
      } else if (res.status === 403) {
        this.dead = true;
        this.deps.emit({ kind: "readonly" });
      } else if (res.status === 404) {
        this.dead = true;
        this.deps.emit({ kind: "removed" });
      } else if (res.status === 400 || res.status === 413 || res.status === 422) {
        // endgültig abgelehnt: diese Fassungen nicht wiederholen, aber weiter senden, was danach kommt (P312-01/04)
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        for (const [id, v] of sent) this.rejected.set(id, v);
        this.deps.emit({ kind: "rejected", error: j.error ?? "Die Änderung wurde abgelehnt.", ids: sent.map(([id]) => id) });
        next = 0;
      } else {
        this.deps.emit({ kind: "offline" });
        this.backoff = Math.min(this.backoff * 2, OUTBOX.maxBackoffMs);
        next = this.backoff;
      }
    } catch {
      this.deps.emit({ kind: "offline" });
      this.backoff = Math.min(this.backoff * 2, OUTBOX.maxBackoffMs);
      next = this.backoff;
    } finally {
      this.inflight = false;
    }
    if (next === 0) {
      if (this.pending().length) this.schedule(0);
      else this.deps.emit({ kind: "synced" });
    } else if (next !== null) this.schedule(next);
  }

  /** Rest sofort mit keepalive rausschicken (Tab schließt, Seite wird verlassen); ein Bündel, höchstens ~60 KB. */
  sendRest(): void {
    if (this.dead) return;
    const rest = this.pending();
    if (!rest.length) return;
    const { body } = takeBatch(rest, OUTBOX.maxCount, OUTBOX.keepaliveBytes);
    void this.deps.send(body, true).catch(() => {});
  }

  /** Abbauen (Verlassen per SPA-Navigation, Neustart des Effekts): erst den Rest senden, dann anhalten (P312-05). */
  close(): void {
    if (!this.stopped) this.sendRest();
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
