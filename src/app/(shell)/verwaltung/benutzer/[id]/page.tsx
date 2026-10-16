import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { realEmail } from "@/core/auth/email";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { ROLES } from "@/core/db/schema";
import { GROUP_KIND_LABELS, ROLE_LABELS } from "@/core/labels";
import { hasPermission, loadPermissions, twoFactorDuty } from "@/core/permissions";
import { readSchoolSettings, readSecuritySettings } from "@/core/settings";
import { codeListStatus } from "@/core/auth/codeliste";
import { secondFactorMethods } from "@/core/auth/passkeys";
import { mailAvailable } from "@/core/mail";
import { accountGraceDays } from "@/core/privacy/konto";
import { canWithdraw, consentAuthority, photoOf, photoUrl } from "@/core/privacy/profilbild";
import { addDays, toBerlinDate, TZ } from "@/core/time";
import { updateUserAction } from "@/modules/verwaltung/actions";
import { actorFromPerms, assignableRoles, manageProblem } from "@/modules/verwaltung/escalation";
import { getUserDetail } from "@/modules/verwaltung/users";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { UserForm } from "../user-form";
import { TwoFactorCardBody } from "./two-factor-card";
import { ParentsCard } from "./parents-card";
import { SelfResponsibleCard } from "./self-responsible-card";
import { UserActions } from "./user-actions";
import { EmailLinkButton } from "./email-link";
import { PhotoCardBody } from "../../../profilbild/photo-card";

export const metadata: Metadata = { title: "Benutzer bearbeiten" };

const releaseFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

