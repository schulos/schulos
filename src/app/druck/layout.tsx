import { requireInternalPage } from "@/core/modules/guard";

/** GT-15: Druckansichten gehören zu Bereichen außerhalb des Ganztags – externe Ganztags-Leitungen → 404. */
export default async function DruckLayout({ children }: { children: React.ReactNode }) {
  await requireInternalPage();
  return children;
}
