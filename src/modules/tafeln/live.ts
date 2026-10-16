// Live-Abgleich der Tafeln (P3-12) – derselbe Weg wie bei den Texten (P3-11), ohne eigenen WebSocket-Dienst:
//
//   Browser ──POST /api/tafeln/[id]/update ({ elements: [...] }, nur geänderte)──▶ Server übernimmt je Element die höhere
//   Version (scene.ts), verteilt das tatsächlich Übernommene per SSE (`tafel`) an alle, die die Tafel offen haben, und
//   speichert die Datei verzögert (≤ 2 s nach der ersten ungesicherten Änderung).
//   Browser ──POST /api/tafeln/[id]/sync──▶ voller Stand (alle Elemente inkl. Grabsteine). Der Client gleicht ab und schickt
//   zurück, was bei ihm neuer ist (verlorener POST, Zeichnen ohne Verbindung).
//
// Warum das trotz Einwegkanal zuverlässig ist: der Abgleich je Element (höhere Version, sonst kleinere Nonce) ist
// kommutativ und idempotent – Reihenfolge und doppelte Zustellung sind egal; Verlorenes holt der nächste Sync (beim
// Verbindungsaufbau, beim Sichtbarwerden des Tabs, alle 2 Minuten).
//
// Gespeichert wird die ganze Szene als Datei im Gruppenordner. Jede Fassung bekommt einen neuen Speicherschlüssel; die
// Zeile in `file_nodes` wird nur umgestellt, wenn sie noch auf den Schlüssel zeigt, von dem dieser Prozess ausging
// (optimistische Sperre). Sonst hat ein anderer Prozess gespeichert: dessen Szene wird erst zusammengeführt und das Neue an
// die Anwesenden verteilt. Gelöscht (in Dateien) → aus dem Speicher nehmen, nichts wieder anlegen.
//
// Grenzen (melden statt umbauen): Update ≤ 512 KB und ≤ 2000 Elemente, Szene ≤ 4 MB (darüber nur Änderungen, die sie nicht
// vergrößern), Kontingent des Gruppenordners (P312-07), 600 Updates/min und 30 Syncs/min je Person und Tafel (der Client
// bündelt alle 250 ms), ~30 gleichzeitig: Hinweis. Höchstens 50 Tafeln bzw. 256 MB gleichzeitig im Speicher; darüber fallen
// die am längsten unbenutzten (gesicherten) heraus (P312-09). Ungültige Elemente (z. B. eingebettete Webseiten) werden
// einzeln verworfen und gezählt, der Rest des Updates gilt (P312-01).
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { fileNodes, groupMembers } from "@/core/db/schema";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import { publish } from "@/core/notifications/bus";
import { QUOTA, usage } from "@/modules/dateien/service";
import { elementBytes, elementId, isBoardName, MAX_VERSION_STEP, orderElements, parseScene, pruneTombstones, sanitizeElement, serializeScene, wins, type BoardElement } from "./scene";

export const LIMITS = {
  updateBytes: 512 * 1024,
  updateElements: 2000,
  sceneBytes: 4 * 1024 * 1024,
  updatesPerMinute: 600,
  syncsPerMinute: 30,
  editors: 30,
  presenceMs: 5 * 60_000,
  membersCacheMs: 30_000,
  saveDelayMs: 2_000,
  idleMs: 10 * 60_000,
  warnEveryMs: 10 * 60_000,
  sweepMs: 60_000,
  /** höchstens so viele Tafeln bzw. Bytes gleichzeitig im Speicher */
  loadedBoards: 50,
  loadedBytes: 256 * 1024 * 1024,
  /** Restplatz des Gruppenordners so lange zwischenspeichern */
  quotaCacheMs: 30_000,
  /** höchstens so weit darf eine Fassung die bekannte Version überspringen (G3B-02) */
  versionStep: MAX_VERSION_STEP,
};

/** JSON-Rahmen der Datei (ohne Elemente) – für die Größenrechnung */
const FRAME_BYTES = 200;

