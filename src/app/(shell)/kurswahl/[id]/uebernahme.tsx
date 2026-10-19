import Link from "next/link";
import { getDb } from "@/core/db/client";
import type { KurswahlVerfahren } from "@/core/db/schema";
import { hasPermission, type PermissionSet } from "@/core/permissions";
import type { VerfahrenState } from "@/modules/kurswahl/service";
import { assignmentSuggestions, TRANSFER_GROUPS, transferPreview } from "@/modules/kurswahl/uebernahme";
import { assignmentsAction, transferAction } from "@/modules/kurswahl/uebernahme-actions";
import { Badge } from "@schulos/ui/badge";
import { Card } from "@schulos/ui/card";
import { Table } from "@schulos/ui/table";
import { TransferForm } from "../uebernahme-forms";
import { ActionButton } from "../wahl-forms";

/** P4-64: Übernahme in Gruppen (Vorschau mit Konflikten) und Lehraufträge-Vorschlag für die Unterrichtsverteilung. */
export async function UebernahmePart({ perms, v, state }: { perms: PermissionSet; v: KurswahlVerfahren; state: VerfahrenState }) {
  if (!v.allocatedAt) return null;
  const db = await getDb();
  const done = Boolean(v.transferredAt);
  const [preview, suggestions] = await Promise.all([done ? null : transferPreview(db, perms, v), done ? assignmentSuggestions(db, perms, v) : []]);
  return (
    <section aria-labelledby="uebernahme" className="flex flex-col gap-3">
      <h2 id="uebernahme" className="font-display text-xl font-bold">
        Übernahme in Gruppen
      </h2>
      {preview && (
        <Card className="flex flex-col gap-3">
          <ul className="flex flex-col gap-1">
            {preview.groups.map((g) => (
              <li key={g.offerId}>
                <strong>{g.name}</strong> – {g.students.length} Schüler:innen{g.teacherName ? `, Leitung ${g.teacherName}` : ""}
                {g.existingId && (
                  <Badge tone="soft" className="ml-2">
                    vorhandene Gruppe ergänzen
                  </Badge>
                )}
              </li>
            ))}
          </ul>
          {preview.conflicts.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-semibold">Hinweise</p>
              <ul aria-label="Hinweise zur Übernahme" className="list-disc pl-5 text-sm">
                {preview.conflicts.map((c, i) => (
                  <li key={i}>{c.text}</li>
                ))}
              </ul>
            </div>
          )}
          {state === "offen" ? (
            <p className="text-sm text-muted">Übernehmen geht erst nach dem Wahlende.</p>
          ) : hasPermission(perms, TRANSFER_GROUPS) ? (
            <TransferForm action={transferAction.bind(null, v.id)} conflicts={preview.conflicts.length} />
          ) : (
            <p className="text-sm text-muted">Übernehmen darf, wer Gruppen verwaltet (Recht „Gruppen verwalten“).</p>
          )}
        </Card>
      )}
      {done && (
        <>
          <p role="status">Übernommen – die Familien sehen jetzt ihren Kurs.</p>
          <Table>
            <thead>
              <tr>
                <th>Gruppe</th>
                <th>Lehrkraft</th>
                <th>Wochenstunden</th>
                <th>Lehrauftrag</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s) => (
                <tr key={s.offerId}>
                  <td>
                    <Link href={`/kurse/${s.groupId}`} className="hover:underline">
                      {s.groupName}
                    </Link>
                  </td>
                  <td>{s.teacherName ?? "offen"}</td>
                  <td className="tabular-nums">{s.hours ?? "–"}</td>
                  <td>{s.exists ? <Badge tone="success">angelegt</Badge> : s.missing.length ? <Badge tone="warn">fehlt: {s.missing.join(", ")}</Badge> : <Badge tone="soft">vorgeschlagen</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {suggestions.some((s) => !s.exists && !s.missing.length) &&
            (hasPermission(perms, "stundenplan.manage") ? (
              <ActionButton action={assignmentsAction.bind(null, v.id)} label="Vorgeschlagene Lehraufträge anlegen" doneText="%n Lehraufträge angelegt." variant="secondary" />
            ) : (
              // SP-03: Lehraufträge gehören zur Jahresplanung – die Stundenplanung legt sie an (Recht „Stundenplan planen“)
              <p className="text-sm text-muted">Die vorgeschlagenen Lehraufträge legt die Stundenplanung an.</p>
            ))}
        </>
      )}
    </section>
  );
}
