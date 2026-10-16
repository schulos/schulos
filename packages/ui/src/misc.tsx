import { cn } from "./cn";

/** Avatar mit Initialen bzw. Lehrkraft-Kürzel – oder Profilbild, wenn eine Einwilligung vorliegt (`src`). */
export function Avatar({
  label,
  className,
  tone = "ink",
  src,
}: {
  label: string;
  className?: string;
  tone?: "ink" | "soft" | "warn";
  src?: string;
}) {
  if (src)
    return (
      // eslint-disable-next-line @next/next/no-img-element -- geschützte Route mit Sitzung, kein Bild-Optimierer
      <img src={src} alt="" aria-hidden className={cn("size-9 shrink-0 rounded-[10px] bg-surface-2 object-cover", className)} />
    );
  const tones = {
    ink: "bg-ink text-surface",
    soft: "bg-accent-soft text-accent-ink",
    warn: "bg-warn-soft text-warn",
  };
  return (
    <span
      aria-hidden
      className={cn("grid size-9 shrink-0 place-items-center rounded-[10px] text-[13px] font-semibold", tones[tone], className)}
    >
      {label}
    </span>
  );
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase();
}

export function Progress({ value, color, label }: { value: number; color?: string; label: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-2 overflow-hidden rounded-full bg-surface-2 ring-1 ring-border ring-inset"
    >
      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

/** Fachfarbe als Balken – nie als Textfarbe (Kontrast). */
export function SubjectBar({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("block h-1 rounded-full", className)} style={{ background: color }} />;
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-sans text-xs text-muted">
      {children}
    </kbd>
  );
}

export function PageHeader({
  title,
  eyebrow,
  actions,
}: {
  title: string;
  eyebrow?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        {eyebrow && <span className="font-medium text-muted">{eyebrow}</span>}
        <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">{title}</h1>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-border-strong px-6 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

/** Logo: vier Kacheln – Module als Apps. */
export function Logo({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("grid size-9 grid-cols-2 gap-[3px]", className)}>
      <span className="rounded-[5px] bg-accent" />
      <span className="rounded-[5px] bg-ink" />
      <span className="rounded-[5px] bg-ink" />
      <span className="rounded-[5px] bg-border-strong" />
    </span>
  );
}

/**
 * Dauerhaftes Band einer Demo-Instanz (INSTALLATION.md §3.4). Mit `preview`: Vorschau-Instanz (§5a.3) – zeigt die
 * nächste Version mit Demo-Daten, die jede Nacht zurückgesetzt werden.
 */
export function DemoBand({ preview }: { preview?: string | null }) {
  // A11Y-01a: eigener Bereich (aside mit Namen) – sonst liegt der Hinweis außerhalb aller Landmarken (axe „region“)
  return (
    <aside aria-label="Demo-Band" className="border-b border-warn-border bg-warn-soft px-4 py-1.5 text-center text-xs font-semibold text-warn">
      <p role="note">
        {preview
          ? `VORSCHAU auf SchulOS ${preview} – Demo-Daten, werden jede Nacht zurückgesetzt; keine echten Daten eingeben`
          : "DEMO – keine echten Daten eingeben"}
      </p>
    </aside>
  );
}
