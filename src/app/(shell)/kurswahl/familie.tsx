import Link from "next/link";
import { inArray } from "drizzle-orm";
import { getDb } from "@/core/db/client";
import { users } from "@/core/db/schema";
import type { PermissionSet } from "@/core/permissions";
import { TZ, toBerlinDate } from "@/core/time";
import { STATE_LABEL, familyOverview, listAngebote, neededChoices, rankLabel, type FamilyItem } from "@/modules/kurswahl/service";
import { confirmChoiceAction, submitChoiceAction } from "@/modules/kurswahl/wahl-actions";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState } from "@schulos/ui/misc";
import { ActionButton, ChoiceForm } from "./wahl-forms";

const stamp = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const day = (ymd: string) => dayFmt.format(new Date(`${ymd}T12:00:00Z`));

/** P4-62: Kurswahlen der Familie – je Verfahren und Kind wählen, bestätigen oder lesen; nach der Übernahme das Ergebnis. */
export async function FamilyOverview({ perms }: { perms: PermissionSet }) {
  const db = await getDb();
  const items = await familyOverview(db, perms, toBerlinDate(new Date()));
  if (items.length === 0) return <EmptyState title="Zurzeit keine Kurswahl" />;
  const actors = [...new Set(items.flatMap((i) => [i.wahl?.submittedBy, i.wahl?.confirmedBy]).filter((x): x is string => Boolean(x)))];
  const names = new Map((actors.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, actors)) : []).map((u) => [u.id, u.name]));
  const multi = new Set(items.map((i) => i.student.id)).size > 1 || perms.role === "eltern";
  return (
    <div className="flex flex-col gap-4">
      {items.map((it) => (
        <Item key={`${it.verfahren.id}:${it.student.id}`} it={it} names={names} showName={multi} self={perms.userId === it.student.id} />
      ))}
    </div>
  );
}

async function Item({ it, names, showName, self }: { it: FamilyItem; names: Map<string, string>; showName: boolean; self: boolean }) {
  const db = await getDb();
  const { verfahren: v, wahl: w, student: s, role, state, places } = it;
  const offers = await listAngebote(db, v.id);
  const title = new Map(offers.map((o) => [o.id, o.title]));
  const need = neededChoices(v, offers.length);
  const submitted = Boolean(w?.submittedAt);
  const result = state === "uebernommen" && w?.assignedId ? title.get(w.assignedId) : null;
  // P4-67: Mehrfachwahl – je Platz eine Zeile
  const multi = v.maxCourses > 1;
  const assigned = places.filter((p) => p.assignedId);
  const chosenPlaces = places.filter((p) => p.choices.length).map((p) => p.choices);
  const label = showName ? `${v.title} – ${s.name}` : v.title;
  return (
    <Card aria-label={label} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-base font-semibold">{label}</h2>
        <Badge tone={state === "offen" ? "success" : "soft"}>{STATE_LABEL[state]}</Badge>
      </div>
      <p className="text-sm text-muted">Wahl bis {day(v.closesOn)}</p>
      {v.note && <p className="whitespace-pre-line text-sm">{v.note}</p>}

      {state === "uebernommen" && multi && (
        <div role="status" className="font-medium">
          {assigned.length ? (
            <>
              Zugeteilt:
              <ul className="list-disc pl-5">
                {assigned.map((p) => (
                  <li key={p.place}>
                    <strong>{title.get(p.assignedId!)}</strong>
                    {p.assignedRank ? ` (Kurs ${p.place}, ${rankLabel(p.assignedRank)})` : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            "Noch keine Zuteilung – bitte an das Sekretariat wenden."
          )}
        </div>
      )}
      {state === "uebernommen" && !multi && (
        <p role="status" className="font-medium">
          {result ? (
            <>
              Zugeteilt: <strong>{result}</strong>
              {w?.assignedRank ? ` (${rankLabel(w.assignedRank)})` : ""}
            </>
          ) : (
            "Noch keine Zuteilung – bitte an das Sekretariat wenden."
          )}
        </p>
      )}

      {role === "waehlt" && state === "offen" ? (
        <ChoiceForm
          action={submitChoiceAction.bind(null, v.id, s.id)}
          label={`Wahl ${label}`}
          need={need}
          offers={offers.map((o) => ({ value: o.id, label: o.title }))}
          initial={w?.choices ?? []}
          initialPlaces={multi ? chosenPlaces : undefined}
          courses={{ min: v.minCourses, max: v.maxCourses }}
          submitLabel={submitted ? "Wahl ändern" : "Wahl abgeben"}
        />
      ) : state !== "uebernommen" ? (
        submitted && multi ? (
          <div className="flex flex-col gap-2">
            {chosenPlaces.map((list, i) => (
              <div key={i}>
                <p className="text-sm font-medium">Kurs {i + 1}</p>
                <ol className="flex list-decimal flex-col gap-1 pl-5">
                  {list.map((c) => (
                    <li key={c}>{title.get(c) ?? "entfallenes Angebot"}</li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        ) : submitted ? (
          <ol className="flex list-decimal flex-col gap-1 pl-5">
            {w!.choices.map((c) => (
              <li key={c}>{title.get(c) ?? "entfallenes Angebot"}</li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted">{role === "liest" && !self ? "Noch nicht gewählt." : role === "liest" ? "Deine Eltern wählen für dich – noch nicht gewählt." : "Noch nicht gewählt."}</p>
        )
      ) : null}

      {submitted && state !== "uebernommen" && (
        <p className="text-sm text-muted">
          Abgegeben am {stamp.format(w!.submittedAt!)}
          {w!.submittedBy && names.get(w!.submittedBy) ? ` von ${names.get(w!.submittedBy)}` : ""}
          {v.parentConfirm && (w!.confirmedAt ? ` · bestätigt von ${names.get(w!.confirmedBy ?? "") ?? "den Eltern"}` : " · Bestätigung der Eltern fehlt")}
        </p>
      )}
      {role === "bestaetigt" && state === "offen" && submitted && !w!.confirmedAt && <ActionButton action={confirmChoiceAction.bind(null, v.id, s.id)} label="Wahl bestätigen" doneText="Bestätigt." />}

      {offers.some((o) => o.note) && (
        <details>
          <summary className="cursor-pointer text-sm text-accent">Beschreibung der Angebote</summary>
          <ul className="flex flex-col gap-1 pt-2 text-sm">
            {offers
              .filter((o) => o.note)
              .map((o) => (
                <li key={o.id}>
                  <strong>{o.title}:</strong> {o.note}
                </li>
              ))}
          </ul>
        </details>
      )}
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href={`/druck/kurswahl/${v.id}?schueler=${s.id}`}>Wahlbogen drucken</Link>
        </Button>
      </div>
    </Card>
  );
}