export interface OpenBoard {
  id: string;
  groupId: string;
  elements: Map<string, BoardElement>;
  /** Bytes je Element (JSON) – die Szenengröße ist damit jederzeit exakt */
  sizes: Map<string, number>;
  sizeBytes: number;
  background: string;
  /** Speicherschlüssel der Fassung, auf der dieser Stand beruht (optimistische Sperre) */
  storageKey: string;
  /** Größe der gespeicherten Fassung (zählt im Kontingent des Gruppenordners) */
  storedBytes: number;
  /** letzte Speicherung scheiterte am Kontingent – bis eine gelingt, keine Vergrößerung annehmen */
  overQuota: boolean;
  pending: number;
  saving: Promise<void> | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  lastAccess: number;
  present: Map<string, number>;
  members: { ids: Set<string>; until: number } | null;
  rate: Map<string, { start: number; count: number }>;
  warnedAt: number;
}

interface Store {
  boards: Map<string, OpenBoard>;
  /** Syncs je Person und Tafel (vor dem Laden geprüft) */
  syncRate: Map<string, { start: number; count: number }>;
  ctx: { db: Db; storage: FileStorage } | null;
  sweeper: ReturnType<typeof setInterval> | null;
  /**
   * Restplatz je Gruppenordner (G3B-03), zwischengespeichert: beim Ermitteln abzüglich des noch ungesicherten Wachstums
   * aller geladenen Tafeln der Gruppe, danach wird jedes angenommene Wachstum sofort abgezogen – so können zwei Tafeln
   * derselben Gruppe nicht beide denselben Rest verplanen.
   */
  quota: Map<string, { left: number; until: number }>;
}

const g = globalThis as unknown as { __schulosTafeln?: Store };
const store: Store = (g.__schulosTafeln ??= { boards: new Map(), syncRate: new Map(), ctx: null, sweeper: null, quota: new Map() });
store.syncRate ??= new Map(); // Hot-Reload aus einem älteren Stand
store.quota ??= new Map();

export type OpenError = "missing" | "too-large" | "invalid-file";
export type ApplyError = OpenError | "invalid" | "too-many" | "board-full" | "quota" | "rate";
/**
 * `dropped`: verworfene (ungültige) Elemente – der Rest des Updates wurde trotzdem übernommen; `droppedIds` deren Kennungen
 * (soweit brauchbar), damit der Client genau diese auf den Serverstand zurücksetzt (G3B-02).
 */
export type ApplyResult = { ok: true; editors: number; crowded: boolean; changed: number; dropped: number; droppedIds: string[] } | { ok: false; error: ApplyError };
export interface SyncResult {
  elements: BoardElement[];
  background: string;
  editors: number;
  crowded: boolean;
  /** letzte Speicherung scheiterte am Kontingent – Angenommenes liegt nur im Speicher (G3B-03) */
  notSaved: boolean;
}

/** Datei aus dem Speicher lesen – höchstens `max` Bytes (sonst null). */
export async function readStored(storage: FileStorage, key: string, max: number): Promise<string | null | "too-large"> {
  const stream = await storage.get(key);
  if (!stream) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return "too-large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function startSweeper() {
  if (store.sweeper) return;
  store.sweeper = setInterval(() => {
    if (store.ctx) void sweep(store.ctx.db, store.ctx.storage);
  }, LIMITS.sweepMs);
  store.sweeper.unref?.();
}

function setElement(ob: OpenBoard, el: BoardElement) {
  const bytes = elementBytes(el);
  ob.sizeBytes += bytes - (ob.sizes.get(el.id) ?? 0);
  ob.sizes.set(el.id, bytes);
  ob.elements.set(el.id, el);
}

/** Abgelaufene Grabsteine entfernen (Größe mitführen); liefert die Anzahl. */
function prune(ob: OpenBoard, now: number): number {
  const n = pruneTombstones(ob.elements, now);
  if (n) {
    for (const elId of [...ob.sizes.keys()]) {
      if (!ob.elements.has(elId)) {
        ob.sizeBytes -= ob.sizes.get(elId)!;
        ob.sizes.delete(elId);
      }
    }
  }
  return n;
}

const clean = (ob: OpenBoard) => ob.pending === 0 && !ob.saving && !ob.saveTimer;

