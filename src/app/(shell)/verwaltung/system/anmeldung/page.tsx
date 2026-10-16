import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { requestNetwork } from "@/core/auth/pflicht";
import { defaultSchoolNets, forwardedClientIp, trustedProxies } from "@/core/auth/schulnetz";
import { requireUser } from "@/core/auth/session";
import { IDLE_OPTIONS, idleLabel } from "@/core/auth/sitzungen";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { readSecuritySettings } from "@/core/settings";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { SecuritySettingsForm } from "./forms";

export const metadata: Metadata = { title: "Anmeldung" };
export const dynamic = "force-dynamic";

export default async function AnmeldungPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.system")) notFound();
  const db = await getDb();
  const h = await headers();
  const [settings, network] = await Promise.all([readSecuritySettings(db), requestNetwork(db, h)]);
  const ip = forwardedClientIp(h, trustedProxies());
  const inside = network === "schulnetz";

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Verwaltung · System" title="Anmeldung" />
      <p className="text-sm text-muted">
        Zwei-Faktor-Pflicht (SEC-01): Verwaltung, Schulleitung, Beratung und Admin immer; Lehrkräfte, Personal und Eltern ab dem Stichtag;
        Schüler:innen nur, wenn sie sich von außerhalb des Schulnetzes anmelden. Zum ersten Mal einrichten geht nur im Schulnetz (Eltern auch von zu
        Hause) – sonst gibt das Sekretariat die Einrichtung je Konto frei.{" "}
        <Link href="/verwaltung/system" className="text-accent-ink underline underline-offset-2">
          Zurück zu System
        </Link>
      </p>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        Diese Anfrage: <Badge tone={inside ? "success" : "warn"}>{inside ? "im Schulnetz" : "außerhalb des Schulnetzes"}</Badge>
        <span className="text-muted">{ip ? `Adresse ${ip}` : "ohne Proxy-Angabe (Entwicklung) – gilt als Schulnetz"}</span>
      </p>
      {!inside && (
        <p role="alert" className="rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm text-warn">
          Du bist gerade außerhalb des Schulnetzes – ändern geht nur im Schulnetz.
        </p>
      )}
      <Card aria-label="Schulnetz, Zwei-Faktor-Pflicht, Inaktivität">
        <CardHeader title="Schulnetz, Zwei-Faktor-Pflicht, Inaktivität" />
        <SecuritySettingsForm schoolNets={settings.schoolNets ?? ""} defaultNets={defaultSchoolNets()} twoFactorFrom={settings.twoFactorFrom ?? ""}
          idleMinutes={settings.idleMinutes}
          idleOptions={IDLE_OPTIONS.map((m) => ({ value: m, label: idleLabel(m) }))}
        />
      </Card>
    </main>
  );
}
