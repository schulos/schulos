import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { canDesk } from "@/modules/buecherei/loans";
import { canStock } from "@/modules/buecherei/service";

/** Einstieg aus der Navigation: Theke für das Büchereiteam, sonst der Bestand. */
export default async function BuechereiPage() {
  const { perms } = await requireUser();
  if (canDesk(perms)) redirect("/buecherei/theke");
  if (canStock(perms)) redirect("/buecherei/bestand");
  notFound();
}
