// Verwaltung → System (B-33): liest den Status, den schulosctl auf dem Host schreibt, und legt Aufträge für den Host ab
// (Update freigeben, Kanal wechseln). Kein Docker-Socket in der App – nur Dateien im Konfigurationsordner
// (Schnittstelle in @schulos/server/system).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Channel } from "@schulos/server/release";
import { parseOrder, SYSTEM_ORDER_FILE, SYSTEM_STATUS_FILE, type SystemOrder, type SystemStatus } from "@schulos/server/system";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { configDir } from "@/core/backup/pairing";

export class SystemOrderError extends Error {}

/** Nach so vielen Minuten ohne neuen Status läuft der Abgleich auf dem Host vermutlich nicht (Timer alle 5 min). */
export const STATUS_STALE_MINUTES = 30;

export function readSystemStatus(dir = configDir()): SystemStatus | null {
  const file = path.join(dir, SYSTEM_STATUS_FILE);
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as SystemStatus;
    return s.version === 1 ? s : null;
  } catch {
    return null;
  }
}

/** Auftrag, den der Host noch nicht abgeholt hat. */
export function pendingOrder(dir = configDir()): SystemOrder | null {
  const file = path.join(dir, SYSTEM_ORDER_FILE);
  if (!existsSync(file)) return null;
  try {
    return parseOrder(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export type OrderInput =
  | { action: "freigabe"; target: string; when: "jetzt" | "wartungsfenster" }
  | { action: "kanal"; channel: Channel }
  | { action: "neustart" };

/**
 * Auftrag für den Host ablegen. Eine Freigabe gilt nur für eine Version, die laut Status gerade verfügbar ist
 * (der Host prüft das beim Abholen nochmals). Ein neuer Auftrag ersetzt einen noch nicht abgeholten.
 */
export async function placeOrder(db: Db, actorId: string, input: OrderInput, dir = configDir(), now = new Date()): Promise<SystemOrder> {
  if (input.action === "freigabe") {
    const status = readSystemStatus(dir);
    const target = status?.update?.status === "verfügbar" ? status.update.steps.at(-1)?.version : undefined;
    if (!target || target !== input.target) throw new SystemOrderError(`Version ${input.target} ist nicht (mehr) verfügbar – Seite neu laden`);
  }
  // Q5-18: nur wenn laut Status ein Neustart aussteht (der Host prüft das beim Abholen nochmals)
  if (input.action === "neustart" && !readSystemStatus(dir)?.reboot) throw new SystemOrderError("Es steht kein Neustart aus – Seite neu laden");
  const order = parseOrder({ version: 1, id: `auftrag-${randomBytes(6).toString("hex")}`, createdAt: now.toISOString(), by: actorId, ...input });
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SYSTEM_ORDER_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(order, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
  if (input.action === "freigabe") await audit(db, actorId, "verwaltung.system.update_freigegeben", null, { version: input.target, wann: input.when });
  else if (input.action === "kanal") await audit(db, actorId, "verwaltung.system.kanal", null, { kanal: input.channel });
  else await audit(db, actorId, "verwaltung.system.neustart", null, {});
  return order;
}

export function statusIsStale(status: SystemStatus, now = new Date()): boolean {
  return now.getTime() - Date.parse(status.checkedAt) > STATUS_STALE_MINUTES * 60_000;
}
