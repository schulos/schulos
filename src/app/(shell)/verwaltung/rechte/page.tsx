import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { groups } from "@/core/db/schema";
import { ROLE_LABELS } from "@/core/labels";
import { mailAvailable } from "@/core/mail";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { readModuleSettings } from "@/core/modules/settings";
import { hasPermission } from "@/core/permissions";
import { MODULES } from "@/modules";
import { getRoleGrantMatrix, GRANTABLE_ROLES, grantablePermissions, listGroupGrants, roleGrantBlocked } from "@/modules/verwaltung/rights";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { GroupGrants, GrantCheckbox, ModuleSettingSelect, ModuleToggle } from "./rights-client";
import { de } from "@/core/db/sort";

export const metadata: Metadata = { title: "Rechte & Module" };

export default async function RechtePage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.rights")) notFound();
  const db = await getDb();
  const withSettings = MODULES.filter((m) => m.settings?.length);
  const [states, matrix, groupGrants, groupList, settingValues] = await Promise.all([
    loadModuleStates(db),
    getRoleGrantMatrix(db),
    listGroupGrants(db),
    db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(de(groups.name)),
    readModuleSettings(db, withSettings.flatMap((m) => m.settings ?? [])),
  ]);
  const permissions = grantablePermissions(MODULES);
  const mail = mailAvailable();
  const byModule = MODULES.map((m) => ({ module: m, perms: permissions.filter((p) => p.moduleId === m.id) })).filter((x) => x.perms.length);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader title="Rechte & Module" />

      <Card>
        <CardHeader title="Module" />
        <p className="-mt-2 text-sm text-muted">Abgeschaltete Module verschwinden für alle aus Navigation, Suche und Startseite.</p>
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {MODULES.map((m) => (
            <li key={m.id}>
              <ModuleToggle
                id={m.id}
                name={m.name}
                description={m.description}
                core={!!m.core}
                enabled={isEnabled(m, states)}
                blockedHint={m.needsMail && !mail ? m.needsMail : undefined}
              />
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader title="Moduleinstellungen" />
        <p className="-mt-2 text-sm text-muted">Gelten für die ganze Schule und wirken sofort; jede Änderung wird protokolliert.</p>
        <div className="flex flex-col gap-5">
          {withSettings.map((m) => (
            <section key={m.id} aria-label={`Einstellungen ${m.name}`} className="flex flex-col gap-3">
              <h3 className="flex items-center gap-2 font-semibold">
                {m.name} {!isEnabled(m, states) && <span className="text-xs font-normal text-muted">(Modul ausgeschaltet)</span>}
              </h3>
              <div className="grid gap-3 md:grid-cols-2">
                {(m.settings ?? []).map((st) => (
                  <ModuleSettingSelect
                    key={st.key}
                    moduleId={m.id}
                    settingKey={st.key}
                    label={st.label}
                    help={st.permission && !hasPermission(perms, st.permission) ? `${st.help ?? ""} Ändern nur mit dem Recht „Datenschutz“.`.trim() : st.help}
                    options={st.options}
                    value={settingValues.get(st.key) ?? st.default}
                    disabled={Boolean(st.permission && !hasPermission(perms, st.permission))}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Rechte nach Rolle" />
        <p className="-mt-2 text-sm text-muted">Administration hat immer alle Rechte.</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold tracking-wide text-muted uppercase">
                <th className="py-2 pr-4">Recht</th>
                {GRANTABLE_ROLES.map((r) => (
                  <th key={r} className="px-2 py-2 text-center">
                    {ROLE_LABELS[r]}
                  </th>
                ))}
              </tr>
            </thead>
            {byModule.map(({ module, perms: list }) => (
              <tbody key={module.id}>
                <tr>
                  <th colSpan={GRANTABLE_ROLES.length + 1} className="border-t border-border pt-4 pb-1 text-left font-semibold">
                    {module.name}
                  </th>
                </tr>
                {list.map((p) => (
                  <tr key={p.id} className="hover:bg-surface-2">
                    <td className="py-2 pr-4">
                      <span className="block">{p.label}</span>
                      <code className="text-xs text-muted">{p.id}</code>
                    </td>
                    {GRANTABLE_ROLES.map((r) => (
                      <td key={r} className="px-2 py-2 text-center">
                        {roleGrantBlocked(r, p.id) && !matrix.has(`${r}:${p.id}`) ? (
                          // GATE-5a: Notenbuch-Rechte nie für Schüler:innen und Eltern – kein Haken zum Setzen
                          <span className="text-muted" title={roleGrantBlocked(r, p.id)!} aria-label={`${p.label} für ${ROLE_LABELS[r]}: nicht vergebbar`}>
                            –
                          </span>
                        ) : (
                          <GrantCheckbox role={r} permission={p.id} label={`${p.label} für ${ROLE_LABELS[r]}`} checked={matrix.has(`${r}:${p.id}`)} />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Rechte über Gruppen" />
        <p className="-mt-2 text-sm text-muted">Alle Mitglieder der Gruppe erhalten das Recht – z. B. die Schulleitung oder die SV.</p>
        <GroupGrants grants={groupGrants} groups={groupList} permissions={permissions.map((p) => ({ id: p.id, label: `${p.moduleName}: ${p.label}` }))} />
      </Card>
    </main>
  );
}
