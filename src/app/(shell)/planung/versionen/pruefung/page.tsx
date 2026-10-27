import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ArrowLeft, Check, Eye, EyeOff, Send } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { schoolYears } from "@/core/db/schema";
import { hasPermission } from "@/core/permissions";
import { TZ, fromBerlinLocal } from "@/core/time";
import {
  addPlanCommentAction,
  approveVersionAction,
  resolvePlanCommentAction,
  returnVersionAction,
  setPreviewAction,
  submitVersionAction,
} from "@/modules/stundenplan/actions";
import {
  actorNames,
  allowedTransitions,
  canComment,
  canSeeVersion,
  commentTargets,
  listComments,
  PREVIEW_STATUSES,
  selfApproved,
  type CommentView,
  type Viewer,
} from "@/modules/stundenplan/planpruefung";
import { getVersion, OPEN_STATUSES, STATUS_LABELS, versionNumber } from "@/modules/stundenplan/planversionen";
import { PLAN_MANAGE, PLAN_REVIEW } from "@/modules/stundenplan/rechte";
import type { PlanVersionStatus } from "@/modules/stundenplan/schema";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { CommentForm } from "./comment-form";
import { ReturnForm } from "./return-form";

export const metadata: Metadata = { title: "Prüfung einer Planversion" };

const dateFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const date = (ymd: string) => dateFmt.format(fromBerlinLocal(ymd));

const TONES: Record<PlanVersionStatus, "neutral" | "soft" | "warn" | "success" | "danger"> = {
  entwurf: "warn",
  pruefung: "soft",
  freigegeben: "success",
  gueltig: "success",
  archiviert: "neutral",
  verworfen: "neutral",
};

const OK_TEXT: Record<string, string> = {
  eingereicht: "Zur Prüfung gegeben. Der Entwurf ist jetzt nur lesbar, bis er zurück an die Planung geht.",
  freigegeben: "Freigegeben. Veröffentlichen kann die Stundenplanung (bis dahin bleibt die Version freigegeben).",
  zurueck: "Zurück an die Planung – die Version ist wieder ein Entwurf, eine Freigabe ist verfallen.",
  "vorschau-an": "Lehrkräfte-Vorschau eingeschaltet.",
  "vorschau-aus": "Lehrkräfte-Vorschau ausgeschaltet.",
  kommentiert: "Kommentar gespeichert.",
  erledigt: "Kommentar erledigt.",
  "wieder-offen": "Kommentar wieder offen.",
};

function CommentItem({ c, versionId, manage }: { c: CommentView; versionId: string; manage: boolean }) {
  const done = c.comment.resolvedAt !== null;
  return (
    <li data-testid="kommentar" data-erledigt={done ? "ja" : "nein"} className="flex flex-col gap-1.5 rounded-card border border-border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">{c.targetText}</span>
        {c.comment.fromPreview && <Badge tone="soft">aus der Lehrkräfte-Vorschau</Badge>}
        {done && <Badge tone="success">erledigt</Badge>}
      </div>
      <p className="text-sm whitespace-pre-line [overflow-wrap:anywhere]">{c.comment.body}</p>
      <p className="text-xs text-muted">
        {c.authorName ?? "Konto gelöscht"} · {dateTimeFmt.format(c.comment.createdAt)}
        {done && c.comment.resolvedAt && ` · erledigt ${dateTimeFmt.format(c.comment.resolvedAt)}${c.resolvedByName ? ` von ${c.resolvedByName}` : ""}`}
      </p>
      {manage && (
        <form action={resolvePlanCommentAction.bind(null, c.comment.id, versionId, !done)}>
          <Button type="submit" size="sm" variant="ghost">
            {done ? "Wieder öffnen" : "Erledigt"}
          </Button>
        </form>
      )}
    </li>
  );
}

/**
 * SP3-03 (docs/STUNDENPLAN-LEBENSZYKLUS.md §2.1, §5): Prüfung einer Planversion – Status und Freigabe, „Zur Prüfung geben“ (Planung),
 * „Freigeben“/„Zurück an die Planung“ (Prüfung, `stundenplan.review`), Lehrkräfte-Vorschau ein/aus (Planung) und Kommentare. Die Prüfung sieht
 * Versionen erst ab „in Prüfung“; sonst 404 wie „gibt es nicht“.
 */
