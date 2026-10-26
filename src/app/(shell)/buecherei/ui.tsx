import Link from "next/link";
import type { PermissionSet } from "@/core/permissions";
import type { CatalogRow } from "@/modules/buecherei/katalog";
import { Badge } from "@schulos/ui/badge";
import { canUse } from "@/modules/buecherei/katalog";
import { canDesk } from "@/modules/buecherei/loans";
import { canStock } from "@/modules/buecherei/service";
import { getDb } from "@/core/db/client";
import { canMaterials, canReadBooklist, lernmittelEnabled } from "@/modules/buecherei/lernmittel";

const SECTIONS = [
  { key: "katalog", href: "/buecherei/katalog", label: "Katalog", allowed: canUse },
  { key: "meine", href: "/buecherei/meine", label: "Meine Ausleihen", allowed: (p: PermissionSet) => canUse(p) || p.role === "eltern" },
  { key: "theke", href: "/buecherei/theke", label: "Theke", allowed: canDesk },
  { key: "mahnliste", href: "/buecherei/mahnliste", label: "Mahnliste", allowed: canDesk },
  { key: "bestand", href: "/buecherei/bestand", label: "Bestand", allowed: canStock },
  { key: "ausweise", href: "/buecherei/ausweise", label: "Ausweise", allowed: canDesk },
  { key: "etiketten", href: "/buecherei/etiketten", label: "Etiketten", allowed: canStock },
  { key: "statistik", href: "/buecherei/statistik", label: "Statistik", allowed: canStock },
  // Stufe 2 (BU-10): nur mit eingeschalteter Schulbuchausleihe
  { key: "lernmittel", href: "/buecherei/lernmittel", label: "Lernmittel", allowed: canMaterials, stage2: true },
  { key: "ausgabe", href: "/buecherei/ausgabe", label: "Schulbuchausgabe", allowed: canMaterials, stage2: true },
  { key: "ersatz", href: "/buecherei/ersatz", label: "Ersatzforderungen", allowed: canMaterials },
  { key: "buecherliste", href: "/buecherei/buecherliste", label: "Bücherliste", allowed: canReadBooklist, stage2: true },
] as const;

export type BuechereiSection = (typeof SECTIONS)[number]["key"];

/**
 * Bereiche der Bücherei nach Recht (Katalog: `use`, Meine Ausleihen: `use` oder Eltern, Theke, Mahnliste und Ausweise: `desk`,
 * Bestand, Etiketten und Statistik: `stock`; mit Schulbuchausleihe Lernmittel: `materials`, Bücherliste: alle mit Bücherei-Zugang).
 */
export async function BuechereiNav({ current, perms }: { current: BuechereiSection; perms: PermissionSet }) {
  const stage2 = await lernmittelEnabled(await getDb());
  const visible = SECTIONS.filter((s) => s.allowed(perms) && (stage2 || !("stage2" in s)));
  if (visible.length < 2) return null;
  return (
    <nav aria-label="Bücherei" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex w-max gap-1 rounded-xl border border-border bg-surface p-1">
        {visible.map((s) => (
          <li key={s.key}>
            <Link
              href={s.href}
              aria-current={s.key === current ? "page" : undefined}
              className={
                s.key === current
                  ? "flex h-9 items-center rounded-lg bg-accent-soft px-3 text-sm font-semibold whitespace-nowrap text-accent-ink"
                  : "flex h-9 items-center rounded-lg px-3 text-sm whitespace-nowrap text-muted transition hover:text-ink"
              }
            >
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const shortDay = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
const dayShort = (ymd: string) => shortDay.format(new Date(`${ymd}T00:00:00Z`));

/** Verfügbarkeit ohne Personenbezug: frei im Regal, sonst nächste Rückgabe und Zahl der Vormerkungen. */
export function AvailabilityBadge({ t }: { t: Pick<CatalogRow, "shelf" | "active" | "nextDue" | "waiting" | "ready"> }) {
  if (t.shelf > 0)
    return (
      <Badge tone="success">
        {t.shelf} von {t.active} im Regal
      </Badge>
    );
  const queue = t.waiting + t.ready;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge tone="warn">ausgeliehen{t.nextDue ? ` · zurück ab ${dayShort(t.nextDue)}` : ""}</Badge>
      {queue > 0 && <span className="text-xs text-muted">{queue === 1 ? "1 Vormerkung" : `${queue} Vormerkungen`}</span>}
    </span>
  );
}

