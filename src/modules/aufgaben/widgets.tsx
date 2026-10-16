import Link from "next/link";
import type { CurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import type { WidgetDef } from "@/core/widgets";
import { Card, CardHeader } from "@schulos/ui/card";
import { Progress } from "@schulos/ui/misc";
import { listForStudent, listForTeacher } from "./service";
import { dueText, StatusBadge } from "./ui";

async function Faellig({ current }: { current: CurrentUser }) {
  const open = (await listForStudent(await getDb(), current.perms)).filter((t) => t.status === "offen" || t.status === "fehlt").slice(0, 4);
  return (
    <Card>
      <CardHeader title="Fällig" action={{ href: "/aufgaben", label: "Alle" }} />
      {open.length === 0 ? (
        <p className="text-sm text-muted">Nichts offen – stark!</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {open.map((t) => (
            <li key={t.id}>
              <Link href={`/aufgaben/${t.id}`} className="flex items-center justify-between gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{t.title}</span>
                  <span className="truncate text-xs text-muted">{dueText(t.dueAt)}</span>
                </span>
                <StatusBadge status={t.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

async function ZuKorrigieren({ current }: { current: CurrentUser }) {
  const list = (await listForTeacher(await getDb(), current.perms)).filter((t) => t.submitted > t.returned || t.dueAt > new Date()).slice(0, 3);
  return (
    <Card>
      <CardHeader title="Zu korrigieren" action={{ href: "/aufgaben", label: "Alle Aufgaben" }} />
      {list.length === 0 ? (
        <p className="text-sm text-muted">Keine offenen Abgaben.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {list.map((t) => (
            <li key={t.id}>
              <Link href={`/aufgaben/${t.id}`} className="flex flex-col gap-1.5 rounded-xl hover:opacity-90">
                <span className="flex justify-between gap-2">
                  <span className="truncate font-medium">{t.title}</span>
                  <span className="shrink-0 text-sm text-muted">{t.groups.join(", ")}</span>
                </span>
                <Progress value={t.students ? (t.submitted / t.students) * 100 : 0} label={`${t.submitted} von ${t.students} abgegeben`} />
                <span className="text-xs text-muted">
                  {t.submitted} von {t.students} abgegeben{t.submitted > t.returned ? ` · ${t.submitted - t.returned} ohne Feedback` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export const aufgabenWidgets: WidgetDef[] = [
  { id: "aufgaben.faellig", moduleId: "aufgaben", order: 8, roles: ["schueler"], Component: Faellig },
  { id: "aufgaben.korrigieren", moduleId: "aufgaben", order: 8, requires: "aufgaben.create", Component: ZuKorrigieren },
];
