import { requireInternalPage } from "@/core/modules/guard";

/** GT-15: Raumfinder und Raumsteckbriefe nur für Konten der Schule – externe Ganztags-Leitungen → 404. */
export default async function RaeumeLayout({ children }: { children: React.ReactNode }) {
  await requireInternalPage();
  return children;
}
