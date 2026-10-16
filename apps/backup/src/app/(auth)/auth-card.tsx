import { Logo } from "@schulos/ui/misc";

/** Rahmen für Anmeldung und Zwei-Faktor-Seiten (außerhalb der App-Shell). */
export function AuthCard({ title, subtitle, wide, children }: { title: string; subtitle?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-ground px-4 py-10">
      <div className={`w-full ${wide ? "max-w-2xl" : "max-w-sm"} rounded-2xl border border-border bg-surface p-8 shadow-card`}>
        <div className="mb-6 flex items-center gap-3">
          <Logo />
          <div>
            <h1 className="font-display text-xl font-bold tracking-tight">{title}</h1>
            <p className="text-xs text-muted">{subtitle ?? "SchulOS Backup"}</p>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}

/** Ziel nach der Anmeldung – gemeinsame, strenge Prüfung (SEC-04). */
export { safeNext } from "@schulos/server/safe-next";
