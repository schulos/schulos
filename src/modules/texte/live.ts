// Live-Abgleich der Texte (P3-11) – ohne eigenen WebSocket-Dienst (Entscheidung Projektleitung, PHASE4 §4.2):
//
//   Browser ──POST /api/texte/[id]/update (Yjs-Update, Base64)──▶ Server wendet an, verteilt per SSE (`text`) an alle,
//   die den Text gerade offen haben, und speichert den Stand verzögert (≤ 2 s nach der ersten ungesicherten Änderung).
//   Browser ──POST /api/texte/[id]/sync (eigener Zustandsvektor)──▶ bekommt genau das, was ihm fehlt (Yjs-Diff), und den
//   Zustandsvektor des Servers, um umgekehrt nachzuliefern, was dem Server fehlt (Sync-Schritte 1+2 aus y-protocols).
//
// Warum das trotz Einwegkanal zuverlässig ist: Yjs ist eine CRDT – Updates sind kommutativ und idempotent. Reihenfolge
// ist egal, doppelte Anwendung ist wirkungslos, und ein verlorenes Update (POST gescheitert, Lücke im SSE-Strom) holt
// der nächste Sync über den Zustandsvektor nach (beim Verbindungsaufbau, beim Sichtbarwerden des Tabs, alle 2 Minuten).
// Der Browser puffert ungesendete Updates und schickt sie mit Backoff erneut.
//
// Ein Yjs-Dokument je Text lebt im Speicher dieses Prozesses (globalThis – Route-Handler und Server Actions sind getrennte
// Bundle-Schichten, `yjs` ist in next.config.ts als externes Paket nur einmal geladen). Persistiert wird der volle Stand
// (kein Update-Protokoll): Yjs räumt gelöschten Inhalt beim Kodieren selbst weg (gc), eine Kompaktierung findet also mit
// jedem Speichern statt. Beim Speichern prüft eine Versionsnummer, ob ein anderer Prozess inzwischen gespeichert hat –
// dann wird dessen Stand erst zusammengeführt (CRDT, verlustfrei) und dann geschrieben. Mehrere App-Prozesse sind damit
// für die *Daten* sicher; der Live-Bus ist wie bei Chat und Pinnwänden prozesslokal (bus.ts) – Änderungen aus einem
// anderen Prozess kommen bei den Clients spätestens mit dem nächsten Sync an.
//
// Grenzen (Meldung statt Umbau): Updates ≤ 256 KB, Dokument ≤ 4 MB (darüber nur noch kleine Updates, die den Stand nicht
// vergrößern – Löschen), 240 Updates/min je Person und Text, ~30 gleichzeitig Bearbeitende: darüber ein Hinweis im Log und
// im Editor. Updates ohne Wirkung (alles schon bekannt) zählen nicht als Änderung – weder Broadcast noch Speichern.
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import type { Db } from "@/core/db/client";
import { groupMembers, textDocs } from "@/core/db/schema";
import { publish } from "@/core/notifications/bus";

export const LIMITS = {
  /** Höchstgröße eines einzelnen Updates */
  updateBytes: 256 * 1024,
  /** Höchstgröße des gespeicherten Stands; darüber nur noch kleine Updates (Löschen) */
  docBytes: 4 * 1024 * 1024,
  smallUpdateBytes: 2048,
  /** Updates je Person und Text im Minutenfenster (Tastatur-Debounce des Editors: höchstens ~200/min) */
  updatesPerMinute: 240,
  /** ausgelegt für etwa so viele gleichzeitig – darüber Meldung */
  editors: 30,
  /** wer sich so lange nicht gemeldet hat (Update, Sync alle 2 min), gilt als weg */
  presenceMs: 5 * 60_000,
  membersCacheMs: 30_000,
  /** Speichern spätestens so lange nach der ersten ungesicherten Änderung */
  saveDelayMs: 2_000,
  /** gespeicherte Texte ohne Zugriff so lange im Speicher halten */
  idleMs: 10 * 60_000,
  warnEveryMs: 10 * 60_000,
  sweepMs: 60_000,
};

export interface OpenDoc {
  id: string;
  groupId: string;
  doc: Y.Doc;
  /** Version der Zeile, auf der der geladene Stand beruht (optimistische Sperre) */
  version: number;
  /** Updates seit dem letzten erfolgreichen Speichern */
  pending: number;
  /** Größe des Stands (beim Speichern gemessen, dazwischen um die Updates hochgeschätzt) */
  sizeBytes: number;
  saving: Promise<void> | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  lastAccess: number;
  /** Anwesenheit: Person → zuletzt gesehen */
  present: Map<string, number>;
  members: { ids: Set<string>; until: number } | null;
  rate: Map<string, { start: number; count: number }>;
  warnedAt: number;
}

