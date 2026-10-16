import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { readSchoolSettings } from "@/core/settings";
import { removeLogoAction, uploadLogoAction } from "@/modules/verwaltung/logo-actions";
import { importSchulprofilAction, saveA11yStatementAction, saveImpressumAction, saveSchoolAction } from "@/modules/verwaltung/school-actions";
import { instanceTypeInDb } from "@/core/instance";
import { defaultEnforcement, readA11yStatement } from "@/core/school/barrierefreiheit";
import { readImpressum } from "@/core/school/impressum";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { LogoSection } from "./logo-form";
import { BarrierefreiheitForm } from "./barrierefreiheit-form";
import { ImpressumForm } from "./impressum-form";
import { SchulprofilSection } from "./schulprofil-form";
import { SchoolForm } from "./school-form";

export const metadata: Metadata = { title: "Schule" };

export default async function SchulePage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.school")) notFound();
  const db = await getDb();
  const [s, impressum, a11y, instance] = await Promise.all([readSchoolSettings(db), readImpressum(db), readA11yStatement(db), instanceTypeInDb(db)]);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Verwaltung" title="Schule" />
      <Card>
        <SchoolForm action={saveSchoolAction} initial={{ name: s.name, number: s.number, color: s.color, ...s.profile }} />
      </Card>
      <Card aria-labelledby="erscheinungsbild">
        <CardHeader title={<span id="erscheinungsbild">Erscheinungsbild</span>} />
        <LogoSection logos={s.logos} name={s.name} upload={uploadLogoAction} remove={removeLogoAction} />
      </Card>
      <Card aria-labelledby="impressum" className="max-w-4xl">
        <CardHeader title={<span id="impressum">Impressum</span>} />
        <ImpressumForm
          action={saveImpressumAction}
          initial={{ ...impressum.fields, name: impressum.fields.name || s.name }}
          legacyText={impressum.complete ? "" : impressum.legacyText}
          missing={impressum.missing}
        />
      </Card>
      <Card aria-labelledby="barrierefreiheit" className="max-w-4xl">
        <CardHeader title={<span id="barrierefreiheit">Erklärung zur Barrierefreiheit</span>} />
        <BarrierefreiheitForm action={saveA11yStatementAction} initial={a11y} enforcementDefault={defaultEnforcement(s.profile.state)} />
      </Card>
      {/* P4-77: Zuschnitt der Schule für die Vorschau-Instanz – braucht zusätzlich die Rechteverwaltung */}
      {hasPermission(perms, "verwaltung.rights") && (
        <Card aria-labelledby="schulprofil" className="max-w-4xl">
          <CardHeader title={<span id="schulprofil">Schulprofil für die Vorschau</span>} />
          <SchulprofilSection importAction={importSchulprofilAction} demo={instance === "demo"} />
        </Card>
      )}
    </main>
  );
}
