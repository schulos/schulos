// Notenbuch (P5-20): reine Abgleichlogik der Offline-Eingabe – ohne DB, ohne Browser, von Server (offline.ts) und Client
// (offline.tsx) gemeinsam genutzt. Grundlage ist die **Revision je Zelle** (`notenbuch_entries.version`, seit P5-12 bei jeder
// Änderung hochgezählt):
//   · Eine Offline-Änderung (`OfflineOp`) merkt sich die Revision, die die Zelle hatte, als die Lehrkraft offline ging
//     (`baseVersion`). Mehrere Offline-Eingaben in dieselbe Zelle ersetzen einander, die Grundrevision bleibt (`mergeOp`).
//   · Beim Abgleich (`classifyOp`): Server-Revision = Grundrevision → anwenden. Sonst, wenn die Zelle auf dem Server schon genau
//     den Wert der Änderung trägt → „schon angewendet“ (idempotent: eine Übertragung, deren Antwort verloren ging, lässt sich
//     gefahrlos wiederholen). Sonst **Konflikt**: nichts wird überschrieben, die Tabelle zeigt Server-Wert und lokalen Wert, und
//     die Lehrkraft entscheidet bewusst (`resolveConflict`).
//   · Gesperrte oder abgeschlossene Bücher und vergangene Schuljahre lehnen jede Offline-Änderung ab (`rejected`).

/** Eine Offline-Änderung an einer Zelle (Teilnote + Kommentar; leerer Wert = löschen). */
export interface OfflineOp {
  /** zufällige Kennung je Änderung (Wiederholung erkennbar) */
  opId: string;
  columnId: string;
  studentId: string;
  /** gespeicherter Wert (Skala, Punkte, „fehlt“, „befreit“) oder "" = löschen */
  value: string;
  comment: string | null;
  /** Revision der Zelle, auf der die Änderung aufsetzt (0 = Zelle war leer) */
  baseVersion: number;
  /** Zeitpunkt der Eingabe (ISO, nur zur Anzeige) */
  at: string;
}

/** Stand einer Zelle auf dem Server (null = leer). */
export interface ServerCell {
  value: string;
  comment: string | null;
  version: number;
}

export type OpOutcome = "apply" | "applied" | "conflict";

/** Ergebnis je Änderung nach dem Abgleich. */
export type SyncResult =
  | { opId: string; status: "applied"; version: number }
  | { opId: string; status: "conflict"; server: ServerCell | null; serverLabel: string | null }
  | { opId: string; status: "rejected"; reason: string };

export const OFFLINE_OPS_MAX = 500;

/** Rein: passt die Änderung auf den Server-Stand (apply), ist sie dort schon (applied) oder kollidiert sie (conflict)? */
export function classifyOp(current: ServerCell | null, op: OfflineOp): OpOutcome {
  const version = current?.version ?? 0;
  if (version === op.baseVersion) return "apply";
  const serverValue = current?.value ?? "";
  const serverComment = current?.comment ?? null;
  if (serverValue === op.value && serverComment === (op.comment ?? null)) return "applied";
  return "conflict";
}

const cellKey = (columnId: string, studentId: string) => `${columnId}:${studentId}`;

/**
 * Neue Offline-Eingabe in die Warteschlange: je Zelle höchstens eine Änderung – eine spätere ersetzt Wert und Kommentar der
 * früheren, behält aber deren Grundrevision (die Zelle wurde seit dem Offline-Gehen nicht vom Server bestätigt).
 */
export function mergeOp(queue: readonly OfflineOp[], op: OfflineOp): OfflineOp[] {
  const key = cellKey(op.columnId, op.studentId);
  const existing = queue.find((q) => cellKey(q.columnId, q.studentId) === key);
  const merged = existing ? { ...op, baseVersion: existing.baseVersion } : op;
  return [...queue.filter((q) => q !== existing), merged];
}

/** Offene Konflikte, die die Lehrkraft auflösen muss. */
export interface OfflineConflict {
  op: OfflineOp;
  server: ServerCell | null;
  /** „Max Mustermann, 1. Klassenarbeit“ bzw. null (unbekannt) */
  serverLabel: string | null;
}

export interface SyncOutcome {
  /**
   * noch offen: unbeantwortete Änderungen (auch die während des Abgleichs dazugekommenen) und **Konflikte** – die bleiben in der
   * (verschlüsselten) Warteschlange, bis die Lehrkraft sie auflöst (GATE-5a, G5A-C04: nichts geht durch Neuladen verloren)
   */
  queue: OfflineOp[];
  conflicts: OfflineConflict[];
  /** abgelehnte Änderungen (gesperrt, kein Zugriff) – nur zur Anzeige, nicht mehr in der Warteschlange */
  rejected: { op: OfflineOp; reason: string }[];
  /** angewendet: Zelle → neue Revision */
  applied: Map<string, { op: OfflineOp; version: number }>;
}

/**
 * G5A-C03: Antworten auf eine **gesendete** Momentaufnahme mit der **aktuellen** Warteschlange zusammenführen – während des
 * Abgleichs neu eingetragene oder ersetzte Änderungen bleiben erhalten. Beantwortete Änderungen verlassen die Warteschlange
 * (Konflikte ausgenommen); hat eine neuere Eingabe derselben Zelle eine angewendete ersetzt, setzt sie auf deren Revision auf
 * (sonst kollidierte sie mit der eigenen Übertragung). Rückmeldungen (angewendet/Konflikt/abgelehnt) nur für Änderungen, die
 * noch aktuell sind – eine ersetzte Eingabe setzt die Zelle nicht auf den älteren Wert zurück.
 */
