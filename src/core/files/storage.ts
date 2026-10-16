// Datei-Speicher: lokales Dateisystem unter FILES_DIR (Standard .data/files).
// Schlüssel sind ausschließlich UUIDs → keine Pfadmanipulation möglich.
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface FileStorage {
  put(key: string, data: Uint8Array): Promise<void>;
  /** Web-ReadableStream für Response-Bodies */
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
  /** alle gespeicherten Schlüssel mit Änderungszeit (für das Aufräumen verwaister Dateien) */
  list(): Promise<{ key: string; modifiedAt: Date }[]>;
}

export function newStorageKey(): string {
  return crypto.randomUUID();
}

export function localStorage(root: string): FileStorage {
  const file = (key: string) => {
    if (!KEY.test(key)) throw new Error("Ungültiger Speicherschlüssel");
    // zweistufig verteilen, damit kein Ordner riesig wird
    return path.join(root, key.slice(0, 2), key);
  };
  return {
    async put(key, data) {
      const p = file(key);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, data);
    },
    async get(key) {
      const p = file(key);
      try {
        await stat(p);
      } catch {
        return null;
      }
      return Readable.toWeb(createReadStream(p)) as ReadableStream<Uint8Array>;
    },
    async delete(key) {
      await rm(file(key), { force: true });
    },
    async list() {
      const out: { key: string; modifiedAt: Date }[] = [];
      let dirs: string[];
      try {
        dirs = await readdir(root);
      } catch {
        return out;
      }
      for (const d of dirs) {
        if (!/^[0-9a-f]{2}$/.test(d)) continue;
        for (const name of await readdir(path.join(root, d)).catch(() => [] as string[])) {
          if (!KEY.test(name) || name.slice(0, 2) !== d) continue;
          const st = await stat(path.join(root, d, name)).catch(() => null);
          if (st?.isFile()) out.push({ key: name, modifiedAt: st.mtime });
        }
      }
      return out;
    },
  };
}

const g = globalThis as unknown as { __schulosStorage?: FileStorage };
export function getStorage(): FileStorage {
  g.__schulosStorage ??= localStorage(process.env.FILES_DIR ?? path.join(process.cwd(), ".data", "files"));
  return g.__schulosStorage;
}