/** Zu viele Tafeln im Speicher: die am längsten unbenutzten, gesicherten herausnehmen (P312-09). */
function evict(keep: string) {
  let bytes = 0;
  for (const ob of store.boards.values()) bytes += ob.sizeBytes;
  const over = () => store.boards.size > LIMITS.loadedBoards || bytes > LIMITS.loadedBytes;
  if (!over()) return;
  const lru = [...store.boards.values()].filter((ob) => ob.id !== keep && clean(ob)).sort((a, b) => a.lastAccess - b.lastAccess);
  for (const ob of lru) {
    if (!over()) return;
    bytes -= ob.sizeBytes;
    forgetBoard(ob.id);
  }
  if (over()) console.warn(`[tafeln] ${store.boards.size} Tafeln (${Math.round(bytes / 1024 / 1024)} MB) im Speicher, keine weitere gesichert – Grenze vorübergehend überschritten`);
}

/** Tafel in den Speicher laden (oder die geladene liefern). */
export async function openBoard(db: Db, storage: FileStorage, id: string, now = Date.now()): Promise<OpenBoard | OpenError> {
  store.ctx = { db, storage };
  startSweeper();
  const have = store.boards.get(id);
  if (have) {
    have.lastAccess = now;
    return have;
  }
  const [row] = await db.select({ groupId: fileNodes.groupId, name: fileNodes.name, storageKey: fileNodes.storageKey, size: fileNodes.size }).from(fileNodes).where(eq(fileNodes.id, id));
  if (!row?.groupId || !row.storageKey || !isBoardName(row.name)) return "missing";
  const text = await readStored(storage, row.storageKey, LIMITS.sceneBytes);
  if (text === "too-large") return "too-large";
  const scene = parseScene(text ?? "");
  if (!scene) return "invalid-file";
  const raced = store.boards.get(id);
  if (raced) return raced;
  const ob: OpenBoard = {
    id,
    groupId: row.groupId,
    elements: new Map(),
    sizes: new Map(),
    sizeBytes: FRAME_BYTES,
    background: scene.background,
    storageKey: row.storageKey,
    storedBytes: Number(row.size ?? 0),
    overQuota: false,
    pending: 0,
    saving: null,
    saveTimer: null,
    lastAccess: now,
    present: new Map(),
    members: null,
    rate: new Map(),
    warnedAt: 0,
  };
  // Aufräumen beim Öffnen (P312-03/06): Grabsteine aus älteren Dateien tragen evtl. noch Inhalt oder eine Client-Uhrzeit
  // (fehlend/in der Zukunft) – auf die Serverzeit setzen, damit sie sicher ablaufen; dann neu speichern.
  let cleaned = scene.thinned;
  for (const el of scene.elements) {
    if (el.isDeleted && (typeof el.updated !== "number" || el.updated > now)) {
      el.updated = now;
      cleaned++;
    }
    setElement(ob, el);
  }
  cleaned += prune(ob, now);
  store.boards.set(id, ob);
  evict(id);
  if (cleaned) {
    ob.pending += 1;
    scheduleSave(db, storage, ob);
  }
  return ob;
}

function seen(ob: OpenBoard, userId: string, now: number): { editors: number; crowded: boolean } {
  ob.present.set(userId, now);
  for (const [u, t] of ob.present) if (t < now - LIMITS.presenceMs) ob.present.delete(u);
  const editors = ob.present.size;
  const crowded = editors > LIMITS.editors;
  if (crowded && now - ob.warnedAt > LIMITS.warnEveryMs) {
    ob.warnedAt = now;
    console.warn(`[tafeln] ${editors} Personen bearbeiten gleichzeitig die Tafel ${ob.id} – ausgelegt ist das Modul für etwa ${LIMITS.editors} (P3-12: melden statt umbauen)`);
  }
  return { editors, crowded };
}

function counted(rate: Map<string, { start: number; count: number }>, key: string, now: number, max: number): boolean {
  const r = rate.get(key);
  if (!r || now - r.start >= 60_000) {
    rate.set(key, { start: now, count: 1 });
    return true;
  }
  r.count += 1;
  return r.count <= max;
}

