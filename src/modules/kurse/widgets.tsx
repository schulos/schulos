import Link from "next/link";
import type { CurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import type { WidgetDef } from "@/core/widgets";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { SubjectBar } from "@schulos/ui/misc";
import { myCourses } from "./service";

const MAX = 6;

async function MeineKurse({ current }: { current: CurrentUser }) {
  const courses = await myCourses(await getDb(), current.perms);
  if (courses.length === 0) return null;
  return (
    <Card>
      <CardHeader title="Meine Kurse" action={courses.length > MAX ? { href: "/kurse", label: `Alle ${courses.length}` } : { href: "/kurse", label: "Übersicht" }} />
      <ul className="flex flex-col gap-1">
        {courses.slice(0, MAX).map((c) => (
          <li key={c.id}>
            <Link href={`/kurse/${c.id}`} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
              <SubjectBar color={c.color ?? "var(--border-strong)"} className="h-6 w-1 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
              {c.leader && <Badge tone="soft">Leitung</Badge>}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export const kurseWidgets: WidgetDef[] = [{ id: "kurse.meine", moduleId: "kurse", order: 9, roles: ["schueler", "lehrkraft"], requires: "kurse.view", Component: MeineKurse }];
