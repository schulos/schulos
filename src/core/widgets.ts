import type { CurrentUser } from "@/core/auth/session";
import { isEnabled, type ModuleStateMap } from "@/core/modules/registry";
import type { ModuleManifest } from "@/core/modules/types";
import { hasPermission, type PermissionSet } from "@/core/permissions";
import type { Role } from "@/core/roles";

/** Ein Widget für die Startseite „Heute". Die Komponente ist eine async Server Component. */
export interface WidgetDef {
  id: string;
  moduleId: string;
  /** Kleinere Zahl = weiter oben */
  order?: number;
  /** "wide" belegt auf großen Bildschirmen zwei Spalten, "full" die ganze Zeile */
  size?: "normal" | "wide" | "full";
  roles?: Role[];
  requires?: string;
  Component: (props: { current: CurrentUser }) => Promise<React.ReactNode>;
}

/** Welche Widgets sieht dieser Benutzer? Rein, damit testbar. */
export function widgetsFor(
  defs: readonly WidgetDef[],
  manifests: readonly ModuleManifest[],
  states: ModuleStateMap,
  perms: PermissionSet,
): WidgetDef[] {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  return defs
    .filter((w) => {
      const m = byId.get(w.moduleId);
      return m !== undefined && isEnabled(m, states);
    })
    .filter((w) => !w.roles || w.roles.includes(perms.role))
    .filter((w) => !w.requires || hasPermission(perms, w.requires))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}
