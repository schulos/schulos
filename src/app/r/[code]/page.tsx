import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser, requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { resolveLabelCode } from "@/core/etiketten/service";
import { roomHref } from "@/core/room-href";

export const metadata: Metadata = { title: "Raum", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * RS-11 Tür-QR `/r/<code>`: ohne Anmeldung immer nur die Anmeldeseite – **bevor** der Code gelesen wird, damit gültige und
 * ungültige Codes von außen gleich aussehen (abfotografierte Codes verraten nichts, SICHERHEIT.md). Ohne Sitzungs-Cookie leitet
 * schon der Proxy um; diese Seite deckt abgelaufene Sitzungen ab. Nach der Anmeldung (`next`) Weiterleitung auf den Steckbrief,
 * der selbst nach Rolle filtert; unbekannter Code → 404.
 */
export default async function TuerQrPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!(await getCurrentUser())) redirect(`/login?next=${encodeURIComponent(`/r/${encodeURIComponent(code.slice(0, 64))}`)}`);
  await requireUser(); // Startpasswort/2FA offen → dorthin, ohne Auflösung
  const roomId = await resolveLabelCode(await getDb(), "raum", code);
  if (!roomId) notFound();
  redirect(roomHref(roomId));
}