interface Store {
  docs: Map<string, OpenDoc>;
  db: Db | null;
  sweeper: ReturnType<typeof setInterval> | null;
}

const g = globalThis as unknown as { __schulosTexte?: Store };
const store: Store = (g.__schulosTexte ??= { docs: new Map(), db: null, sweeper: null });

export type ApplyError = "missing" | "invalid" | "too-large" | "doc-full" | "rate";
/** `changed: false` = alles schon bekannt (nichts verteilt, nichts gespeichert) */
export type ApplyResult = { ok: true; editors: number; crowded: boolean; changed: boolean } | { ok: false; error: ApplyError };
export interface SyncResult {
  /** was dem Client fehlt (Yjs-Update, Base64; bei leerem Zustandsvektor der volle Stand) */
  update: string;
  /** Zustandsvektor des Servers (Base64) – der Client liefert damit nach, was dem Server fehlt */
  sv: string;
  editors: number;
  crowded: boolean;
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Base64 streng lesen – `Buffer.from` würde Müll still überlesen. */
export function fromBase64(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length % 4 !== 0 || !B64.test(s)) return null;
  return new Uint8Array(Buffer.from(s, "base64"));
}

export const toBase64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");

function startSweeper() {
  if (store.sweeper) return;
  store.sweeper = setInterval(() => {
    if (store.db) void sweep(store.db);
  }, LIMITS.sweepMs);
  store.sweeper.unref?.();
}

/** Text in den Speicher laden (oder den geladenen liefern); null, wenn es ihn nicht gibt. */
export async function openDoc(db: Db, id: string, now = Date.now()): Promise<OpenDoc | null> {
  store.db = db;
  startSweeper();
  const have = store.docs.get(id);
  if (have) {
    have.lastAccess = now;
    return have;
  }
  const [row] = await db.select({ groupId: textDocs.groupId, state: textDocs.state, version: textDocs.version }).from(textDocs).where(eq(textDocs.id, id));
  if (!row) return null;
  // zwei gleichzeitige Erstzugriffe: der zweite nimmt das Dokument des ersten
  const raced = store.docs.get(id);
  if (raced) return raced;
  const doc = new Y.Doc({ gc: true });
  const state = row.state ? fromBase64(row.state) : null;
  if (state?.length) Y.applyUpdate(doc, state, "db");
  const od: OpenDoc = {
    id,
    groupId: row.groupId,
    doc,
    version: row.version,
    pending: 0,
    sizeBytes: state?.length ?? 0,
    saving: null,
    saveTimer: null,
    lastAccess: now,
    present: new Map(),
    members: null,
    rate: new Map(),
    warnedAt: 0,
  };
  store.docs.set(id, od);
  return od;
}

/** Anwesenheit vermerken; liefert, wie viele gerade dabei sind (und warnt ab der Grenze, gedrosselt). */
function seen(od: OpenDoc, userId: string, now: number): { editors: number; crowded: boolean } {
  od.present.set(userId, now);
  for (const [u, t] of od.present) if (t < now - LIMITS.presenceMs) od.present.delete(u);
  const editors = od.present.size;
  const crowded = editors > LIMITS.editors;
  if (crowded && now - od.warnedAt > LIMITS.warnEveryMs) {
    od.warnedAt = now;
    console.warn(`[texte] ${editors} Personen bearbeiten gleichzeitig den Text ${od.id} – ausgelegt ist das Modul für etwa ${LIMITS.editors} (P3-11: melden statt umbauen)`);
  }
  return { editors, crowded };
}

function rateOk(od: OpenDoc, userId: string, now: number): boolean {
  const r = od.rate.get(userId);
  if (!r || now - r.start >= 60_000) {
    od.rate.set(userId, { start: now, count: 1 });
    return true;
  }
  r.count += 1;
  return r.count <= LIMITS.updatesPerMinute;
}

/** Empfänger eines Live-Ereignisses: wer den Text offen hat UND (noch) Mitglied der Gruppe ist (Cache 30 s). */
async function recipients(db: Db, od: OpenDoc, now: number): Promise<string[]> {
  if (!od.members || od.members.until < now) {
    const rows = await db.select({ id: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, od.groupId));
    od.members = { ids: new Set(rows.map((r) => r.id)), until: now + LIMITS.membersCacheMs };
  }
  const out: string[] = [];
  for (const [u, t] of od.present) if (t >= now - LIMITS.presenceMs && od.members.ids.has(u)) out.push(u);
  return out;
}

