"use client";

import { useActionState } from "react";
import { logoUrl, type LogoVariant, type SchoolLogos } from "@/core/school/logo-meta";
import type { FormState } from "@/modules/verwaltung/actions";
import { SchoolLogo } from "@/ui/school-logo";
import { Button } from "@schulos/ui/button";
import { Logo } from "@schulos/ui/misc";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

const FIELDS: { variant: LogoVariant; title: string; hint: string; label: string }[] = [
  {
    variant: "logo",
    title: "Logo",
    hint: "Erscheint bei der Anmeldung, in der Seitenleiste und auf Ausdrucken. Am besten quer mit Schriftzug.",
    label: "Logo-Datei",
  },
  {
    variant: "dark",
    title: "Logo für dunkle Darstellung",
    hint: "Optional: Variante mit heller Schrift. Ohne sie steht das Logo im dunklen Modus auf einer hellen Fläche.",
    label: "Datei für dunkle Darstellung",
  },
  {
    variant: "symbol",
    title: "Symbol",
    hint: "Optional: (fast) quadratisches Zeichen ohne Schrift – für den Browser-Tab, Monitore und schmale Bildschirme.",
    label: "Symbol-Datei",
  },
];

const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const TYPE_LABEL: Record<string, string> = { "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP", "image/svg+xml": "SVG" };

/** Abschnitt „Erscheinungsbild“ (P4-03): drei Felder mit Vorschau hell/dunkel. */
export function LogoSection({ logos, name, upload, remove }: { logos: SchoolLogos; name: string; upload: Action; remove: Action }) {
  return (
    <div className="grid gap-4">
      {FIELDS.map((f) => (
        <LogoField key={f.variant} {...f} logos={logos} name={name} upload={upload} remove={remove} />
      ))}
      <p className="text-xs text-muted">
        PNG, JPEG, WebP oder SVG; Logo bis 1 MB, Symbol bis 512 KB. SVG-Dateien mit Skripten oder Verweisen auf fremde Inhalte werden aus
        Sicherheitsgründen abgelehnt – dann hilft ein Export als PNG.
      </p>
    </div>
  );
}

function LogoField({
  variant,
  title,
  hint,
  label,
  logos,
  name,
  upload,
  remove,
}: (typeof FIELDS)[number] & { logos: SchoolLogos; name: string; upload: Action; remove: Action }) {
  const [up, upAction, upPending] = useActionState(upload, {});
  const [rm, rmAction, rmPending] = useActionState(remove, {});
  const meta = logos[variant];
  // Vorschau zeigt genau diese Variante; beim Hauptlogo auch, wie es im Dunkeln erscheint (mit Variante bzw. auf heller Platte)
  const preview =
    variant === "dark" ? (
      meta ? (
        // eslint-disable-next-line @next/next/no-img-element -- Vorschau der Dunkel-Variante aus der Logo-Route
        <img src={logoUrl("dark", meta)} alt={`Logo ${name} (dunkel)`} className="max-h-12 max-w-full object-contain" />
      ) : (
        <Fallback variant={variant} />
      )
    ) : (
      <SchoolLogo
        logos={variant === "logo" ? { logo: logos.logo, dark: logos.dark } : { symbol: logos.symbol }}
        name={name}
        prefer={variant}
        className="max-h-12 max-w-full"
        fallback={<Fallback variant={variant} />}
      />
    );
  const inputId = `logo-file-${variant}`;
  const error = up.error ?? rm.error;
  return (
    <section aria-labelledby={`${inputId}-title`} className="grid gap-4 rounded-card border border-border p-4 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-3">
        <div>
          <h3 id={`${inputId}-title`} className="font-semibold">
            {title}
          </h3>
          <p className="text-sm text-muted">{hint}</p>
          {meta && (
            <p className="mt-1 text-xs text-muted">
              {TYPE_LABEL[meta.mime] ?? meta.mime} · {meta.width} × {meta.height} · {fmtBytes(meta.bytes)}
            </p>
          )}
        </div>
        <form action={upAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="variant" value={variant} />
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={inputId} className="text-sm font-medium">
              {label}
            </label>
            <input
              id={inputId}
              name="file"
              type="file"
              required
              accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg"
              aria-invalid={up.error ? true : undefined}
              className="max-w-full text-sm file:mr-3 file:h-9 file:rounded-xl file:border file:border-border file:bg-surface file:px-3 file:text-ink"
            />
          </div>
          <Button type="submit" size="sm" variant="primary" disabled={upPending}>
            {meta ? `${title} ersetzen` : `${title} hochladen`}
          </Button>
        </form>
        {meta && (
          <form action={rmAction}>
            <input type="hidden" name="variant" value={variant} />
            <Button type="submit" size="sm" variant="ghost" disabled={rmPending}>
              {title} entfernen
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {(up.ok || rm.ok) && !error && (
          <p role="status" className="text-sm text-success">
            Gespeichert.
          </p>
        )}
      </div>
      <div aria-label={`Vorschau ${title}`} role="group" className="grid grid-cols-2 gap-2 self-start text-xs">
        {(["light", "dark"] as const).map((theme) => (
          <div key={theme} data-theme={theme} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 text-ink">
            <span className="text-muted">{theme === "light" ? "hell" : "dunkel"}</span>
            <div className="grid h-16 place-items-center">
              {variant === "dark" && theme === "light" ? <span className="text-muted">nur im dunklen Modus</span> : preview}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Fallback({ variant }: { variant: LogoVariant }) {
  if (variant === "dark") return <span className="text-muted">wie Logo</span>;
  return <Logo className={variant === "symbol" ? "size-8" : "size-9"} />;
}
