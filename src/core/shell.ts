import "server-only";
import { and, count, eq, isNull } from "drizzle-orm";
import { cache } from "react";
import type { CurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { groupMembers, groups, notifications, profilePhotos } from "@/core/db/schema";
import { ROLE_LABELS } from "@/core/labels";
import { photoUrl } from "@/core/privacy/profilbild";
import { isSelfResponsible } from "@/core/school/majority";
import { buildNav, isEnabled, loadModuleStates, type NavGroup } from "@/core/modules/registry";
import { readModuleSettings } from "@/core/modules/settings";
import { MODULES } from "@/modules";
import { ensureModuleDefaults } from "@/modules/startup";
import { unreadTotal } from "@/modules/messenger/service";
import { initials } from "@schulos/ui/misc";

export interface ShellData {
  nav: NavGroup[];
  unread: number;
  /** Zähler je Modul (z. B. ungelesene Chats) */
  badges: Record<string, number>;
  /** HB-03: „?“ in der Kopfzeile zeigen (Handbuch eingeschaltet) */
  help: boolean;
  userId: string;
  user: { name: string; avatar: string; photo?: string; roleLabel: string; detail?: string; officeHours?: boolean; selfResponsible?: boolean };
}

/** Alles, was die App-Shell für den angemeldeten Benutzer braucht. */
export const getShellData = cache(async ({ user, perms }: CurrentUser): Promise<ShellData> => {
  const db = await getDb();
  await ensureModuleDefaults(db);
  const [states, [unreadRow], memberships, chatUnread, [photo]] = await Promise.all([
    loadModuleStates(db),
    db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt))),
    db
      .select({ slug: groups.slug, kind: groups.kind, role: groupMembers.role, archivedAt: groups.archivedAt })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(eq(groupMembers.userId, user.id)),
    unreadTotal(db, perms),
    db.select({ at: profilePhotos.createdAt }).from(profilePhotos).where(eq(profilePhotos.userId, user.id)),
  ]);
  // P5-14: Navigationseinträge, die von Moduleinstellungen abhängen (z. B. Noten für Schüler:innen/Eltern)
  const navKeys = new Set(MODULES.flatMap((m) => (m.nav ?? []).flatMap((n) => (n.roles && !n.roles.includes(perms.role) ? [] : (n.settings ?? []).map((st) => st.key)))));
  const navDecls = MODULES.flatMap((m) => m.settings ?? []).filter((d) => navKeys.has(d.key));
  const settings = navDecls.length ? await readModuleSettings(db, navDecls) : new Map<string, string>();
  // Q5-05: eigenständige Schüler:innen entscheiden selbst, ob ihre Eltern informiert werden
  const selfResponsible = user.role === "schueler" && (await isSelfResponsible(db, user.id));
  const roleLabel = ROLE_LABELS[user.role];
  // Zusatzzeile unter dem Namen: Schulleitung bzw. Klassenleitung(en)
  const classLeads = memberships.filter((l) => l.kind === "klasse" && l.role === "leader").map((l) => l.slug);
  const extras = [
    ...(memberships.some((l) => l.slug === "schulleitung") ? ["Schulleitung"] : []),
    ...(classLeads.length ? [`Klassenleitung ${classLeads.join(", ")}`] : []),
  ];
  const detail = extras.length ? [roleLabel, ...extras].join(" · ") : undefined;
  return {
    nav: buildNav(MODULES, states, perms, { selfResponsible, classLead: user.role === "lehrkraft" && memberships.some((l) => l.kind === "klasse" && l.role === "leader" && !l.archivedAt), settings }),
    unread: unreadRow?.n ?? 0,
    badges: { messenger: chatUnread },
    help: MODULES.some((m) => m.id === "hilfe" && isEnabled(m, states)),
    userId: user.id,
    user: { name: user.name, avatar: user.shortCode ?? initials(user.name), photo: photoUrl(user.id, photo?.at), roleLabel, detail, officeHours: user.role === "beratung", selfResponsible },
  };
});
