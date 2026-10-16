import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { ANTRAG_STATUSES, ANTRAG_STATUS_LABELS } from "@/modules/anmeldung/labels";
import { canMarkSpam } from "@/modules/anmeldung/entscheidung";
import { listAntraege, primarySchools, SPAM_SUSPECT_FILTER, type AntragFilter } from "@/modules/anmeldung/sekretariat";
import { canDecide, getVerfahren, listSlots } from "@/modules/anmeldung/service";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { AntragTable } from "../../forms";
import { dayFmt, timeFmt, VerfahrenNav } from "../../shared";

export const metadata: Metadata = { title: "Anträge" };
export const dynamic = "force-dynamic";

const dateShort = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin" });

/** Antragsliste eines Verfahrens (P4-36): Filter Status/Termin/Grundschule/Geschwister, Suche, Sortierung; Sammel-Ablehnung „Spam“ (P4-78), zweistufig mit Spam-Verdacht (P4-78b). */
export default async function AntraegePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<AntragFilter> }) {
  const { perms } = await requireUser();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const db = await getDb();
  const v = await getVerfahren(db, perms, decodeURIComponent(id)).catch(() => null);
  if (!v) notFound();
  const [rows, schools, slots] = await Promise.all([listAntraege(db, perms, v.id, sp), primarySchools(db, perms, v.id), listSlots(db, v.id)]);
  const days = [...new Set(slots.map((s) => toBerlinDate(s.startsAt)))];
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Schulanmeldung" title={v.name} />
      <VerfahrenNav id={v.id} current="antraege" />
      <form aria-label="Filter" className="flex flex-wrap items-end gap-3">
        <Field label="Suche">
          <Input name="q" defaultValue={sp.q ?? ""} placeholder="Name, Nummer, Schule" className="w-56" />
        </Field>
        <Field label="Stand">
          <Select name="status" defaultValue={sp.status ?? ""} className="w-48">
            <option value="">alle (bestätigt)</option>
            <option value={SPAM_SUSPECT_FILTER}>Spam-Verdacht</option>
            {ANTRAG_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ANTRAG_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Termin">
          <Select name="slotId" defaultValue={sp.slotId ?? ""} className="w-56">
            <option value="">alle</option>
            <option value="ohne">ohne Termin</option>
            {slots.map((s) => (
              <option key={s.id} value={s.id}>
                {dateShort.format(s.startsAt)} {timeFmt.format(s.startsAt)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Grundschule">
          <Select name="school" defaultValue={sp.school ?? ""} className="w-48">
            <option value="">alle</option>
            {schools.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </Field>
        <Field label="Geschwister">
          <Select name="sibling" defaultValue={sp.sibling ?? ""} className="w-32">
            <option value="">egal</option>
            <option value="ja">ja</option>
            <option value="nein">nein</option>
          </Select>
        </Field>
        <Field label="Sortierung">
          <Select name="sort" defaultValue={sp.sort ?? "name"} className="w-36">
            <option value="name">Name</option>
            <option value="nummer">Nummer</option>
            <option value="termin">Termin</option>
            <option value="eingang">Eingang</option>
          </Select>
        </Field>
        <Button type="submit" size="sm">
          Anzeigen
        </Button>
      </form>
      {days.length > 0 && (
        <nav aria-label="Tageslisten" className="flex flex-wrap gap-2 text-sm">
          <span className="text-muted">Tagesliste drucken:</span>
          {days.map((d) => (
            <Link key={d} href={`/druck/anmeldung-tag/${v.id}/${d}`} className="underline underline-offset-2">
              {dayFmt.format(new Date(`${d}T12:00:00Z`))}
            </Link>
          ))}
        </nav>
      )}
      {rows.length === 0 ? (
        <EmptyState title="Keine Anträge" />
      ) : (
        <AntragTable
          verfahrenId={v.id}
          canSpam={canDecide(perms) && v.status !== "abgeschlossen"}
          canMark={canMarkSpam(perms) && v.status !== "abgeschlossen"}
          rows={rows.map((a) => ({
            id: a.id,
            number: a.number,
            href: `/verwaltung/anmeldung/${v.id}/antrag/${a.id}`,
            child: `${a.childLastName}, ${a.childFirstName}`,
            sibling: a.sibling,
            viaAccount: a.viaAccount,
            birth: a.childBirthDate.split("-").reverse().join("."),
            school: a.primarySchool ?? "",
            slot: a.slotStartsAt ? `${dateShort.format(a.slotStartsAt)} ${timeFmt.format(a.slotStartsAt)}` : "",
            status: a.status,
            spam: a.spam,
            spamSuspect: a.spamSuspect,
          }))}
        />
      )}
      <p className="text-xs text-muted" data-testid="antraege-summe">
        {rows.length === 1 ? "1 Antrag" : `${rows.length} Anträge`}
      </p>
    </main>
  );
}
