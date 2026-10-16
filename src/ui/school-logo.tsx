import { logoUrl, type LogoMeta, type LogoVariant, type SchoolLogos } from "@/core/school/logo-meta";
import { cn } from "@schulos/ui/cn";

/**
 * Schullogo (P4-04) – immer als <img> (Q-12: SVG nie inline, nie <object>; im <img>-Kontext laufen keine Skripte).
 * Dunkle Darstellung: mit Variante „dunkel“ werden beide Bilder ausgegeben und per CSS-Variable aus dem nächsten
 * `data-theme` umgeschaltet (globals.css) – das folgt dem Theme-Schalter und den hellen Druckansichten; ohne Variante
 * liegt das Logo im Dunkeln auf einer hellen Platte. Ohne Logo erscheint `fallback`.
 * Rein darstellend (Server- und Client-Komponenten); `className` setzt Höhe/Breite, z. B. „h-16 max-w-full“.
 */
export function SchoolLogo({
  logos,
  name,
  prefer = "logo",
  className,
  fallback = null,
}: {
  logos: SchoolLogos;
  name: string;
  /** „symbol“: quadratisches Zeichen bevorzugen (Monitor, schmale Kopfzeile) */
  prefer?: "logo" | "symbol";
  className?: string;
  fallback?: React.ReactNode;
}) {
  const order: LogoVariant[] = prefer === "symbol" ? ["symbol", "logo"] : ["logo", "symbol"];
  const variant = order.find((v) => logos[v]);
  if (!variant) return <>{fallback}</>;
  const dark = variant === "logo" ? logos.dark : undefined;
  const img = (v: LogoVariant, meta: LogoMeta, cls: string) => (
    // eslint-disable-next-line @next/next/no-img-element -- kleine, versionierte Datei aus der eigenen Logo-Route, kein Bild-Optimierer
    <img
      key={v}
      src={logoUrl(v, meta)}
      alt={`Logo ${name}`}
      width={meta.width}
      height={meta.height}
      data-logo={v}
      className={cn("w-auto object-contain", cls, className)}
    />
  );
  if (dark) return [img("logo", logos[variant]!, "school-logo-light"), img("dark", dark, "school-logo-dark")];
  return img(variant, logos[variant]!, "school-logo-plate");
}
