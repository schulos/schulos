import { requireModulePage } from "@/core/modules/guard";

/** Schulanmeldung für Familien mit Konto (P4-34b) – nur bei eingeschaltetem Modul. */
export default async function SchulanmeldungLayout({ children }: { children: React.ReactNode }) {
  await requireModulePage("anmeldung");
  return children;
}