async function broadcast(db: Db, od: OpenDoc, update: Uint8Array, now: number) {
  const b64 = toBase64(update);
  for (const u of await recipients(db, od, now)) publish(u, { type: "text", docId: od.id, update: b64 });
}

function scheduleSave(db: Db, od: OpenDoc) {
  if (od.saveTimer) return;
  od.saveTimer = setTimeout(() => {
    od.saveTimer = null;
    void saveDoc(db, od);
  }, LIMITS.saveDelayMs);
  od.saveTimer.unref?.();
}

/**
 * Update eines Clients anwenden: Grenzen prüfen, ins Dokument übernehmen, an die anderen verteilen, Speichern anstoßen.
 * Rechte (Mitglied, Merkmal, Schreibrecht) prüft der Aufrufer vorher (Service `docAccess`).
 */
export async function applyClientUpdate(db: Db, id: string, userId: string, updateB64: unknown, now = Date.now()): Promise<ApplyResult> {
  const od = await openDoc(db, id, now);
  if (!od) return { ok: false, error: "missing" };
  const update = fromBase64(updateB64);
  if (!update || update.length === 0) return { ok: false, error: "invalid" };
  if (update.length > LIMITS.updateBytes) return { ok: false, error: "too-large" };
  if (!rateOk(od, userId, now)) return { ok: false, error: "rate" };
  const presence = seen(od, userId, now);
  // Volles Dokument (P311-02): erst nachmessen (zwischen zwei Speichervorgängen ist sizeBytes nur geschätzt); liegt es wirklich
  // über der Grenze, kommen nur noch kleine Updates durch, die den Stand nicht vergrößern (Löschen) – gemessen an einer Kopie,
  // weil sich ein Yjs-Update nicht zurücknehmen lässt. So wächst der Text höchstens um ein Update über die Grenze hinaus.
  let measured: number | null = null;
  if (od.sizeBytes > LIMITS.docBytes) {
    od.sizeBytes = Y.encodeStateAsUpdate(od.doc).length;
    if (od.sizeBytes > LIMITS.docBytes) {
      if (update.length > LIMITS.smallUpdateBytes) return { ok: false, error: "doc-full" };
      const probe = new Y.Doc({ gc: true });
      try {
        Y.applyUpdate(probe, Y.encodeStateAsUpdate(od.doc));
        Y.applyUpdate(probe, update);
        measured = Y.encodeStateAsUpdate(probe).length;
      } catch {
        return { ok: false, error: "invalid" };
      } finally {
        probe.destroy();
      }
      if (measured > od.sizeBytes) return { ok: false, error: "doc-full" };
    }
  }
  // Nur wirksame Updates zählen (P311-01): Yjs feuert „update“ nicht, wenn alles schon bekannt war (z. B. die Nachlieferung
  // eines Clients nach dem Sync, die nur das DeleteSet trägt). Dann weder pending noch Broadcast noch Speichern – sonst
  // verlängerte bloßes Öffnen die Löschfrist (updated_at). Verteilt wird das tatsächlich Neue aus dem Ereignis.
  let effective: Uint8Array | null = null;
  const onUpdate = (u: Uint8Array) => {
    effective = u;
  };
  od.doc.on("update", onUpdate);
  try {
    Y.applyUpdate(od.doc, update, `user:${userId}`);
  } catch {
    return { ok: false, error: "invalid" };
  } finally {
    od.doc.off("update", onUpdate);
  }
  if (!effective) return { ok: true, ...presence, changed: false };
  od.pending += 1;
  od.sizeBytes = measured ?? od.sizeBytes + (effective as Uint8Array).length;
  await broadcast(db, od, effective, now);
  scheduleSave(db, od);
  return { ok: true, ...presence, changed: true };
}

/** Abgleich: was fehlt dem Client (Diff zu seinem Zustandsvektor), und was ist der Stand des Servers? */
export async function syncDoc(db: Db, id: string, userId: string, svB64: unknown, now = Date.now()): Promise<SyncResult | null | "invalid"> {
  const od = await openDoc(db, id, now);
  if (!od) return null;
  let sv: Uint8Array | undefined;
  if (svB64 !== undefined && svB64 !== null && svB64 !== "") {
    const bytes = fromBase64(svB64);
    if (!bytes) return "invalid";
    try {
      Y.decodeStateVector(bytes);
    } catch {
      return "invalid";
    }
    sv = bytes;
  }
  const presence = seen(od, userId, now);
  return { update: toBase64(Y.encodeStateAsUpdate(od.doc, sv)), sv: toBase64(Y.encodeStateVector(od.doc)), ...presence };
}

