import Link from "next/link";
import { Logo } from "@schulos/ui/misc";
import { requireUser } from "@/auth/session";
import { logoutAction } from "../(auth)/login/actions";

const NAV = [
  { href: "/", label: "Übersicht" },
  { href: "/instanzen", label: "Instanzen" },
  { href: "/konten", label: "Konten" },
  { href: "/protokoll", label: "Protokoll" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="min-h-dvh bg-ground">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <Link href="/" className="flex items-center gap-3">
            <Logo className="size-7" />
            <span className="font-display text-lg font-bold tracking-tight">SchulOS Backup</span>
          </Link>
          <nav aria-label="Hauptnavigation" className="flex gap-1">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-2 hover:text-ink">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-muted">{user.name}</span>
            <Link href="/passwort" className="text-muted hover:underline">
              Passwort
            </Link>
            <Link href="/zwei-faktor" className="text-muted hover:underline">
              Zwei-Faktor
            </Link>
            <form action={logoutAction}>
              <button type="submit" className="rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-surface-2">
                Abmelden
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8">{children}</main>
    </div>
  );
}
