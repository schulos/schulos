import { requireModulePage } from "@/core/modules/guard";

/** Modul ausgeschaltet → alle Seiten des Moduls 404 (Modulsperre). */
export default async function ModuleLayout({ children }: { children: React.ReactNode }) {
  await requireModulePage("gebaeude");
  return children;
}
