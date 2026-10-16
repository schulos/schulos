"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { ThemeProvider as NextThemes, useTheme } from "next-themes";
import { DropdownMenu } from "radix-ui";
import { useSyncExternalStore } from "react";
import { cn } from "./cn";

export function ThemeProvider({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return (
    <NextThemes attribute="data-theme" defaultTheme="system" enableSystem disableTransitionOnChange nonce={nonce}>
      {children}
    </NextThemes>
  );
}

const subscribe = () => () => {};
/** true erst nach der Hydration – vorher kennt der Server das Theme nicht. */
function useMounted() {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

const OPTIONS = [
  { value: "light", label: "Hell", Icon: Sun },
  { value: "dark", label: "Dunkel", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

/**
 * A11Y-01e: Hell / Dunkel / System als Auswahl **innerhalb eines Menüs** (Radix DropdownMenu). Ein `radiogroup` mitten in einem
 * `menu` ist für Hilfstechnik ungültig (axe „aria-required-children“) und mit den Pfeiltasten des Menüs nicht erreichbar.
 */
export function ThemeMenuRadio({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  return (
    <DropdownMenu.RadioGroup
      aria-label="Darstellung"
      value={mounted ? (theme ?? "system") : ""}
      onValueChange={setTheme}
      className={cn("flex rounded-xl border border-border bg-surface-2 p-1", className)}
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <DropdownMenu.RadioItem
          key={value}
          value={value}
          // Menü bleibt offen – die Wahl soll sofort sichtbar sein
          onSelect={(e) => e.preventDefault()}
          className={cn(
            "inline-flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm text-muted transition outline-none",
            "data-highlighted:ring-2 data-highlighted:ring-accent data-[state=checked]:bg-surface data-[state=checked]:text-ink data-[state=checked]:shadow-card",
          )}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </DropdownMenu.RadioItem>
      ))}
    </DropdownMenu.RadioGroup>
  );
}

/** Segmentierter Umschalter Hell / Dunkel / System. */
export function ThemeSwitch({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  return (
    <div role="radiogroup" aria-label="Darstellung" className={cn("inline-flex rounded-xl border border-border bg-surface-2 p-1", className)}>
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = mounted && theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted transition",
              active && "bg-surface text-ink shadow-card",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}