const rateOk = (ob: OpenBoard, userId: string, now: number) => counted(ob.rate, userId, now, LIMITS.updatesPerMinute);

/**
 * Passt `growth` Bytes mehr noch ins Kontingent des Gruppenordners? Ja → sofort vom Restplatz der Gruppe abziehen (G3B-03).
 * Restplatz = Kontingent − gespeicherte Dateien − ungesichertes Wachstum aller geladenen Tafeln der Gruppe.
 */
async function quotaOk(db: Db, ob: OpenBoard, growth: number, now: number): Promise<boolean> {
  let q = store.quota.get(ob.groupId);
  if (!q || q.until < now) {
    const used = await usage(db, { kind: "group", groupId: ob.groupId });
    let unsaved = 0;
    for (const b of store.boards.values()) if (b.groupId === ob.groupId) unsaved += Math.max(0, b.sizeBytes - b.storedBytes);
    q = { left: QUOTA.group - used - unsaved, until: now + LIMITS.quotaCacheMs };
    store.quota.set(ob.groupId, q);
  }
  if (growth > q.left) return false;
  q.left -= growth;
  return true;
}

async function recipients(db: Db, ob: OpenBoard, now: number): Promise<string[]> {
  if (!ob.members || ob.members.until < now) {
    const rows = await db.select({ id: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, ob.groupId));
    ob.members = { ids: new Set(rows.map((r) => r.id)), until: now + LIMITS.membersCacheMs };
  }
  const out: string[] = [];
  for (const [u, t] of ob.present) if (t >= now - LIMITS.presenceMs && ob.members.ids.has(u)) out.push(u);
  return out;
}

async function broadcast(db: Db, ob: OpenBoard, elements: BoardElement[], now: number) {
  if (elements.length === 0) return;
  for (const u of await recipients(db, ob, now)) publish(u, { type: "tafel", boardId: ob.id, elements });
}

/** Anwesenden melden, dass die Tafel (nicht mehr) nur im Speicher liegt – Speichern am Kontingent gescheitert (G3B-03). */
async function announce(db: Db, ob: OpenBoard, notSaved: boolean) {
  for (const u of await recipients(db, ob, Date.now())) publish(u, { type: "tafel", boardId: ob.id, elements: [], notSaved });
}

function scheduleSave(db: Db, storage: FileStorage, ob: OpenBoard) {
  if (ob.saveTimer) return;
  ob.saveTimer = setTimeout(() => {
    ob.saveTimer = null;
    void saveBoard(db, storage, ob);
  }, LIMITS.saveDelayMs);
  ob.saveTimer.unref?.();
}

/** Geänderte Elemente eines Clients übernehmen. Rechte (Mitglied, Gruppenordner, nicht archiviert) prüft der Aufrufer. */
export async function applyBoardUpdate(db: Db, storage: FileStorage, id: string, userId: string, raw: unknown, now = Date.now()): Promise<ApplyResult> {
  const ob = await openBoard(db, storage, id, now);
  if (typeof ob === "string") return { ok: false, error: ob };
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "invalid" };
  if (raw.length > LIMITS.updateElements) return { ok: false, error: "too-many" };
  // Ungültiges einzeln verwerfen (P312-01): ein unerlaubtes Element (Web-Einbettung, Bild aus der Bibliothek) soll die
  // übrigen Änderungen nicht mitreißen
  // Versionssprung begrenzt (G3B-02): sonst könnte jemand ein Element bis an die Obergrenze treiben, sodass es niemand mehr
  // ändern oder löschen kann
  const incoming: BoardElement[] = [];
  const droppedIds: string[] = [];
  let dropped = 0;
  for (const r of raw) {
    const el = sanitizeElement(r);
    if (el && el.version <= (ob.elements.get(el.id)?.version ?? 0) + LIMITS.versionStep) incoming.push(el);
    else {
      dropped++;
      const elId = elementId(r);
      if (elId) droppedIds.push(elId);
    }
  }
  if (!rateOk(ob, userId, now)) return { ok: false, error: "rate" };
  const presence = seen(ob, userId, now);
  // nur, was gewinnt (bei mehrfach genannter id die stärkste Fassung); unbekannte Grabsteine legen nichts an
  const winners = new Map<string, BoardElement>();
  for (const el of incoming) {
    const cur = winners.get(el.id) ?? ob.elements.get(el.id);
    if (!cur && el.isDeleted) continue;
    if (wins(el, cur)) winners.set(el.id, el);
  }
  const changed = [...winners.values()];
  if (changed.length === 0) return { ok: true, ...presence, changed: 0, dropped, droppedIds };
  // Zeitstempel vom Server (P312-06): die Ablaufzeit der Grabsteine hängt daran, nicht an der Uhr des Clients
  for (const el of changed) el.updated = now;
  // volle Tafel: über der Grenze nur, was sie nicht vergrößert (Löschen, Verkleinern); ebenso beim Kontingent
  let projected = ob.sizeBytes;
  for (const el of changed) projected += elementBytes(el) - (ob.sizes.get(el.id) ?? 0);
  if (projected > ob.sizeBytes) {
    if (projected > LIMITS.sceneBytes) return { ok: false, error: "board-full" };
    if (ob.overQuota || !(await quotaOk(db, ob, projected - ob.sizeBytes, now))) return { ok: false, error: "quota" };
  }
  for (const el of changed) setElement(ob, el);
  ob.pending += 1;
  await broadcast(db, ob, changed, now);
  scheduleSave(db, storage, ob);
  return { ok: true, ...presence, changed: changed.length, dropped, droppedIds };
}

