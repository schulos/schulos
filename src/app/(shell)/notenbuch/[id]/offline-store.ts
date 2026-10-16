// Notenbuch (P5-20): IndexedDB-Ablage des Offline-Caches – nur im Browser. Zwei Fächer:
//   · `device`: Gerätekennung + Geräteanteil als **nicht exportierbares** CryptoKey-Objekt (offline-crypto.ts)
//   · `queue`: je Gerät und Buch die verschlüsselte Warteschlange der Offline-Änderungen (IV + Chiffrat)
// Nichts davon ist ohne den Server-Anteil lesbar. Der Cache-Schlüssel selbst liegt nur im Arbeitsspeicher der Seite.
// GATE-5a (G5A-S05): **eine Datenbank je Konto** – an einem geteilten Dienstgerät (Lehrerzimmer-PC) berührt eine zweite
// Lehrkraft weder Gerät noch Warteschlangen der ersten; Ausschalten und Aufräumen löschen nur den eigenen Bereich.
import { open as openSealed, seal, type Sealed } from "@/modules/notenbuch/offline-crypto";
import type { OfflineOp, QueueStore } from "@/modules/notenbuch/offline-sync";

const DB_PREFIX = "schulos-notenbuch-offline";
const DB_VERSION = 1;

/** Name der Datenbank eines Kontos. */
export const offlineDbName = (userId: string) => `${DB_PREFIX}:${userId}`;

export interface StoredDevice {
  deviceId: string;
  deviceShare: CryptoKey;
}

function openDb(userId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(offlineDbName(userId), DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("device")) db.createObjectStore("device");
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB nicht verfügbar"));
    req.onblocked = () => reject(new Error("IndexedDB blockiert"));
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB-Fehler"));
  });
}

async function withStore<T>(userId: string, store: "device" | "queue", mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb(userId);
  try {
    return await request(fn(db.transaction(store, mode).objectStore(store)));
  } finally {
    db.close();
  }
}

export function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle;
}

/** Gibt es die Datenbank des Kontos schon? (Ohne sie anzulegen – `indexedDB.databases()`, sonst „vielleicht“.) */
async function dbExists(userId: string): Promise<boolean> {
  if (typeof indexedDB.databases !== "function") return true;
  const all = await indexedDB.databases();
  return all.some((d) => d.name === offlineDbName(userId));
}

export async function loadDevice(userId: string): Promise<StoredDevice | null> {
  if (!(await dbExists(userId))) return null;
  const v = await withStore<StoredDevice | undefined>(userId, "device", "readonly", (s) => s.get("device"));
  return v && typeof v.deviceId === "string" && v.deviceShare instanceof CryptoKey ? v : null;
}

export async function saveDevice(userId: string, device: StoredDevice): Promise<void> {
  await withStore(userId, "device", "readwrite", (s) => s.put(device, "device"));
}

const queueKey = (deviceId: string, bookId: string) => `${deviceId}:${bookId}`;
const slot = (deviceId: string, bookId: string) => `${deviceId}:${bookId}:queue`;

export async function readQueue(userId: string, key: CryptoKey, deviceId: string, bookId: string): Promise<OfflineOp[]> {
  const sealed = await withStore<Sealed | undefined>(userId, "queue", "readonly", (s) => s.get(queueKey(deviceId, bookId)));
  if (!sealed) return [];
  const ops = await openSealed<OfflineOp[]>(key, slot(deviceId, bookId), sealed);
  return Array.isArray(ops) ? ops : [];
}

export async function writeQueue(userId: string, key: CryptoKey, deviceId: string, bookId: string, ops: readonly OfflineOp[]): Promise<void> {
  if (ops.length === 0) {
    await withStore(userId, "queue", "readwrite", (s) => s.delete(queueKey(deviceId, bookId)));
    return;
  }
  const sealed = await seal(key, slot(deviceId, bookId), ops);
  await withStore(userId, "queue", "readwrite", (s) => s.put(sealed, queueKey(deviceId, bookId)));
}

/** G5A-C04: Bücher mit (verschlüsselter) Warteschlange auf diesem Gerät – ohne Schlüssel lesbar, nur die Kennungen. */
export async function queuedBooks(userId: string, deviceId: string): Promise<string[]> {
  if (!(await dbExists(userId))) return [];
  const keys = await withStore<IDBValidKey[]>(userId, "queue", "readonly", (s) => s.getAllKeys());
  const prefix = `${deviceId}:`;
  return keys.map(String).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/** Wie viele Bücher des Kontos haben auf diesem Gerät noch nicht übertragene Offline-Eingaben? (Warnung beim Abmelden) */
export async function queuedBookCount(userId: string): Promise<number> {
  if (!idbAvailable() || !(await dbExists(userId))) return 0;
  const keys = await withStore<IDBValidKey[]>(userId, "queue", "readonly", (s) => s.getAllKeys());
  return keys.length;
}

/** Warteschlangen eines Geräts als `QueueStore` (für `transferAllQueues`). */
export function queueStore(userId: string, key: CryptoKey, deviceId: string): QueueStore {
  return {
    books: () => queuedBooks(userId, deviceId),
    read: (bookId) => readQueue(userId, key, deviceId, bookId),
    write: (bookId, ops) => writeQueue(userId, key, deviceId, bookId, ops),
  };
}

/** Alles **dieses Kontos** weg (Ausschalten, Gerät nicht mehr erlaubt, Server kennt es nicht mehr) – andere Konten bleiben. */
export function clearAll(userId: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(offlineDbName(userId));
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