export default async function BenutzerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms, user: me } = await requireUser();
  if (!hasPermission(perms, "verwaltung.users")) notFound();
  const { id } = await params;
  const db = await getDb();
  const detail = await getUserDetail(db, decodeURIComponent(id));
  if (!detail) notFound();
  const { user, memberships, parents, children } = detail;
  const photo = await photoOf(db, user.id);
  const isSelf = user.id === me.id;
  const theirPerms = await loadPermissions(db, user.id);
  const duty = twoFactorDuty(user.role, theirPerms.granted, (await readSecuritySettings(db)).twoFactorFrom, toBerlinDate(new Date()));
  const dutyLabel = duty.required
    ? { label: "Pflicht für dieses Konto", strict: true }
    : duty.dueOn
      ? { label: `Pflicht ab ${duty.dueOn.slice(8, 10)}.${duty.dueOn.slice(5, 7)}.${duty.dueOn.slice(0, 4)}`, strict: false }
      : duty.outsideOnly
        ? { label: "Pflicht nur bei Anmeldung von außerhalb des Schulnetzes", strict: false }
        : null;
  const codeList = await codeListStatus(db, user.id);
  const methods = await secondFactorMethods(db, user.id);
  const releasedUntil = user.twoFactorSetupUntil && user.twoFactorSetupUntil > new Date() ? releaseFmt.format(user.twoFactorSetupUntil) : null;
  // SEC-04: Admin-Konten und Konten mit mehr Verwaltungsrechten verwaltet nur ein Admin; die eigene Rolle ändern andere
  const actor = actorFromPerms(perms);
  const blocked = isSelf ? null : await manageProblem(db, actor, user.id);
  const assignable = await assignableRoles(db, actor, ROLES);
  const roles = isSelf ? [user.role] : ROLES.filter((r) => r === user.role || assignable.includes(r));

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`${ROLE_LABELS[user.role]} · ${user.username}`}
        title={user.name}
        actions={user.status === "locked" ? <Badge tone="danger">{user.leftOn ? "Abgang" : "Gesperrt"}</Badge> : undefined}
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Stammdaten" />
          {blocked ? (
            <p className="text-sm text-muted">{blocked}</p>
          ) : (
            <UserForm
              mode="edit"
              action={updateUserAction.bind(null, user.id)}
              initial={{ firstName: user.firstName, lastName: user.lastName, role: user.role, shortCode: user.shortCode, username: user.username, email: realEmail(user.email), emailVerified: user.emailVerified, officeHours: user.officeHours }}
              roles={roles}
              roleHint={isSelf ? "Deine eigene Rolle kann nur jemand anderes ändern" : undefined}
            />
          )}
          {!blocked && realEmail(user.email) && !user.emailVerified && user.status === "active" && <EmailLinkButton id={user.id} mailOn={mailAvailable()} />}
        </Card>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Konto" />
            <UserActions
              id={user.id}
              locked={user.status === "locked"}
              isSelf={user.id === me.id}
              leftOn={user.leftOn}
              deleteFrom={user.leftOn ? addDays(user.leftOn, await accountGraceDays(db)) : null}
              erasureRequested={Boolean(user.erasureRequestedOn)}
              today={toBerlinDate(new Date())}
              canPrivacy={hasPermission(perms, "verwaltung.privacy")}
              blocked={blocked}
            />
          </Card>
          <Card aria-label="Zwei-Faktor-Anmeldung">
            <CardHeader title="Zwei-Faktor-Anmeldung" />
            <TwoFactorCardBody
              id={user.id}
              enabled={user.twoFactorEnabled}
              duty={dutyLabel}
              releasedUntil={releasedUntil}
              releasable={user.role !== "eltern"}
              isSelf={isSelf}
              canManage={!blocked && hasPermission(perms, "verwaltung.zwei_faktor")}
              methods={methods}
              codeList={codeList && { remaining: codeList.remaining, total: codeList.total, createdAt: releaseFmt.format(codeList.createdAt) }}
              student={user.role === "schueler" ? { name: user.name, className: memberships.find((m) => m.kind === "klasse")?.name ?? null, school: (await readSchoolSettings(db)).name } : null}
            />
          </Card>
          <Card aria-label="Profilbild">
            <CardHeader title="Profilbild" />
            <PhotoCardBody
              id={user.id}
              name={user.name}
              own={isSelf}
              photo={photo}
              url={photoUrl(user.id, photo?.createdAt)}
              basis={consentAuthority(perms, user, false)}
              canWithdraw={canWithdraw(perms, user, false)}
              today={toBerlinDate(new Date())}
            />
          </Card>
          <Card>
            <CardHeader title={`Gruppen (${memberships.length})`} />
            <ul className="flex flex-col gap-2">
              {memberships.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <Link href={`/verwaltung/gruppen/${m.id}`} className="font-medium hover:underline">
                    {m.name}
                  </Link>
                  <span className="flex gap-1.5">
                    <Badge>{GROUP_KIND_LABELS[m.kind]}</Badge>
                    {m.role === "leader" && <Badge tone="soft">Leitung</Badge>}
                  </span>
                </li>
              ))}
              {memberships.length === 0 && <li className="text-sm text-muted">Keine Gruppen</li>}
            </ul>
          </Card>
          {user.role === "schueler" && (
            <Card aria-label="Eigenständig (volljährig)">
              <CardHeader title="Eigenständig (volljährig)" />
              <SelfResponsibleCard id={user.id} on={user.selfResponsible} parentsInformed={Boolean(user.parentsInformedSince)} canEdit={!blocked} />
            </Card>
          )}
          {user.role === "schueler" && (
            <Card aria-label="Eltern">
              <CardHeader title={`Eltern (${parents.length})`} />
              <ParentsCard childId={user.id} parents={parents} canEdit={!blocked} />
            </Card>
          )}
          {user.role !== "schueler" && (parents.length > 0 || children.length > 0) && (
            <Card aria-label={parents.length > 0 ? "Eltern" : "Kinder"}>
              <CardHeader title={parents.length > 0 ? "Eltern" : "Kinder"} />
              <ul className="flex flex-col gap-2">
                {[...parents, ...children].map((p) => (
                  <li key={p.id}>
                    <Link href={`/verwaltung/benutzer/${p.id}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </main>
  );
}
