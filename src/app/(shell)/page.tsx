import { Suspense } from "react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { formatLongDate, greeting } from "@/core/labels";
import { loadModuleStates } from "@/core/modules/registry";
import { widgetsFor } from "@/core/widgets";
import { MODULES } from "@/modules";
import { WIDGETS } from "@/modules/widgets";
import { cn } from "@schulos/ui/cn";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

function WidgetSkeleton() {
  return <div aria-hidden className="h-40 animate-pulse rounded-card border border-border bg-surface" />;
}

export default async function HeutePage() {
  const current = await requireUser();
  const { user, perms } = current;
  const name = user.role === "lehrkraft" ? user.name : user.firstName || user.name;
  const widgets = widgetsFor(WIDGETS, MODULES, await loadModuleStates(await getDb()), perms);

  return (
    <main className="flex flex-col gap-7">
      <PageHeader eyebrow={formatLongDate()} title={`${greeting()}, ${name}.`} />
      {widgets.length === 0 ? (
        <EmptyState title="Noch nichts für heute">Sobald Module wie Aufgaben oder News aktiv sind, erscheint hier dein Überblick.</EmptyState>
      ) : (
        <section aria-label="Überblick" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {widgets.map(({ id, Component, size }) => (
            <div key={id} data-widget={id} className={cn("min-w-0", size === "wide" && "md:col-span-2", size === "full" && "col-span-full")}>
              <Suspense fallback={<WidgetSkeleton />}>
                <Component current={current} />
              </Suspense>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
