import type { Db } from "@/core/db/client";
import { syncDefaultGrants } from "@/core/modules/registry";
import { MODULES } from "./index";
import { ensureGradeLevels } from "./verwaltung/stammdaten";

const g = globalThis as unknown as { __schulosModulesSynced?: Promise<void> };

/**
 * Legt die defaultGrants neu hinzugekommener Module/Rechte und fehlende Jahrgänge an – einmal pro Serverprozess.
 * (Ohne das hätte z. B. ein neues Modul in einer bestehenden DB keine Rechte.)
 */
export function ensureModuleDefaults(db: Db): Promise<void> {
  g.__schulosModulesSynced ??= syncDefaultGrants(db, MODULES)
    .then(() => ensureGradeLevels(db))
    .catch((err) => {
      g.__schulosModulesSynced = undefined; // beim nächsten Request erneut versuchen
      throw err;
    });
  return g.__schulosModulesSynced;
}
