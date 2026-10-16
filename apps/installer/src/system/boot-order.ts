// UEFI-Startreihenfolge nach der Installation (INST-01): grub-install läuft mit --removable --no-nvram (startet auch ohne
// NVRAM-Eintrag, auf jeder Platte des Spiegels) – es gibt also keinen festen Eintrag. Damit das Live-Medium eingelegt bleiben
// kann (es läuft noch, Entfernen gäbe I/O-Fehler), legt der Installer je Platte einen Eintrag „SchulOS“ auf
// \EFI\BOOT\BOOTX64.EFI (shim) an und setzt ihn an den Anfang von BootOrder. Logik rein, ausgeführt über `run`.
import type { Layout } from "./layout";

export const BOOT_LOADER = "\\EFI\\BOOT\\BOOTX64.EFI";

export interface EfiBoot {
  order: string[];
  entries: { num: string; label: string }[];
}

/** Ausgabe von `efibootmgr` (ohne -v): „BootOrder: 0003,0001“ und „Boot0003* SchulOS<TAB>HD(…)“ (v18: zwei Leerzeichen) */
export function parseEfibootmgr(out: string): EfiBoot {
  const order = /^BootOrder:\s*([0-9A-Fa-f,]*)\s*$/m.exec(out)?.[1]?.split(",").filter(Boolean).map((n) => n.toUpperCase()) ?? [];
  const entries: EfiBoot["entries"] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^Boot([0-9A-Fa-f]{4})\*?\s+(.*)$/.exec(line);
    if (m) entries.push({ num: m[1]!.toUpperCase(), label: m[2]!.split(/\t| {2,}/)[0]!.trim() });
  }
  return { order, entries };
}

/** Name des Eintrags je Platte: „SchulOS“, beim Spiegel „SchulOS (Platte 2)“ */
export const bootLabel = (i: number) => (i === 0 ? "SchulOS" : `SchulOS (Platte ${i + 1})`);
const isOurs = (label: string) => /^SchulOS( \(Platte \d\))?$/.test(label);

/** Neue Reihenfolge: `first` vorn (in dieser Folge), der Rest wie bisher ohne Doppelte */
export function newBootOrder(order: string[], first: string[]): string[] {
  return [...first, ...order.filter((n) => !first.includes(n))];
}

export type BootOrderResult = { ok: true; order: string[] } | { ok: false; reason: string };
export type RunSync = (argv: string[]) => { code: number; stdout: string; stderr: string };

/**
 * Alte SchulOS-Einträge (frühere Installation) löschen, je Platte einen neuen anlegen, diese vorn in BootOrder.
 * Scheitert ohne UEFI-Variablen (BIOS, gesperrtes NVRAM) – dann bleibt die Reihenfolge, wie sie war.
 */
export function setBootOrder(l: Pick<Layout, "disks">, run: RunSync): BootOrderResult {
  const read = (): EfiBoot | string => {
    const r = run(["efibootmgr"]);
    return r.code === 0 ? parseEfibootmgr(r.stdout) : r.stderr.trim().split("\n").pop() || `efibootmgr: Exit ${r.code}`;
  };
  const fail = (reason: string): BootOrderResult => ({ ok: false, reason });
  const before = read();
  if (typeof before === "string") return fail(before);
  for (const e of before.entries.filter((x) => isOurs(x.label))) run(["efibootmgr", "--quiet", "--bootnum", e.num, "--delete-bootnum"]);
  for (const [i, disk] of l.disks.entries()) {
    const r = run(["efibootmgr", "--quiet", "--create", "--disk", disk, "--part", "1", "--label", bootLabel(i), "--loader", BOOT_LOADER]);
    if (r.code !== 0) return fail(r.stderr.trim().split("\n").pop() || `Eintrag für ${disk}: Exit ${r.code}`);
  }
  const after = read();
  if (typeof after === "string") return fail(after);
  const ours = l.disks.map((_, i) => after.entries.find((e) => e.label === bootLabel(i))?.num);
  if (ours.some((n) => !n)) return fail("neue Einträge nicht gefunden");
  const order = newBootOrder(after.order, ours as string[]);
  const r = run(["efibootmgr", "--quiet", "--bootorder", order.join(",")]);
  if (r.code !== 0) return fail(r.stderr.trim().split("\n").pop() || `BootOrder: Exit ${r.code}`);
  const check = read();
  if (typeof check === "string" || check.order[0] !== order[0]) return fail("BootOrder wurde nicht übernommen");
  return { ok: true, order: check.order };
}
