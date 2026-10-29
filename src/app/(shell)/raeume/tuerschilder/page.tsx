import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { SIGN_FORMATS } from "@/core/etiketten/codes";
import { printableRooms } from "@/modules/verwaltung/tuer-qr";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Field, Select } from "@schulos/ui/field";
import { PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Türschilder drucken" };

/**
 * RS-11 Sammeldruck: Räume wählen (nur die, deren Daten die Person pflegt) → Druckansicht `/druck/tuerschilder`. Ein Formular
 * per GET, ohne Skript; je Gebäude ein Link „alle drucken“.
 */
export default async function TuerschilderPage() {
  const { perms } = await requireUser();
  const list = await printableRooms(await getDb(), perms);
  if (list.length === 0) notFound();
  const groups: { id: string | null; name: string; rooms: typeof list }[] = [];
  for (const r of list) {
    let g = groups.find((x) => x.id === r.buildingId);
    if (!g) groups.push((g = { id: r.buildingId, name: r.building ?? "Ohne Gebäude", rooms: [] }));
    g.rooms.push(r);
  }
  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader eyebrow="Räume" title="Türschilder drucken" />
      <p className="text-sm text-muted">
        Jedes Türschild trägt Raumname, Gebäude/Etage und einen QR-Code. Wer ihn ohne Anmeldung scannt, sieht nur die Anmeldeseite;
        nach der Anmeldung öffnet sich der Steckbrief. Der Code bleibt beim Nachdruck gleich – einen neuen erzeugen Sie im Steckbrief
        des Raums (dann gilt der alte nicht mehr).{" "}
        <Link href="/raeume" className="font-medium text-accent-ink hover:underline">
          Zurück zu den Räumen
        </Link>
      </p>
      <form action="/druck/tuerschilder" method="get" aria-label="Türschilder auswählen" className="flex flex-col gap-4">
        <Field label="Format">
          <Select name="format" defaultValue="a5" className="sm:w-80">
            {(Object.keys(SIGN_FORMATS) as (keyof typeof SIGN_FORMATS)[]).map((f) => (
              <option key={f} value={f}>
                {SIGN_FORMATS[f].label}
              </option>
            ))}
          </Select>
        </Field>
        {groups.map((g) => (
          <Card key={g.id ?? "-"}>
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 flex w-full flex-wrap items-center justify-between gap-2 font-semibold">
                {g.name}
                {g.id && (
                  <Link href={`/druck/tuerschilder?gebaeude=${encodeURIComponent(g.id)}`} className="text-sm font-medium text-accent-ink hover:underline">
                    Alle in {g.name} drucken (A5)
                  </Link>
                )}
              </legend>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {g.rooms.map((r) => (
                  <li key={r.id}>
                    <label className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                      <input type="checkbox" name="raum" value={r.id} className="size-4 accent-[var(--accent)]" />
                      <span>
                        <span className="font-semibold">{r.id}</span>
                        {r.name !== r.id && r.name !== `Raum ${r.id}` && <span className="text-muted"> · {r.name}</span>}
                        {r.floor && <span className="block text-xs text-muted">{r.floor}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          </Card>
        ))}
        <div>
          <Button type="submit" variant="primary">
            Gewählte drucken
          </Button>
        </div>
      </form>
    </main>
  );
}
