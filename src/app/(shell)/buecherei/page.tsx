import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { canUse } from "@/modules/buecherei/katalog";
import { canDesk } from "@/modules/buecherei/loans";
import { canStock } from "@/modules/buecherei/service";

/** Einstieg aus der Navigation: Theke für das Büchereiteam, sonst der Katalog (BU-03), der Bestand bzw. für Eltern „Meine Ausleihen“. */
export default async function BuechereiPage() {
  const { perms } = await requireUser();
  if (canDesk(perms)) redirect("/buecherei/theke");
  if (canUse(perms)) redirect("/buecherei/katalog");
  if (canStock(perms)) redirect("/buecherei/bestand");
  if (perms.role === "eltern") redirect("/buecherei/meine");
  notFound();
}
