import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { buildNav, loadModuleStates } from "@/core/modules/registry";
import { MODULES } from "@/modules";
import { ModuleIcon } from "@schulos/ui/icons";
import { PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Alle Apps" };

export default async function AppsPage() {
  const { perms } = await requireUser();
  const states = await loadModuleStates(await getDb());
  const entries = buildNav(MODULES, states, perms).flatMap((g) => g.items);
  const byId = new Map(MODULES.map((m) => [m.id, m]));
  return (
    <main className="flex flex-col gap-7">
      <PageHeader title="Alle Apps" />
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        {entries.map((e) => (
          <li key={e.href}>
            <Link
              href={e.href}
              className="flex h-full flex-col gap-3 rounded-card border border-border bg-surface p-5 transition hover:border-border-strong hover:shadow-card"
            >
              <span className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent-ink">
                <ModuleIcon name={e.icon} className="size-6" />
              </span>
              <span className="font-semibold">{e.label}</span>
              <span className="text-sm text-muted">{byId.get(e.moduleId)?.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
