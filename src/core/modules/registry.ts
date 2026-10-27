import { eq } from "drizzle-orm";
import { cache } from "react";
import type { Db } from "@/core/db/client";
import { appSettings, grants, moduleStates, type Role } from "@/core/db/schema";
import { hasExplicitGrant, hasPermission, type PermissionSet } from "@/core/permissions";
import { NAV_SECTIONS, NAV_SECTION_LABELS, type ModuleManifest, type NavSection } from "./types";

/** Prüft die Manifeste auf Konsistenz; wirft mit allen Fehlern auf einmal. */
export function validateManifests(manifests: readonly ModuleManifest[]): void {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const m of manifests) {
    if (!/^[a-z][a-z0-9-]*$/.test(m.id)) errors.push(`${m.id}: ungültige id`);
    if (seen.has(m.id)) errors.push(`${m.id}: doppelte id`);
    seen.add(m.id);
    for (const p of Object.keys(m.permissions ?? {})) {
      if (!p.startsWith(`${m.id}.`)) errors.push(`${m.id}: Recht "${p}" muss mit "${m.id}." beginnen`);
    }
    for (const f of Object.keys(m.groupFeatures ?? {})) {
      if (!f.startsWith(`${m.id}.`)) errors.push(`${m.id}: Gruppenmerkmal "${f}" muss mit "${m.id}." beginnen`);
    }
    for (const st of m.settings ?? []) {
      if (!st.key.startsWith(`${m.id}.`)) errors.push(`${m.id}: Einstellung "${st.key}" muss mit "${m.id}." beginnen`);
      if (!st.options.some((o) => o.value === st.default)) errors.push(`${m.id}: Vorgabe von "${st.key}" ist keine Option`);
    }
    // Q5-26: Löschregeln, die eine Moduleinstellung lesen, brauchen eine eigene, rein numerische Einstellung des Moduls
    for (const r of m.retention ?? []) {
      if (!r.setting) continue;
      const st = (m.settings ?? []).find((s) => s.key === r.setting);
      if (!st) errors.push(`${m.id}: Löschregel ${r.table} liest unbekannte Einstellung "${r.setting}"`);
      else if (st.options.some((o) => !/^\d+$/.test(o.value))) errors.push(`${m.id}: Einstellung "${r.setting}" für das Löschkonzept braucht Zahlenwerte`);
    }
    for (const [role, perms] of Object.entries(m.defaultGrants ?? {})) {
      for (const p of perms ?? []) {
        if (!(p in (m.permissions ?? {}))) errors.push(`${m.id}: defaultGrant "${p}" für ${role} ist nicht deklariert`);
      }
    }
  }
  if (errors.length) throw new Error("Ungültige Modul-Manifeste:\n" + errors.join("\n"));
}

export type ModuleStateMap = ReadonlyMap<string, boolean>;

/** Ein-/Ausschaltzustand der Module, pro Request gecacht (B-56: Shell und Seite fragen beide). */
export const loadModuleStates = cache(async (db: Db): Promise<ModuleStateMap> => {
  const rows = await db.select().from(moduleStates);
  return new Map(rows.map((r) => [r.moduleId, r.enabled]));
});

export function isEnabled(m: ModuleManifest, states: ModuleStateMap): boolean {
  if (m.core) return true;
  return states.get(m.id) ?? m.defaultEnabled ?? true;
}

export async function setModuleEnabled(db: Db, m: ModuleManifest, enabled: boolean): Promise<void> {
  if (m.core && !enabled) throw new Error(`Kernmodul "${m.name}" kann nicht abgeschaltet werden`);
  await db
    .insert(moduleStates)
    .values({ moduleId: m.id, enabled })
    .onConflictDoUpdate({ target: moduleStates.moduleId, set: { enabled, updatedAt: new Date() } });
}

export interface NavEntry {
  moduleId: string;
  mobile?: number;
  href: string;
  label: string;
  icon: string;
}
export interface NavGroup {
  section: NavSection;
  label: string;
  items: NavEntry[];
}

/**
 * Navigation für einen Benutzer: nur aktive Module, nur erlaubte Einträge, nach Sektionen gruppiert. `ctx.classLead`: die Person leitet eine Klasse (Einträge mit `classLead`). `ctx.selfResponsible`:
 * die Person ist eine eigenständige Schüler:in (Einträge mit `selfResponsible`). `ctx.settings`: aktuelle Werte der
 * Moduleinstellungen, von denen Einträge abhängen (`navSettingKeys`) – fehlt ein Wert, gilt der Eintrag als ausgeschaltet.
 */
