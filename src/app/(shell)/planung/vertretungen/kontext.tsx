// VT-03a: dritte Spalte des Vertretungs-Arbeitsplatzes – Tagesplan der Klasse der gewählten Stunde und der Tag der markierten
// (vorgeschlagenen) Lehrkraft mit Hohl-/Randstunde, Stundenzahl, Aufsicht, Tagesregel und Bereitschaft. Reine Anzeige (Server).
import Link from "next/link";
import { Badge } from "@schulos/ui/badge";
import { Card } from "@schulos/ui/card";
import type { TeacherContext } from "@/modules/stundenplan/arbeitsplatz";
import { slotDisplay } from "@/modules/stundenplan/display";
import type { LessonSlot } from "@/modules/stundenplan/service";

export interface MarkOption {
  id: string;
  code: string | null;
  name: string;
  href: string;
}

export function ContextColumn({
  chosen,
  classPlan,
  teacher,
  options,
  markedId,
  lessonHref,
}: {
  chosen: LessonSlot;
  classPlan: LessonSlot[];
  teacher: TeacherContext | null;
  /** vorgeschlagene Lehrkräfte (die ersten drei) + eingetragene Vertretung – zum Markieren */
  options: MarkOption[];
  markedId: string | null;
  /** Link auf eine andere Stunde derselben Klasse */
  lessonHref: (lessonId: string) => string;
}) {
  return (
    <>
      <Card aria-labelledby="class-day-title" className="gap-3">
        <h3 id="class-day-title" className="font-semibold">
          Tagesplan {chosen.groupName}
        </h3>
        {classPlan.length === 0 ? (
          <p className="text-sm text-muted">Keine Stunden an diesem Tag.</p>
        ) : (
          <ol aria-label={`Tagesplan ${chosen.groupName}`} className="flex flex-col gap-1 text-sm">
            {classPlan.map((s) => {
              const d = slotDisplay(s, "group");
              const current = s.lessonId === chosen.lessonId;
              return (
                <li
                  key={`${s.lessonId}-${s.periodNr}`}
                  aria-current={current ? "true" : undefined}
                  className="flex items-start gap-2 rounded-lg px-2 py-1 aria-[current=true]:bg-accent-soft aria-[current=true]:text-accent-ink"
                >
                  <span className="w-6 shrink-0 tabular-nums">{s.periodNr}.</span>
                  <span aria-hidden className="mt-1 h-3 w-1.5 shrink-0 rounded-full" style={{ background: s.color }} />
                  <span className="flex min-w-0 flex-col">
                    {current ? (
                      <span className="font-medium">{s.subjectName}</span>
                    ) : (
                      <Link href={lessonHref(s.lessonId)} className="font-medium hover:underline">
                        {s.subjectName}
                      </Link>
                    )}
                    <span className={current ? "" : "text-muted"}>{[s.teacherCode, s.roomId && `R ${s.roomId}`].filter(Boolean).join(" · ")}</span>
                    {d.tag && (
                      <span>
                        <Badge tone={d.tone === "off" ? "neutral" : "warn"}>{d.tag}</Badge>
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      <Card aria-labelledby="teacher-day-title" className="gap-3">
        <h3 id="teacher-day-title" className="font-semibold">
          {teacher ? `Tag von ${teacher.code ?? teacher.name}` : "Vorgeschlagene Lehrkraft"}
        </h3>
        {options.length > 0 && (
          <nav aria-label="Lehrkraft markieren" className="flex flex-wrap gap-1.5">
            {options.map((o) => (
              <Link
                key={o.id}
                href={o.href}
                aria-current={o.id === markedId ? "true" : undefined}
                aria-label={`Tag von ${o.code ?? o.name} ansehen`}
                className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-sm font-medium hover:border-border-strong aria-[current=true]:border-accent aria-[current=true]:bg-accent-soft aria-[current=true]:text-accent-ink"
              >
                {o.code ?? o.name}
              </Link>
            ))}
          </nav>
        )}
        {!teacher ? (
          <p className="text-sm text-muted">Keine Lehrkraft vorgeschlagen. Unter „Vertretung durch“ stehen alle freien Lehrkräfte.</p>
        ) : (
          <>
            <dl aria-label={`Kontext ${teacher.code ?? teacher.name}`} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">Stunden</dt>
              <dd>
                {teacher.held === 1 ? "1 Stunde" : `${teacher.held} Stunden`}
                {!teacher.busy && <span className="text-muted"> · mit Vertretung {teacher.held + 1}</span>}
              </dd>
              <dt className="text-muted">Lage</dt>
              <dd>
                {teacher.absent ? (
                  <Badge tone="danger">abwesend</Badge>
                ) : teacher.busy ? (
                  <Badge tone="danger">hat zu der Zeit Unterricht</Badge>
                ) : (
                  <Badge tone={teacher.position === "Hohlstunde" ? "success" : "neutral"}>{teacher.position}</Badge>
                )}
              </dd>
              <dt className="text-muted">Bereitschaft</dt>
              <dd>
                {teacher.standbyNow ? (
                  <Badge tone="soft">in dieser Stunde</Badge>
                ) : teacher.periods.some((p) => p.standby) ? (
                  `${teacher.periods
                    .filter((p) => p.standby)
                    .map((p) => `${p.nr}.`)
                    .join(", ")} Std.`
                ) : (
                  "keine"
                )}
              </dd>
              <dt className="text-muted">Tagesregel</dt>
              <dd>
                {teacher.rule ?? "keine"}
                {teacher.overRule && (
                  <Badge tone="danger" className="ml-1">
                    mit Vertretung darüber
                  </Badge>
                )}
              </dd>
              <dt className="text-muted">Aufsicht</dt>
              <dd>{teacher.periods.flatMap((p) => p.duties).join(" · ") || "keine"}</dd>
            </dl>
            <ol aria-label={`Tag von ${teacher.code ?? teacher.name}`} className="flex flex-col gap-1 text-sm">
              {teacher.periods.map((p) => (
                <li
                  key={p.nr}
                  aria-current={p.candidate ? "true" : undefined}
                  className="flex items-start gap-2 rounded-lg px-2 py-1 aria-[current=true]:bg-accent-soft aria-[current=true]:text-accent-ink"
                >
                  <span className="w-6 shrink-0 tabular-nums">{p.nr}.</span>
                  <span className="flex min-w-0 flex-col">
                    {p.entries.length === 0 ? (
                      <span className={p.candidate ? "font-medium" : "text-muted"}>{p.candidate ? "frei – diese Vertretung" : "frei"}</span>
                    ) : (
                      p.entries.map((e, i) => (
                        <span key={i} className={e.held ? "" : p.candidate ? "line-through" : "text-muted line-through"}>
                          {e.label}
                        </span>
                      ))
                    )}
                    {p.candidate && p.entries.length > 0 && <span className="font-medium">diese Vertretung</span>}
                    {p.standby && <span className="text-xs">Bereitschaft</span>}
                    {p.duties.map((d) => (
                      <span key={d} className="text-xs">
                        danach {d}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
      </Card>
    </>
  );
}
