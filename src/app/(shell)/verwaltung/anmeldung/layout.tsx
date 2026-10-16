import { requireModulePage } from "@/core/modules/guard";

/** Modulsperre: ausgeschaltete Schulanmeldung → 404 für alle Verwaltungsseiten des Moduls. */
export default async function AnmeldungVerwaltungLayout({ children }: { children: React.ReactNode }) {
  await requireModulePage("anmeldung");
  return children;
}
