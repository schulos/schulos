"use client";

import { Command } from "cmdk";
import { LogOut, Monitor, Moon, Search, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { logoutWithOfflineCheck } from "./abmelden";
import type { NavGroup } from "@/core/modules/registry";
import type { SearchHit } from "@/core/search";
import { ModuleIcon } from "@schulos/ui/icons";
import { Avatar, Kbd } from "@schulos/ui/misc";
import { searchAction } from "./search-actions";

const itemClass =
  "flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 text-[15px] text-ink data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent-ink";
const groupClass =
  "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted [&_[cmdk-group-heading]]:uppercase";

/** Einfache Filterung: alle Wörter müssen im Text vorkommen (Groß/Klein und Umlaute egal). */
function norm(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}
function matches(q: string, ...texts: string[]) {
  const hay = norm(texts.join(" "));
  return norm(q).split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

export function CommandPalette({ groups, userId }: { groups: NavGroup[]; userId: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);
  const router = useRouter();
  const { setTheme } = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("schulos:palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("schulos:palette", onOpen);
    };
  }, []);

  // Serversuche mit kurzer Verzögerung; veraltete Antworten werden verworfen.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const id = ++reqId.current;
    const t = setTimeout(() => {
      setLoading(true);
      void searchAction(term).then((res) => {
        if (id === reqId.current) {
          setHits(res);
          setLoading(false);
        }
      });
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  const onQueryChange = (value: string) => {
    setQ(value);
    if (value.trim().length < 2) {
      reqId.current++;
      setHits([]);
      setLoading(false);
    }
  };

  const close = () => {
    setOpen(false);
    onQueryChange("");
  };
  const run = (fn: () => void) => {
    close();
    fn();
  };

  const apps = [...groups.flatMap((g) => g.items), { moduleId: "apps", href: "/apps", label: "Alle Apps", icon: "LayoutGrid" }].filter(
    (a) => !q || matches(q, a.label, a.moduleId),
  );
  const commands = [
    { id: "theme-light", label: "Helles Design", keys: "theme hell light design", Icon: Sun, fn: () => setTheme("light") },
    { id: "theme-dark", label: "Dunkles Design", keys: "theme dunkel dark nacht design", Icon: Moon, fn: () => setTheme("dark") },
    { id: "theme-system", label: "Design wie System", keys: "theme system auto design", Icon: Monitor, fn: () => setTheme("system") },
    { id: "logout", label: "Abmelden", keys: "abmelden logout", Icon: LogOut, fn: () => void logoutWithOfflineCheck(userId) },
  ].filter((c) => !q || matches(q, c.label, c.keys));
  const hitGroups = [...new Set(hits.map((h) => h.group))];
  const nothing = apps.length === 0 && commands.length === 0 && hits.length === 0 && !loading;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(10_12_16/0.45)] backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[12vh] left-1/2 z-50 w-[min(640px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface text-ink shadow-card"
        >
          <Dialog.Title className="sr-only">Kommandopalette</Dialog.Title>
          <Command label="Kommandopalette" loop shouldFilter={false}>
            <div className="flex items-center gap-3 border-b border-border px-4">
              <Search className="size-5 shrink-0 text-muted" aria-hidden />
              <Command.Input
                autoFocus
                value={q}
                onValueChange={onQueryChange}
                placeholder="Wohin möchtest du? App, Person, Gruppe, Befehl …"
                className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-muted"
              />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[min(60vh,460px)] overflow-y-auto p-2">
              {nothing && <div className="px-3 py-8 text-center text-sm text-muted">Nichts gefunden.</div>}
              {hitGroups.map((g) => (
                <Command.Group key={g} heading={g} className={groupClass}>
                  {hits
                    .filter((h) => h.group === g)
                    .map((h) => (
                      <Command.Item key={h.id} value={h.id} onSelect={() => run(() => router.push(h.href))} className={itemClass}>
                        {h.avatar ? (
                          <Avatar label={h.avatar} tone="soft" className="size-7 rounded-lg text-[11px]" />
                        ) : (
                          <ModuleIcon name={h.icon ?? "Box"} className="size-5 text-muted" />
                        )}
                        <span className="flex min-w-0 flex-col leading-tight">
                          <span className="truncate">{h.title}</span>
                          {h.subtitle && <span className="text-xs text-muted">{h.subtitle}</span>}
                        </span>
                      </Command.Item>
                    ))}
                </Command.Group>
              ))}
              {apps.length > 0 && (
                <Command.Group heading="Apps" className={groupClass}>
                  {apps.map((a) => (
                    <Command.Item key={a.href} value={`app:${a.href}`} onSelect={() => run(() => router.push(a.href))} className={itemClass}>
                      <ModuleIcon name={a.icon} className="size-5 text-muted" />
                      {a.label}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {commands.length > 0 && (
                <Command.Group heading="Befehle" className={groupClass}>
                  {commands.map(({ id, label, Icon, fn }) => (
                    <Command.Item key={id} value={`cmd:${id}`} onSelect={() => run(fn)} className={itemClass}>
                      <Icon className="size-5 text-muted" aria-hidden /> {label}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {loading && hits.length === 0 && <div className="px-3 py-3 text-sm text-muted">Suche …</div>}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
