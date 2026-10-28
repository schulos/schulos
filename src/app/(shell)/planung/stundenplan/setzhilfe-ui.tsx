import Link from "next/link";
import { ArrowLeftRight, MoveRight } from "lucide-react";
import type { Cell, OpenAssignment } from "@/modules/stundenplan/setzhilfe";
import { subjectMismatch } from "@/modules/stundenplan/lehrfaecher-auswahl";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { SubjectBar } from "@schulos/ui/misc";

const hoursFmt = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 1 });

export function MoveLink({ href }: { href: string }) {
  return (
    <p className="text-sm">
      <Link href={href} className="inline-flex items-center gap-1.5 text-accent-ink underline-offset-2 hover:underline">
        <MoveRight aria-hidden className="size-4" />
        Verschieben oder tauschen
      </Link>
    </p>
  );
}

/** Offene Stunden der Gruppe aus der Unterrichtsverteilung, jeweils mit „Setzen“. */
export function OpenPanel({ open, base, placing, fakultas }: { open: OpenAssignment[]; base: string; placing?: string; fakultas?: ReadonlyMap<string, readonly string[]> }) {
  return (
    <Card aria-labelledby="open-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="open-title" className="text-base font-semibold">
          Offene Stunden
        </h2>
        {placing && (
          <Button asChild size="sm">
            <Link href={base}>Fertig</Link>
          </Button>
        )}
      </div>
      {open.length === 0 ? (
        <p className="text-sm text-muted">Alle Lehraufträge sind im Stundenplan verplant.</p>
      ) : (
        <>
          {placing && <p className="text-sm text-muted">Freie Felder nehmen die Stunde auf. Belegte Felder nennen den Grund (Lehrkraft, Klasse oder Raum).</p>}
          <ul className="flex flex-wrap gap-2">
            {open.map((a) => {
              const active = a.id === placing;
              const label = `${a.subjectName}${a.teachers.length ? ` · ${a.teachers.map((t) => t.code ?? t.name).join(", ")}` : ""}`;
              // SP2-12: Lehrauftrag mit fachfremder Lehrkraft – Warnhinweis schon vor dem Setzen
              const off = fakultas ? subjectMismatch(fakultas, a.subjectId, a.teachers.map((t) => t.id)).off : [];
              const offCodes = a.teachers.filter((t) => off.includes(t.id)).map((t) => t.code ?? t.name);
              return (
                <li key={a.id}>
                  <Link
                    href={active ? base : `${base}&setzen=${a.id}`}
                    aria-current={active ? "true" : undefined}
                    className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm transition hover:border-border-strong aria-[current=true]:border-accent aria-[current=true]:bg-accent-soft"
                  >
                    <SubjectBar color={a.color} className="h-5 w-1 shrink-0" />
                    <span className="font-medium">{label}</span>
                    {a.band && (
                      <span className="text-xs text-muted" title="Band: alle Mitglieder werden zur selben Zeit als Kopplung gesetzt">
                        Band {a.band.name}
                        {a.band.members.length > 1 ? ` · mit ${a.band.members.filter((m) => m.id !== a.id).map((m) => `${m.groups.map((g) => g.name).join(" + ")} ${m.subjectName}`).join(", ")}` : ""}
                      </span>
                    )}
                    {offCodes.length > 0 && (
                      <Badge tone="warn" title={`${offCodes.join(", ")} ${offCodes.length === 1 ? "unterrichtet" : "unterrichten"} ${a.subjectName} laut Stammdaten nicht`}>
                        fachfremd: {offCodes.join(", ")}
                      </Badge>
                    )}
                    <Badge tone={active ? "accent" : "warn"}>
                      {hoursFmt(a.open)} von {a.hours} offen
                    </Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}

/** Ein Feld im Freiraster: setzen/verschieben, tauschen oder belegt mit Gründen. */
export function PlacementCell({ cell, slot, action, verb }: { cell: Cell; slot: string; action: () => Promise<void>; verb: string }) {
  if (cell.state === "current") return <p className="rounded-lg border border-dashed border-accent px-2 py-1 text-center text-xs text-accent-ink">hier liegt die Stunde</p>;
  if (cell.state === "blocked") {
    return (
      <ul aria-label={`${slot} belegt`} className="rounded-lg bg-surface-2 px-2 py-1 text-xs text-muted">
        {cell.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-0.5">
      {cell.state === "swap" ? (
        <Button type="submit" size="sm" className="h-8 w-full" aria-label={`${slot}: tauschen mit ${cell.label}`}>
          <ArrowLeftRight aria-hidden />
          Tauschen
        </Button>
      ) : (
        <Button type="submit" size="sm" variant="primary" className="h-8 w-full" aria-label={`${verb}: ${slot}`}>
          {verb === "Hier setzen" ? "Setzen" : "Hierher"}
        </Button>
      )}
      {cell.state === "free" && cell.roomNote && <span className="text-xs text-warn">{cell.roomNote}</span>}
    </form>
  );
}
