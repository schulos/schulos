"use client";

import { Accessibility, AppWindow, Bug, ChevronDown, Clock, Code, Download, ImageIcon, KeyRound, LogOut, Mail, MonitorSmartphone, ShieldCheck, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { DropdownMenu } from "radix-ui";
import { demoLoginAction } from "@/app/(auth)/login/demo-actions";
import { logoutWithOfflineCheck } from "./abmelden";
import type { DemoAccount } from "@/core/auth/demo";
import { issueHref } from "@/core/source";
import { Avatar } from "@schulos/ui/misc";
import { ThemeMenuRadio } from "@schulos/ui/theme";

export interface ShellUser {
  name: string;
  avatar: string;
  photo?: string;
  roleLabel: string;
  detail?: string;
  /** Q5-25: Rolle Beratung pflegt Sprechzeiten und Raum selbst */
  officeHours?: boolean;
  /** Q5-05: eigenständige Schüler:innen – Einwilligung „Eltern weiter informieren“ */
  selfResponsible?: boolean;
}

export function UserMenu({
  user,
  userId,
  demoAccounts = [],
  source,
  issue,
}: {
  user: ShellUser;
  userId: string;
  demoAccounts?: DemoAccount[];
  /** AGPL § 13 (Q-4E-31): Link zum Quellcode, src/core/source.ts – fertige Beschriftung statt Feld „version“ (der
   * Notenbuch-Test sucht in Antworten nach Notenbuch-Feldnamen wie „version“) */
  source?: { href: string; label: string };
  /** „Problem melden“ (nur Verwaltung/Admin) – Bereich aus dem Pfad ohne IDs/Namen, src/core/source.ts */
  issue?: { base: string; withArea: boolean };
}) {
  const exportForm = useRef<HTMLFormElement>(null);
  const pathname = usePathname() ?? "/";
  return (
    // A11Y-01e: nicht modal – sonst versteckt Radix den Rest der Seite per aria-hidden, obwohl er fokussierbar bleibt (axe
    // „aria-hidden-focus“); Tab schließt das Menü wie im Menü-Muster vorgesehen
    <DropdownMenu.Root modal={false}>
      <form ref={exportForm} method="post" action="/api/eigenexport" hidden aria-hidden />
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex min-h-11 items-center gap-2.5 rounded-xl border border-border bg-surface py-1 pr-2 pl-1 text-left hover:bg-surface-2 sm:pr-3"
        >
          <Avatar label={user.avatar} src={user.photo} />
          <span className="hidden flex-col leading-tight sm:flex">
            <span className="text-sm font-semibold">{user.name}</span>
            <span className="text-xs text-muted">{user.detail ?? user.roleLabel}</span>
          </span>
          <ChevronDown className="hidden size-4 text-muted sm:block" aria-hidden />
          <span className="sr-only">Profilmenü öffnen</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] w-72 overflow-y-auto rounded-2xl border border-border bg-surface p-2 text-ink shadow-card"
        >
          <div className="flex items-center gap-3 px-2 py-2">
            <Avatar label={user.avatar} src={user.photo} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-semibold">{user.name}</span>
              <span className="text-xs text-muted">{user.roleLabel}</span>
            </div>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <div className="px-2 py-2">
            <DropdownMenu.Label className="mb-2 block text-xs font-medium text-muted">Darstellung</DropdownMenu.Label>
            <ThemeMenuRadio />
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item asChild className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm outline-none data-highlighted:bg-surface-2">
            <a href="/profilbild">
              <ImageIcon className="size-4" aria-hidden /> Profilbild
            </a>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm outline-none data-highlighted:bg-surface-2">
            <a href="/passwort">
              <KeyRound className="size-4" aria-hidden /> Passwort ändern
            </a>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm outline-none data-highlighted:bg-surface-2">
            <Link href="/konto/email">
              <Mail className="size-4" aria-hidden /> E-Mail-Adresse
            </Link>
          </DropdownMenu.Item>
          {user.officeHours && (
            <DropdownMenu.Item asChild className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm outline-none data-highlighted:bg-surface-2">
              <Link href="/konto/sprechzeiten">
                <Clock className="size-4" aria-hidden /> Sprechzeiten und Raum
              </Link>
            </DropdownMenu.Item>
          )}
          {user.selfResponsible && (
            <DropdownMenu.Item asChild className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm outline-none data-highlighted:bg-surface-2">
              <Link href="/konto/eltern">
                <Users className="size-4" aria-hidden /> Eltern informieren
              </Link>
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item asChild className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm outline-none data-highlighted:bg-surface-2">
            <a href="/zwei-faktor">
              <ShieldCheck className="size-4" aria-hidden /> Zwei-Faktor-Anmeldung und Sicherheitsschlüssel
            </a>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm outline-none data-highlighted:bg-surface-2">
            <Link href="/konto/sitzungen">
              <MonitorSmartphone className="size-4" aria-hidden /> Angemeldete Geräte
            </Link>
          </DropdownMenu.Item>
          {/* POST über das versteckte Formular statt Link (SEC-05): ein eingebettetes Bild startet keinen Export */}
          <DropdownMenu.Item
            onSelect={() => exportForm.current?.requestSubmit()}
            className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm outline-none data-highlighted:bg-surface-2"
          >
            <Download className="size-4" aria-hidden /> Meine Dateien und Abgaben herunterladen
          </DropdownMenu.Item>
          {/* P4-73: Installationshinweis */}
          <DropdownMenu.Item asChild className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm outline-none data-highlighted:bg-surface-2">
            <Link href="/konto/app">
              <AppWindow className="size-4" aria-hidden /> Als App installieren
            </Link>
          </DropdownMenu.Item>
          {/* A11Y-02: Erklärung zur Barrierefreiheit – die Shell hat keine Fußzeile, deshalb hier */}
          <DropdownMenu.Item asChild className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm outline-none data-highlighted:bg-surface-2">
            <a href="/barrierefreiheit">
              <Accessibility className="size-4" aria-hidden /> Erklärung zur Barrierefreiheit
            </a>
          </DropdownMenu.Item>
          {source && (
            <DropdownMenu.Item asChild className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm outline-none data-highlighted:bg-surface-2">
              <a href={source.href} rel="noopener noreferrer" target="_blank">
                <Code className="size-4" aria-hidden /> {source.label}
              </a>
            </DropdownMenu.Item>
          )}
          {issue && (
            <DropdownMenu.Item asChild className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm outline-none data-highlighted:bg-surface-2">
              <a href={issueHref(issue, pathname)} rel="noopener noreferrer" target="_blank">
                <Bug className="size-4" aria-hidden /> Problem melden
              </a>
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {demoAccounts.length > 0 && (
            <>
              <DropdownMenu.Label className="flex items-center gap-2 px-2 pt-1 pb-1.5 text-xs font-medium text-muted">
                <Users className="size-3.5" aria-hidden /> Ansicht wechseln (Demo)
              </DropdownMenu.Label>
              {demoAccounts.map((a) => (
                <DropdownMenu.Item
                  key={a.username}
                  onSelect={() => void demoLoginAction(a.username)}
                  className="flex min-h-10 cursor-pointer flex-col justify-center rounded-lg px-2 py-1 outline-none data-highlighted:bg-surface-2"
                >
                  <span className="text-sm font-medium">{a.name}</span>
                  <span className="text-xs text-muted">{a.label}</span>
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
            </>
          )}
          <DropdownMenu.Item
            onSelect={() => void logoutWithOfflineCheck(userId)}
            className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm text-danger outline-none data-highlighted:bg-danger-soft"
          >
            <LogOut className="size-4" aria-hidden /> Abmelden
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
