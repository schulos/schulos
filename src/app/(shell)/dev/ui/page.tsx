import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { subjects } from "@/core/db/schema";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { Field, Input, Select } from "@schulos/ui/field";
import { Avatar, EmptyState, Kbd, PageHeader, Progress, SubjectBar } from "@schulos/ui/misc";
import { ThemeSwitch } from "@schulos/ui/theme";

export const metadata: Metadata = { title: "UI-Bausteine" };

function Showcase({ subjectList }: { subjectList: { id: string; name: string; color: string }[] }) {
  return (
    <div className="flex flex-col gap-6 bg-ground p-6 text-ink">
      <PageHeader eyebrow="Design-System" title="UI-Bausteine" actions={<Button variant="primary">Primär</Button>} />

      <section className="flex flex-wrap items-center gap-2">
        <Button variant="primary">Speichern</Button>
        <Button>Abbrechen</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Löschen</Button>
        <Button size="sm">Klein</Button>
        <Button disabled>Deaktiviert</Button>
      </section>

      <section className="flex flex-wrap gap-2">
        <Badge>Neutral</Badge>
        <Badge tone="accent">Jetzt</Badge>
        <Badge tone="soft">Angeheftet</Badge>
        <Badge tone="warn">Vertretung</Badge>
        <Badge tone="danger">Überfällig</Badge>
        <Badge tone="success">Erledigt</Badge>
        <Badge tone="count">3</Badge>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader title="Zu korrigieren" action={{ href: "#", label: "Alle Aufgaben" }} />
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between gap-2">
              <span className="font-medium">Erörterung „Handyverbot“</span>
              <span className="text-sm text-muted">7b · Deutsch</span>
            </div>
            <Progress value={81} color="#D9480F" label="22 von 27 abgegeben" />
            <span className="text-sm text-muted">22 von 27 abgegeben · Frist Mittwoch</span>
          </div>
        </Card>
        <Card>
          <CardHeader title="Formular" />
          <Field label="Titel" hint="Wird Schüler:innen angezeigt">
            <Input placeholder="z. B. Vokabeltest Unit 3" />
          </Field>
          <Field label="Klasse" error="Bitte eine Klasse wählen">
            <Select defaultValue="">
              <option value="">—</option>
              <option>7b</option>
            </Select>
          </Field>
        </Card>
      </div>

      <Card>
        <CardHeader title="Personen & Fachfarben" />
        <div className="flex flex-wrap items-center gap-3">
          <Avatar label="BRA" />
          <Avatar label="7b" tone="warn" />
          <Avatar label="LS" tone="soft" />
          <span className="text-sm text-muted">
            Palette öffnen mit <Kbd>Strg</Kbd> <Kbd>K</Kbd>
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
          {subjectList.map((s) => (
            <div key={s.id} className="flex flex-col gap-1.5">
              <SubjectBar color={s.color} />
              <span className="text-xs text-muted">{s.name}</span>
            </div>
          ))}
        </div>
      </Card>

      <EmptyState title="Noch keine Aufgaben">Lege die erste Aufgabe für eine Klasse an.</EmptyState>
    </div>
  );
}

export default async function DevUiPage() {
  const { user } = await requireUser();
  if (process.env.NODE_ENV === "production" && user.role !== "admin") notFound();
  const db = await getDb();
  const subjectList = await db.select().from(subjects).orderBy(subjects.sortOrder);
  return (
    <main className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">Links hell, rechts dunkel – unabhängig vom eingestellten Theme.</p>
        <ThemeSwitch />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div data-theme="light" className="overflow-hidden rounded-card border border-border">
          <Showcase subjectList={subjectList} />
        </div>
        <div data-theme="dark" className="overflow-hidden rounded-card border border-border">
          <Showcase subjectList={subjectList} />
        </div>
      </div>
    </main>
  );
}
