import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { canUse } from "@/modules/buecherei/katalog";
import { canDesk } from "@/modules/buecherei/loans";
import { canStock } from "@/modules/buecherei/service";
import { getDb } from "@/core/db/client";
import { canMaterials, lernmittelEnabled } from "@/modules/buecherei/lernmittel";

/** Einstieg aus der Navigation: Theke für das Büchereiteam, sonst der Katalog (BU-03), der Bestand, die Lernmittel (BU-10) bzw. für Eltern „Meine Ausleihen“. */
export default async function BuechereiPage() {
  const { perms } = await requireUser();
  if (canDesk(perms)) redirect("/buecherei/theke");
  if (canUse(perms)) redirect("/buecherei/katalog");
  if (canStock(perms)) redirect("/buecherei/bestand");
  if (canMaterials(perms)) redirect((await lernmittelEnabled(await getDb())) ? "/buecherei/lernmittel" : "/buecherei/ersatz");
  if (perms.role === "eltern") redirect("/buecherei/meine");
  notFound();
}