/** Voller Stand (Base64) – für den ersten Aufbau der Seite. */
export async function currentState(db: Db, id: string): Promise<string | null> {
  const od = await openDoc(db, id);
  return od ? toBase64(Y.encodeStateAsUpdate(od.doc)) : null;
}

/** Lesend mit dem Dokument arbeiten (Export). */
export async function withDoc<T>(db: Db, id: string, fn: (doc: Y.Doc) => T): Promise<T | null> {
  const od = await openDoc(db, id);
  return od ? fn(od.doc) : null;
}

/**
 * Stand speichern. Hat inzwischen ein anderer Prozess gespeichert (Version passt nicht), wird dessen Stand erst
 * zusammengeführt (und das Neue an die Anwesenden verteilt), dann erneut geschrieben.
 */
export async function saveDoc(db: Db, od: OpenDoc): Promise<void> {
  if (od.saving) return od.saving;
  od.saving = (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = od.pending;
      const bytes = Y.encodeStateAsUpdate(od.doc);
      const rows = await db
        .update(textDocs)
        .set({ state: toBase64(bytes), version: od.version + 1, updatedAt: new Date() })
        .where(and(eq(textDocs.id, od.id), eq(textDocs.version, od.version)))
        .returning({ version: textDocs.version });
      if (rows.length) {
        od.version = rows[0]!.version;
        od.pending -= before;
        od.sizeBytes = bytes.length;
        if (od.pending > 0) scheduleSave(db, od);
        return;
      }
      const [row] = await db.select({ state: textDocs.state, version: textDocs.version }).from(textDocs).where(eq(textDocs.id, od.id));
      if (!row) {
        forgetDoc(od.id); // inzwischen gelöscht
        return;
      }
      const theirs = row.state ? fromBase64(row.state) : null;
      if (theirs?.length) {
        const mine = Y.encodeStateVector(od.doc);
        Y.applyUpdate(od.doc, theirs, "db");
        const fresh = Y.encodeStateAsUpdate(od.doc, mine);
        if (fresh.length > 2) await broadcast(db, od, fresh, Date.now());
      }
      od.version = row.version;
    }
    console.warn(`[texte] Speichern von ${od.id} nach 4 Anläufen nicht gelungen – nächster Versuch beim nächsten Update`);
  })().finally(() => {
    od.saving = null;
  });
  return od.saving;
}

/** Ungesicherte Stände sofort schreiben (Tests; Aufräumen). */
export async function flushDocs(db: Db, id?: string): Promise<void> {
  for (const od of store.docs.values()) {
    if (id && od.id !== id) continue;
    if (od.saveTimer) {
      clearTimeout(od.saveTimer);
      od.saveTimer = null;
    }
    if (od.saving) await od.saving;
    // während des Speicherns kann Neues gekommen sein – höchstens dreimal nachsetzen
    for (let i = 0; i < 3 && od.pending > 0; i++) await saveDoc(db, od);
  }
}

/** Aus dem Speicher nehmen, ohne zu speichern (nach dem Löschen). */
export function forgetDoc(id: string): void {
  const od = store.docs.get(id);
  if (!od) return;
  if (od.saveTimer) clearTimeout(od.saveTimer);
  store.docs.delete(id);
  od.doc.destroy();
}

/** Umbenannt/gelöscht: die Anwesenden erfahren es über den Live-Kanal. */
export async function notifyDoc(db: Db, id: string, event: { title: string } | { removed: true }): Promise<void> {
  const od = store.docs.get(id);
  if (!od) return;
  for (const u of await recipients(db, od, Date.now())) publish(u, { type: "text", docId: id, ...event });
}

/** Takt: Ungesichertes speichern (Sicherheitsnetz), lange nicht genutzte Texte aus dem Speicher nehmen. */
export async function sweep(db: Db, now = Date.now()): Promise<void> {
  for (const od of [...store.docs.values()]) {
    if (od.pending > 0 && !od.saving && !od.saveTimer) await saveDoc(db, od);
    if (od.pending === 0 && !od.saving && now - od.lastAccess > LIMITS.idleMs) forgetDoc(od.id);
  }
}

/** Für Tests und Diagnose. */
export function openDocIds(): string[] {
  return [...store.docs.keys()];
}
