import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser, requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { resolveLabelCode } from "@/core/etiketten/service";
import { requireModulePage } from "@/core/modules/guard";

export const metadata: Metadata = { title: "Inventar", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * INV-02 Inventar-Etikett `/i/<code>`: ohne Anmeldung immer nur die Anmeldeseite – **bevor** der Code gelesen wird, damit gültige
 * und ungültige Codes von außen gleich aussehen (abfotografierte Etiketten verraten nichts, SICHERHEIT.md S89/S95). Nach der
 * Anmeldung (`next`) Weiterleitung auf die Asset-Seite, die selbst nach Rechten filtert (inv-5); unbekannter Code → 404.
 */
export default async function InventarQrPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!(await getCurrentUser())) redirect(`/login?next=${encodeURIComponent(`/i/${encodeURIComponent(code.slice(0, 64))}`)}`);
  await requireUser(); // Startpasswort/2FA offen → dorthin, ohne Auflösung
  await requireModulePage("gebaeude");
  const assetId = await resolveLabelCode(await getDb(), "inventar", code);
  if (!assetId) notFound();
  redirect(`/gebaeude/inventar/${encodeURIComponent(assetId)}`);
}
