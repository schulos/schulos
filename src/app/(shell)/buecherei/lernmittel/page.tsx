import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { createMaterialAction } from "@/modules/buecherei/actions";
import { PROVISION_LABELS, formatEuro, formatIsbn, gradeRange } from "@/modules/buecherei/labels";
import { MAX_MATERIAL_COPIES_AT_ONCE, canMaterials, lernmittelEnabled, listMaterials, materialChoices, materialsSummary } from "@/modules/buecherei/lernmittel";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { Field, Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { SpecForm } from "@/ui/spec-form";
import { BuechereiNav } from "../ui";
import { materialFields } from "./material-fields";

export const metadata: Metadata = { title: "Lernmittel" };

type Search = { q?: string; jahrgang?: string; fach?: string; alle?: string };

/** Schulbuchausleihe (BU-10, Recht `buecherei.materials`, nur mit Schalter): Lernmittel je Jahrgang/Fach, anlegen, Bücherlisten. */
export default async function LernmittelPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  if (!canMaterials(perms) || !(await lernmittelEnabled(db))) notFound();
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const grade = Number(sp.jahrgang) || undefined;
  const subjectId = sp.fach || undefined;
  const [rows, sum, choices] = await Promise.all([listMaterials(db, perms, { q, grade, subjectId, archived: sp.alle === "1" }), materialsSummary(db, perms), materialChoices(db)]);
  const filtered = !!(q || grade || subjectId);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Bücherei · Schulbuchausleihe" title="Lernmittel" />
      <BuechereiNav current="lernmittel" perms={perms} />
      <p className="text-sm text-muted">
        {sum.materials} Lernmittel · {sum.copies} Exemplare im Bestand{sum.worn > 0 && ` · ${sum.worn} in schlechtem Zustand`} ·{" "}
        <Link href="/buecherei/buecherliste" className="font-medium text-accent-ink hover:underline">
          Bücherlisten je Jahrgang
        </Link>
      </p>

      <form aria-label="Lernmittel filtern" className="flex flex-wrap items-end gap-3">
        <Field label="Suche" hint="Titel, Verlag, Kurs, ISBN oder Inventarnummer">
          <Input type="search" name="q" defaultValue={q} maxLength={100} className="w-64" />
        </Field>
        <Field label="Jahrgang">
          <Select name="jahrgang" defaultValue={grade ? String(grade) : ""} className="w-36">
            <option value="">alle</option>
            {choices.grades.map((g) => (
              <option key={g.level} value={g.level}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Fach">
          <Select name="fach" defaultValue={subjectId ?? ""} className="w-44">
            <option value="">alle</option>
            {choices.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="alle" value="1" defaultChecked={sp.alle === "1"} className="size-4 accent-[var(--accent)]" />
          auch archivierte
        </label>
        <Button type="submit">Filtern</Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState title={filtered ? "Nichts gefunden" : "Noch keine Lernmittel"}>
          {filtered ? "Andere Filter versuchen." : "Unten das erste Lernmittel anlegen – mit Jahrgängen, Fach und den Exemplaren der Schule."}
        </EmptyState>
      ) : (
        <Table>
          <caption className="sr-only">Lernmittel</caption>
          <thead>
            <tr>
              <th>Titel</th>
              <th>Jahrgang</th>
              <th>Fach</th>
              <th>Bereitstellung</th>
              <th className="text-right">Exemplare</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td className="font-medium">
                  <Link href={`/buecherei/lernmittel/${m.id}`} className="hover:underline">
                    {m.title}
                  </Link>
                  {m.archivedOn && (
                    <Badge tone="neutral" className="ml-2">
                      archiviert
                    </Badge>
                  )}
                  <span className="block text-xs font-normal text-muted">{[m.publisher, m.isbn ? `ISBN ${formatIsbn(m.isbn)}` : null].filter(Boolean).join(" · ")}</span>
                </td>
                <td className="tabular-nums">{gradeRange(m.grades)}</td>
                <td>
                  {m.subjectName ?? "–"}
                  {m.course && <span className="text-muted"> · {m.course}</span>}
                </td>
                <td>
                  {PROVISION_LABELS[m.provision]}
                  {m.priceCents != null && <span className="text-muted"> · {formatEuro(m.priceCents)}</span>}
                </td>
                <td className="text-right tabular-nums">
                  {m.provision === "leihe" ? m.copies : "–"}
                  {m.worn > 0 && (
                    <Badge tone="warn" className="ml-2">
                      {m.worn} schlecht
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Card aria-labelledby="lernmittel-anlegen">
        <CardHeader title={<span id="lernmittel-anlegen">Lernmittel anlegen</span>} />
        <SpecForm
          action={createMaterialAction}
          label="Lernmittel anlegen"
          submit="Anlegen"
          fields={[
            ...materialFields(choices),
            {
              name: "count",
              label: "Exemplare der Schule",
              type: "number",
              min: 0,
              max: MAX_MATERIAL_COPIES_AT_ONCE,
              defaultValue: "0",
              hint: "nur bei Ausleihe; Inventarnummern vergibt SchulOS",
            },
            { name: "acquiredYear", label: "angeschafft", type: "number", min: 1990, max: 2100, hint: "Jahr" },
          ]}
        />
      </Card>
    </main>
  );
}