export function buildNav(
  manifests: readonly ModuleManifest[],
  states: ModuleStateMap,
  perms: PermissionSet,
  ctx: { selfResponsible?: boolean; classLead?: boolean; settings?: ReadonlyMap<string, string> } = {},
): NavGroup[] {
  const sorted = [...manifests].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  return NAV_SECTIONS.map((section) => ({
    section,
    label: NAV_SECTION_LABELS[section],
    items: sorted
      .filter((m) => m.section === section && isEnabled(m, states))
      .flatMap((m) =>
        (m.nav ?? [])
          .filter((n) => {
            // TD-11: `classLead` öffnet den Eintrag zusätzlich für die Klassenleitung (Recht ODER Klassenleitung)
            if (n.classLead && ctx.classLead === true) return true;
            if (n.classLead && !n.requires) return false;
            return !n.requires || (Array.isArray(n.requires) ? n.requires : [n.requires]).some((r) => (n.explicit ? hasExplicitGrant(perms, r) : hasPermission(perms, r)));
          })
          .filter((n) => !n.settings || n.settings.every((st) => (ctx.settings?.get(st.key) ?? st.off) !== st.off))
          .filter((n) => {
            const other = n.requiresModule ? manifests.find((x) => x.id === n.requiresModule) : undefined;
            return !n.requiresModule || (!!other && isEnabled(other, states));
          })
          .filter((n) => !n.roles || n.roles.includes(perms.role))
          .filter((n) => !n.selfResponsible || (perms.role === "schueler" && ctx.selfResponsible === true))
          // nur der erste Eintrag eines Moduls kommt in die mobile Leiste
          .map((n, i) => ({ moduleId: m.id, href: n.href, label: n.label, icon: n.icon ?? m.icon, mobile: i === 0 ? m.mobile : undefined })),
      ),
  })).filter((g) => g.items.length > 0);
}

/**
 * Legt die defaultGrants eines Moduls genau einmal an (beim ersten Start).
 * Danach gehören die Grants dem Admin – entfernte Grants kommen nicht zurück.
 */
/**
 * Legt defaultGrants an – je Rolle/Recht-Paar genau einmal. Gemerkt wird die Liste der vergebenen Paare je Modul
 * (`grants.synced.<id>`): Neue Paare (z. B. ein neues Recht in einem bestehenden Modul) kommen dazu, vom Admin
 * entzogene Paare werden nicht wieder angelegt. Alte Einträge mit `true` gelten als „alle damaligen Paare vergeben“.
 */
export async function syncDefaultGrants(db: Db, manifests: readonly ModuleManifest[]): Promise<string[]> {
  const synced: string[] = [];
  for (const m of manifests) {
    const key = `grants.synced.${m.id}`;
    const pairs = Object.entries(m.defaultGrants ?? {}).flatMap(([role, perms]) => (perms ?? []).map((permission) => `${role}:${permission}`));
    const [done] = await db.select().from(appSettings).where(eq(appSettings.key, key));
    const known = new Set<string>(Array.isArray(done?.value) ? (done.value as string[]) : done?.value === true ? pairs : []);
    const fresh = pairs.filter((p) => !known.has(p));
    if (done && fresh.length === 0 && Array.isArray(done.value)) continue;
    if (fresh.length) {
      await db
        .insert(grants)
        .values(fresh.map((p) => ({ role: p.slice(0, p.indexOf(":")) as Role, permission: p.slice(p.indexOf(":") + 1) })))
        .onConflictDoNothing();
    }
    const value = [...new Set([...known, ...pairs])];
    await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
    if (fresh.length || !done) synced.push(m.id);
  }
  return synced;
}

export const KNOWN_MODULES_KEY = "modules.known";

/**
 * Nach einem Update beim Serverstart (B-34, INSTALLATION.md §5a.2): Module, die diese Instanz noch nicht kannte,
 * kommen **ausgeschaltet** – die Schule schaltet sie unter „Rechte & Module“ ein, wenn sie so weit ist. Ihre
 * Standardrechte werden angelegt (greifen erst nach dem Einschalten). Beim ersten Lauf (neue Instanz bzw. Stand vor
 * B-34) gelten alle vorhandenen Module als bekannt und behalten ihre Vorgabe.
 */
export async function syncModules(db: Db, manifests: readonly ModuleManifest[]): Promise<{ newlyDisabled: string[] }> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, KNOWN_MODULES_KEY));
  const known = Array.isArray(row?.value) ? new Set(row.value as string[]) : null;
  const newlyDisabled: string[] = [];
  if (known) {
    const states = await loadModuleStates(db);
    for (const m of manifests) {
      if (m.core || known.has(m.id) || states.has(m.id)) continue;
      await setModuleEnabled(db, m, false);
      newlyDisabled.push(m.id);
    }
  }
  await syncDefaultGrants(db, manifests);
  const value = [...new Set([...(known ?? []), ...manifests.map((m) => m.id)])].sort();
  await db.insert(appSettings).values({ key: KNOWN_MODULES_KEY, value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  return { newlyDisabled };
}

export function allPermissions(manifests: readonly ModuleManifest[]) {
  return manifests.flatMap((m) =>
    Object.entries(m.permissions ?? {}).map(([id, label]) => ({ id, label, moduleId: m.id, moduleName: m.name })),
  );
}