export function reconcileQueue(current: readonly OfflineOp[], sent: readonly OfflineOp[], results: readonly SyncResult[]): SyncOutcome {
  const byId = new Map(results.map((r) => [r.opId, r]));
  const appliedByCell = new Map<string, number>();
  for (const op of sent) {
    const r = byId.get(op.opId);
    if (r?.status === "applied") appliedByCell.set(cellKey(op.columnId, op.studentId), r.version);
  }
  const out: SyncOutcome = { queue: [], conflicts: [], rejected: [], applied: new Map() };
  for (const op of current) {
    const r = byId.get(op.opId);
    if (!r) {
      const v = appliedByCell.get(cellKey(op.columnId, op.studentId));
      out.queue.push(v === undefined ? op : { ...op, baseVersion: v });
      continue;
    }
    if (r.status === "applied") out.applied.set(cellKey(op.columnId, op.studentId), { op, version: r.version });
    else if (r.status === "conflict") {
      out.conflicts.push({ op, server: r.server, serverLabel: r.serverLabel });
      out.queue.push(op);
    } else out.rejected.push({ op, reason: r.reason });
  }
  return out;
}

/** Antworten des Servers auf die Warteschlange anwenden (gesendet = aktuell; Server-Zählung im Audit). */
export function applySyncResults(queue: readonly OfflineOp[], results: readonly SyncResult[]): SyncOutcome {
  return reconcileQueue(queue, queue, results);
}

/**
 * Bewusste Auflösung eines Konflikts: „meine Eingabe“ setzt die Änderung neu auf die Server-Revision auf (wird beim nächsten
 * Abgleich angewendet), „Server-Wert behalten“ verwirft sie (null).
 */
export function resolveConflict(conflict: OfflineConflict, choice: "mine" | "server", opId: string, at: string): OfflineOp | null {
  if (choice === "server") return null;
  return { ...conflict.op, opId, at, baseVersion: conflict.server?.version ?? 0 };
}

/**
 * Auflösung in der Warteschlange (Konflikte bleiben dort bis hierher): „Server-Wert behalten“ nimmt die kollidierte Änderung
 * heraus, „meine Eingabe“ ersetzt sie durch die neu aufgesetzte. Hat die Lehrkraft die Zelle inzwischen erneut geändert, gilt
 * die neuere Eingabe – bei „meine Eingabe“ auf die Server-Revision aufgesetzt, bei „Server-Wert“ unverändert (sie kollidiert
 * dann ggf. erneut und wird wieder angezeigt).
 */
export function resolveInQueue(queue: readonly OfflineOp[], conflict: OfflineConflict, choice: "mine" | "server", opId: string, at: string): OfflineOp[] {
  const key = cellKey(conflict.op.columnId, conflict.op.studentId);
  const inCell = queue.find((q) => cellKey(q.columnId, q.studentId) === key);
  const rest = queue.filter((q) => q !== inCell);
  if (!inCell) return choice === "mine" ? [...rest, resolveConflict(conflict, "mine", opId, at)!] : [...rest];
  if (inCell.opId === conflict.op.opId) return choice === "mine" ? [...rest, resolveConflict(conflict, "mine", opId, at)!] : rest;
  return choice === "mine" ? [...rest, { ...inCell, baseVersion: conflict.server?.version ?? 0 }] : [...queue];
}

/** Zugriff auf die Warteschlangen eines Geräts – im Browser IndexedDB (offline-store.ts), im Test ein Speicher-Objekt. */
export interface QueueStore {
  /** Bücher mit Warteschlange auf diesem Gerät */
  books: () => Promise<string[]>;
  read: (bookId: string) => Promise<OfflineOp[]>;
  write: (bookId: string, ops: readonly OfflineOp[]) => Promise<void>;
}

/**
 * G5A-C04: letzter Abruf (`keep: false`) – die Warteschlangen **aller** Bücher dieses Geräts übertragen, nicht nur die des
 * offenen Buchs. Liefert, was danach noch offen ist (Konflikte, nicht erreichbare Bücher); erst bei 0 darf der Browser den
 * Zwischenspeicher löschen. `sync` wirft bei fehlender Verbindung – das Buch bleibt dann offen.
 */
export async function transferAllQueues(
  store: QueueStore,
  sync: (bookId: string, ops: OfflineOp[]) => Promise<SyncResult[] | null>,
): Promise<{ remaining: number; books: number }> {
  let remaining = 0;
  let books = 0;
  for (const bookId of await store.books()) {
    let ops: OfflineOp[];
    try {
      ops = await store.read(bookId);
    } catch {
      // Review R3 N2: nicht lesbar heißt nicht leer – offen zählen (kein Löschen des Zwischenspeichers), nichts darüber schreiben
      remaining++;
      books++;
      continue;
    }
    if (!ops.length) continue;
    let left = ops;
    try {
      const results = await sync(bookId, ops);
      if (results) left = reconcileQueue(ops, ops, results).queue;
    } catch {
      // keine Verbindung oder kein Zugriff mehr – bleibt offen
    }
    await store.write(bookId, left);
    if (left.length) {
      remaining += left.length;
      books++;
    }
  }
  return { remaining, books };
}

/** Frist des Offline-Caches je Gerät (Tage ab Einschalten) – danach ist der Server-Anteil weg und der Cache unlesbar. */
export const OFFLINE_MAX_DAYS = 7;

/** Rein: ist die Frist des Geräts abgelaufen? */
export function offlineExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}
