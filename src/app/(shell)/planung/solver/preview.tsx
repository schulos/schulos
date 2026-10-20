// SP-07/SP-08: Vorschau eines Laufs als Wochenplan – gemeinsam für die Detailseite und den Vergleich (Wert `g:<id>` bzw. `t:<id>`).
import { inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { timetableLessons } from "@/core/db/schema";
import {
  plannableGroups,
  teacherOptions,
  WEEKDAYS,
} from "@/modules/stundenplan/manage";
import { timetableMasterData } from "@/modules/stundenplan/service";
import {
  proposedLessons,
  type StoredResult,
} from "@/modules/stundenplan/solverlauf";
import { SubjectBar } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";

export type PreviewKind = "g" | "t";
export type PreviewTarget = { kind: PreviewKind; target: string };

export function parsePreview(raw: string | undefined): PreviewTarget | null {
  const [kind, target] = (raw ?? "").split(":", 2) as [
    string,
    string | undefined,
  ];
  return target && (kind === "g" || kind === "t") ? { kind, target } : null;
}

export interface PreviewLesson {
  groupId: string;
  subjectId: string;
  teacherId: string | null;
  roomId: string | null;
  weekday: number;
  periodNr: number;
  kept: boolean;
}

/** Stammdaten für Auswahl und Anzeige (Klassen/Kurse, Lehrkräfte, Fächer, Stunden) – einmal je Seite. */
export async function loadPreviewContext(db: Db, withMaster: boolean) {
  const [groupList, teachers, master] = await Promise.all([
    plannableGroups(db),
    teacherOptions(db),
    withMaster ? timetableMasterData(db) : Promise.resolve(null),
  ]);
  return {
    groupList,
    teachers,
    master,
    groupName: new Map(groupList.map((g) => [g.id, g.name])),
    teacherCode: new Map(teachers.map((t) => [t.id, t.code ?? t.name])),
    subjectOf: new Map((master?.subjects ?? []).map((s) => [s.id, s])),
    options: {
      groups: groupList.map((g) => ({ value: `g:${g.id}`, label: g.name })),
      teachers: teachers.map((t) => ({
        value: `t:${t.id}`,
        label: t.code ? `${t.code} – ${t.name}` : t.name,
      })),
    },
  };
}
export type PreviewContext = Awaited<ReturnType<typeof loadPreviewContext>>;

/** Gibt es das Ziel der Vorschau überhaupt (Klasse bzw. Lehrkraft)? */
export const previewExists = (
  ctx: PreviewContext,
  p: PreviewTarget | null,
): p is PreviewTarget =>
  Boolean(
    p &&
    (p.kind === "g"
      ? ctx.groupName.has(p.target)
      : ctx.teacherCode.has(p.target)),
  );

export const previewName = (ctx: PreviewContext, p: PreviewTarget) =>
  p.kind === "g"
    ? (ctx.groupName.get(p.target) ?? p.target)
    : `${ctx.teacherCode.get(p.target) ?? p.target} (Lehrkraft)`;

/** Vorgeschlagene Stunden plus bleibende (fixierte/ohne Lehrauftrag), gefiltert auf Klasse bzw. Lehrkraft. */
export async function previewLessons(
  db: Db,
  stored: StoredResult,
  p: PreviewTarget,
): Promise<PreviewLesson[]> {
  const kept = stored.keptLessonIds.length
    ? await db
        .select()
        .from(timetableLessons)
        .where(inArray(timetableLessons.id, stored.keptLessonIds))
    : [];
  return [
    ...proposedLessons(stored).map((l) => ({ ...l, kept: false })),
    ...kept.map((l) => ({
      groupId: l.groupId,
      subjectId: l.subjectId,
      teacherId: l.teacherId,
      roomId: l.roomId,
      weekday: l.weekday,
      periodNr: l.periodNr,
      kept: true,
    })),
  ].filter((l) =>
    p.kind === "g" ? l.groupId === p.target : l.teacherId === p.target,
  );
}

export function PreviewGrid({
  ctx,
  p,
  lessons,
  caption,
  scrollLabel,
}: {
  ctx: PreviewContext;
  p: PreviewTarget;
  lessons: PreviewLesson[];
  caption: string;
  scrollLabel?: string;
}) {
  const master = ctx.master!;
  return (
    <Table scrollLabel={scrollLabel}>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th>Stunde</th>
          {WEEKDAYS.map((d) => (
            <th key={d}>{d}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {master.periods.map((per) => (
          <tr key={per.nr}>
            <td className="whitespace-nowrap">{per.nr}.</td>
            {WEEKDAYS.map((d, wd) => (
              <td key={d} className="min-w-28 !py-2">
                {lessons
                  .filter((l) => l.weekday === wd && l.periodNr === per.nr)
                  .map((l, i) => (
                    <span key={i} className="flex items-center gap-1.5 text-sm">
                      <SubjectBar
                        color={ctx.subjectOf.get(l.subjectId)?.color ?? "#999"}
                        className="h-5 w-1 shrink-0"
                      />
                      <span>
                        <span className="font-medium">
                          {ctx.subjectOf.get(l.subjectId)?.name ?? l.subjectId}
                        </span>
                        <span className="block text-xs text-muted">
                          {[
                            p.kind === "g"
                              ? l.teacherId
                                ? ctx.teacherCode.get(l.teacherId)
                                : null
                              : (ctx.groupName.get(l.groupId) ?? l.groupId),
                            l.roomId,
                            l.kept ? "bleibt" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </span>
                  ))}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