/** Voller Stand für Öffnen und Wiederverbindung (alle Elemente inkl. Grabsteine, in Zeichenreihenfolge). */
export async function syncBoard(db: Db, storage: FileStorage, id: string, userId: string, now = Date.now()): Promise<SyncResult | OpenError | "rate"> {
  // vor dem Laden zählen (P312-09): jeder Sync serialisiert bis zu 4 MB
  if (!counted(store.syncRate, `${userId} ${id}`, now, LIMITS.syncsPerMinute)) return "rate";
  const ob = await openBoard(db, storage, id, now);
  if (typeof ob === "string") return ob;
  return { elements: orderElements(ob.elements.values()), background: ob.background, ...seen(ob, userId, now), notSaved: ob.overQuota };
}

/**
 * Szene speichern: neue Fassung unter neuem Schlüssel, Zeile nur umstellen, wenn sie noch auf unseren Schlüssel zeigt.
 * Sonst die fremde Fassung zusammenführen (und das Neue verteilen), dann erneut.
 */
export async function saveBoard(db: Db, storage: FileStorage, ob: OpenBoard): Promise<void> {
  if (ob.saving) return ob.saving;
  ob.saving = (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = ob.pending;
      prune(ob, Date.now());
      const data = new TextEncoder().encode(serializeScene(ob.elements.values(), ob.background));
      const key = newStorageKey();
      await storage.put(key, data);
      const result = await db.transaction(async (raw) => {
        const tx = raw as unknown as Db;
        // Kontingent wie beim Hochladen (P312-07): unter derselben Sperre wie dateien/uploadFile prüfen
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`dateien:group:${ob.groupId}`}))`);
        const [cur] = await tx.select({ storageKey: fileNodes.storageKey, size: fileNodes.size }).from(fileNodes).where(eq(fileNodes.id, ob.id));
        if (!cur || cur.storageKey !== ob.storageKey) return "moved" as const;
        const growth = data.byteLength - Number(cur.size ?? 0);
        if (growth > 0 && (await usage(tx, { kind: "group", groupId: ob.groupId })) + growth > QUOTA.group) return "quota" as const;
        const rows = await tx
          .update(fileNodes)
          .set({ storageKey: key, size: data.byteLength, updatedAt: new Date() })
          .where(and(eq(fileNodes.id, ob.id), eq(fileNodes.storageKey, ob.storageKey)))
          .returning({ id: fileNodes.id });
        return rows.length ? ("saved" as const) : ("moved" as const);
      });
      if (result === "saved") {
        const old = ob.storageKey;
        ob.storageKey = key;
        ob.storedBytes = data.byteLength;
        store.quota.delete(ob.groupId);
        const was = ob.overQuota;
        ob.overQuota = false;
        if (was) await announce(db, ob, false);
        ob.pending -= before;
        await storage.delete(old);
        if (ob.pending > 0) scheduleSave(db, storage, ob);
        return;
      }
      await storage.delete(key);
      if (result === "quota") {
        const first = !ob.overQuota;
        ob.overQuota = true;
        store.quota.delete(ob.groupId);
        if (first) {
          console.warn(`[tafeln] Tafel ${ob.id} nicht gespeichert: Kontingent des Gruppenordners erschöpft – Vergrößerungen werden abgelehnt, bis aufgeräumt ist`);
          // den Anwesenden sagen, dass „Gespeichert“ nicht mehr stimmt (G3B-03)
          await announce(db, ob, true);
        }
        return;
      }
      const [row] = await db.select({ storageKey: fileNodes.storageKey, name: fileNodes.name }).from(fileNodes).where(eq(fileNodes.id, ob.id));
      if (!row?.storageKey || !isBoardName(row.name)) {
        forgetBoard(ob.id); // inzwischen gelöscht (bzw. umbenannt, sodass es keine Tafel mehr ist)
        return;
      }
      const text = await readStored(storage, row.storageKey, LIMITS.sceneBytes * 2);
      const theirs = typeof text === "string" ? parseScene(text) : null;
      if (theirs) {
        const fresh: BoardElement[] = [];
        for (const el of theirs.elements) {
          const cur = ob.elements.get(el.id);
          if ((cur || !el.isDeleted) && wins(el, cur)) {
            setElement(ob, el);
            fresh.push(el);
          }
        }
        await broadcast(db, ob, fresh, Date.now());
      }
      ob.storageKey = row.storageKey;
    }
    console.warn(`[tafeln] Speichern von ${ob.id} nach 4 Anläufen nicht gelungen – nächster Versuch beim nächsten Update`);
  })().finally(() => {
    ob.saving = null;
  });
  return ob.saving;
}

/** Ungesichertes sofort schreiben (Tests; Aufräumen). */
export async function flushBoards(db: Db, storage: FileStorage, id?: string): Promise<void> {
  for (const ob of store.boards.values()) {
    if (id && ob.id !== id) continue;
    if (ob.saveTimer) {
      clearTimeout(ob.saveTimer);
      ob.saveTimer = null;
    }
    if (ob.saving) await ob.saving;
    for (let i = 0; i < 3 && ob.pending > 0; i++) await saveBoard(db, storage, ob);
    // Gesichert, aber die Zeile ist inzwischen weg (Löschen in Dateien direkt nach dem letzten Speichern – saveBoard merkt das
    // nur, wenn es noch etwas zu schreiben gibt): dann auch aus dem Speicher nehmen, statt bis zum Leerlauf-Takt zu warten
    if (ob.pending === 0 && !ob.saving) {
      const [row] = await db.select({ storageKey: fileNodes.storageKey, name: fileNodes.name }).from(fileNodes).where(eq(fileNodes.id, ob.id));
      if (!row?.storageKey || !isBoardName(row.name)) forgetBoard(ob.id);
    }
  }
}

export function forgetBoard(id: string): void {
  const ob = store.boards.get(id);
  if (!ob) return;
  if (ob.saveTimer) clearTimeout(ob.saveTimer);
  store.boards.delete(id);
}

/** Takt: abgelaufene Grabsteine entfernen, Ungesichertes speichern, lange nicht genutzte Tafeln aus dem Speicher nehmen. */
export async function sweep(db: Db, storage: FileStorage, now = Date.now()): Promise<void> {
  for (const [key, r] of store.syncRate) if (now - r.start >= 60_000) store.syncRate.delete(key);
  for (const ob of [...store.boards.values()]) {
    if (prune(ob, now)) ob.pending += 1;
    if (ob.pending > 0 && !ob.saving && !ob.saveTimer) await saveBoard(db, storage, ob);
    if (clean(ob) && now - ob.lastAccess > LIMITS.idleMs) forgetBoard(ob.id);
  }
}

export function openBoardIds(): string[] {
  return [...store.boards.keys()];
}