export default async function PruefungPage({ searchParams }: { searchParams: Promise<{ version?: string; ok?: string; fehler?: string }> }) {
  const { user, perms } = await requireUser();
  const viewer: Viewer = { userId: user.id, manage: hasPermission(perms, PLAN_MANAGE), review: hasPermission(perms, PLAN_REVIEW) };
  if (!viewer.manage && !viewer.review) notFound();
  const sp = await searchParams;
  if (!sp.version) notFound();
  const db = await getDb();
  const v = await getVersion(db, sp.version);
  if (!v || !canSeeVersion(viewer, v)) notFound();
  const [[year], comments, targets, names] = await Promise.all([
    db.select({ name: schoolYears.name }).from(schoolYears).where(eq(schoolYears.id, v.schoolYearId)),
    listComments(db, viewer, v),
    commentTargets(db, v.id),
    actorNames(db, [v.submittedBy, v.approvedBy]),
  ]);
  const label = versionNumber(v);
  const can = allowedTransitions(viewer, v);
  const open = (OPEN_STATUSES as readonly string[]).includes(v.status);
  const inReview = (PREVIEW_STATUSES as readonly string[]).includes(v.status);
  const openComments = comments.filter((c) => c.comment.resolvedAt === null).length;
  const name = (id: string | null) => (id ? (names.get(id) ?? "Konto gelöscht") : "–");
  return (
    <main className="flex flex-col gap-6">
      <Link href={`/planung/versionen?jahr=${encodeURIComponent(v.schoolYearId)}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> Planversionen
      </Link>
      <PageHeader eyebrow="Stundenplanung · Planversionen" title={`Prüfung · Version ${label}`} />
      {sp.fehler && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {sp.fehler}
        </p>
      )}
      {sp.ok && OK_TEXT[sp.ok] && (
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          {OK_TEXT[sp.ok]}
        </p>
      )}

      <Card aria-labelledby="stand-title" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="stand-title" className="min-w-0 font-semibold break-words">
            <span className="font-display text-lg">Version {label}</span> <span className="block text-sm font-normal text-muted">{v.name}</span>
          </h2>
          <Badge tone={TONES[v.status]}>{STATUS_LABELS[v.status]}</Badge>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">Schuljahr</dt>
          <dd>{year?.name ?? "–"}</dd>
          <dt className="text-muted">Stichtag</dt>
          <dd>{v.validFrom ? `${v.status === "gueltig" || v.status === "archiviert" ? "gültig ab" : "vorgemerkt ab"} ${date(v.validFrom)}` : "ohne Stichtag"}</dd>
          {v.submittedAt && (
            <>
              <dt className="text-muted">Zur Prüfung</dt>
              <dd>
                {dateTimeFmt.format(v.submittedAt)} · {name(v.submittedBy)}
              </dd>
            </>
          )}
          {v.approvedAt && (
            <>
              <dt className="text-muted">Freigegeben</dt>
              <dd data-testid="freigabe">
                {dateTimeFmt.format(v.approvedAt)} · {name(v.approvedBy)}
                {selfApproved(v) && " (selbst freigegeben – ohne Vier-Augen-Prüfung)"}
              </dd>
            </>
          )}
          <dt className="text-muted">Kommentare</dt>
          <dd>
            {openComments} offen · {comments.length - openComments} erledigt
          </dd>
        </dl>
        <nav aria-label={`Version ${label}`} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link href={`/planung/versionen/aenderungen?version=${encodeURIComponent(v.id)}`} className="font-medium text-accent-ink hover:underline">
            Änderungen zum gültigen Plan
          </Link>
          {viewer.manage && v.status === "entwurf" && (
            <Link href={`/planung/stundenplan?quelle=${encodeURIComponent(v.id)}`} className="font-medium text-accent-ink hover:underline">
              Im Entwurf arbeiten
            </Link>
          )}
        </nav>
        {(can.submit || can.approve || can.giveBack) && (
          <section aria-labelledby="schritte-title" className="flex flex-col gap-3 border-t border-border pt-4">
            <h3 id="schritte-title" className="text-base font-semibold">
              Nächster Schritt
            </h3>
            {can.submit && (
              <form action={submitVersionAction.bind(null, v.id)} className="flex flex-col gap-2">
                <p className="text-sm text-muted">
                  Danach ist der Entwurf nur lesbar; die Schulleitung prüft, kommentiert und gibt frei oder zurück. Für Änderungen holt ihr ihn mit „Zurück an
                  die Planung“ zurück.
                </p>
                <div>
                  <Button type="submit">
                    <Send aria-hidden /> Zur Prüfung geben
                  </Button>
                </div>
              </form>
            )}
            {can.approve && (
              <form action={approveVersionAction.bind(null, v.id)} className="flex flex-col gap-2">
                <p className="text-sm text-muted">
                  {openComments > 0 ? `${openComments} ${openComments === 1 ? "Kommentar ist" : "Kommentare sind"} noch offen. ` : ""}Die Freigabe erlaubt der
                  Stundenplanung das Veröffentlichen; bei jeder Rückkehr in den Entwurf verfällt sie.
                  {viewer.manage && (v.submittedBy === user.id || v.createdBy === user.id) && " Du hast den Entwurf selbst eingereicht – das Protokoll vermerkt die eigene Freigabe."}
                </p>
                <div>
                  <Button type="submit">
                    <Check aria-hidden /> Freigeben
                  </Button>
                </div>
              </form>
            )}
            {can.giveBack && (
              <ReturnForm
                action={returnVersionAction.bind(null, v.id)}
                label={v.status === "freigegeben" ? "Freigabe zurücknehmen" : "Zurück an die Planung"}
                withNote
              />
            )}
          </section>
        )}
        {inReview && !can.approve && !viewer.manage && (
          <p className="text-sm text-muted">Freigegeben – veröffentlicht wird von der Stundenplanung.</p>
        )}
      </Card>

      {viewer.manage && open && (
        <Card aria-labelledby="vorschau-title" className="flex flex-col gap-3">
          <h2 id="vorschau-title" className="text-base font-semibold">
            Lehrkräfte-Vorschau „Mein Plan ab {v.validFrom ? date(v.validFrom) : "…"}“
          </h2>
          <p className="text-sm text-muted">
            {v.teacherPreview
              ? inReview
                ? "Eingeschaltet: jede Lehrkraft sieht unter Stundenplan → Vorschau nur ihren eigenen Plan dieser Version und kann der Planung einen Kommentar schreiben."
                : "Eingeschaltet – wirkt, sobald der Entwurf in Prüfung ist (im Entwurf sieht ihn niemand außer der Planung)."
              : "Ausgeschaltet (Vorgabe). Eingeschaltet sieht jede Lehrkraft ab „in Prüfung“ nur ihren eigenen Plan dieser Version – keine anderen Lehrkräfte, keine Kommentare anderer."}
          </p>
          <form action={setPreviewAction.bind(null, v.id, !v.teacherPreview)}>
            <Button type="submit" variant="secondary" size="sm">
              {v.teacherPreview ? <EyeOff aria-hidden /> : <Eye aria-hidden />} {v.teacherPreview ? "Vorschau ausschalten" : "Vorschau einschalten"}
            </Button>
          </form>
        </Card>
      )}

      <section id="kommentare" aria-labelledby="kommentare-title" className="flex scroll-mt-20 flex-col gap-3">
        <h2 id="kommentare-title" className="font-display text-xl font-bold">
          Kommentare ({comments.length})
        </h2>
        {comments.length === 0 ? (
          <EmptyState title="Noch keine Kommentare">Kommentare gehen an die ganze Version, eine Lehrkraft, eine Klasse/einen Kurs oder eine Stunde.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {comments.map((c) => (
              <CommentItem key={c.comment.id} c={c} versionId={v.id} manage={viewer.manage} />
            ))}
          </ul>
        )}
        {canComment(viewer, v) && (
          <Card aria-labelledby="kommentar-title">
            <h3 id="kommentar-title" className="mb-3 text-base font-semibold">
              Kommentar schreiben
            </h3>
            <CommentForm action={addPlanCommentAction.bind(null, v.id)} teachers={targets.teachers} groups={targets.groups} periods={targets.periods} />
          </Card>
        )}
      </section>
    </main>
  );
}
