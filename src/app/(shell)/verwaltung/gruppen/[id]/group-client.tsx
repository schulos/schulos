"use client";

import { Crown, Search, Trash2, UserMinus, UserPlus } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { ROLE_LABELS } from "@/core/labels";
import {
  addMemberAction,
  deleteGroupAction,
  removeMemberAction,
  searchCandidatesAction,
  setGroupFeatureAction,
  setMemberRoleAction,
} from "@/modules/verwaltung/group-actions";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Input } from "@schulos/ui/field";
import { Avatar, initials } from "@schulos/ui/misc";
import type { Role } from "@/core/roles";

interface Member {
  id: string;
  name: string;
  detail: string;
  leader: boolean;
}

type Candidate = Awaited<ReturnType<typeof searchCandidatesAction>>[number];

export function MemberManager({ groupId, members, leaderLabel = "Leitung" }: { groupId: string; members: Member[]; leaderLabel?: string }) {
  const [q, setQ] = useState("");
  const latestQ = useRef("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Kandidatensuche mit kleiner Verzögerung
  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = setTimeout(() => {
      void searchCandidatesAction(groupId, q).then(setResults);
    }, 200);
    return () => clearTimeout(t);
  }, [q, groupId]);

  const shown = filter ? members.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase())) : members;

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <label htmlFor="add-member" className="mb-1.5 block text-sm font-medium">
          Mitglied hinzufügen
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input
            id="add-member"
            value={q}
            onChange={(e) => {
              latestQ.current = e.target.value;
              setQ(e.target.value);
              if (e.target.value.trim().length < 2) setResults([]);
            }}
            placeholder="Name, Benutzername oder Kürzel"
            className="pl-9"
            autoComplete="off"
          />
        </div>
        {results.length > 0 && (
          <ul aria-label="Suchtreffer" className="mt-2 flex flex-col gap-1 rounded-xl border border-border bg-surface p-1 shadow-card">
            {results.map((c) => (
              <li key={c.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate font-medium">{c.name}</span>
                  <span className="text-xs text-muted">
                    {ROLE_LABELS[c.role as Role]}
                    {c.shortCode ? ` · ${c.shortCode}` : ""} · {c.username}
                  </span>
                </span>
                <Button
                  size="sm"
                  disabled={pending}
                  aria-label={`${c.name} hinzufügen`}
                  onClick={() =>
                    start(async () => {
                      const typed = q;
                      const res = await addMemberAction(groupId, c.id);
                      setError(res.error ?? null);
                      if (res.error) return;
                      // Nur leeren, wenn inzwischen nicht schon weitergetippt wurde.
                      if (latestQ.current === typed) {
                        latestQ.current = "";
                        setQ("");
                        setResults([]);
                      } else {
                        setResults((r) => r.filter((x) => x.id !== c.id));
                      }
                    })
                  }
                >
                  <UserPlus aria-hidden /> Hinzufügen
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
      </div>

      {members.length > 10 && (
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Mitglieder filtern" aria-label="Mitglieder filtern" />
      )}

      <ul className="flex flex-col divide-y divide-border">
        {shown.map((m) => (
          <li key={m.id} className="flex items-center gap-3 py-2.5">
            <Avatar label={initials(m.name.split(", ").reverse().join(" "))} tone={m.leader ? "ink" : "soft"} className="size-8 text-xs" />
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate font-medium">{m.name}</span>
              <span className="text-xs text-muted">{m.detail}</span>
            </span>
            {m.leader && <Badge tone="soft">{leaderLabel}</Badge>}
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              aria-label={m.leader ? `${m.name}: Leitung entziehen` : `${m.name}: zur Leitung machen`}
              title={m.leader ? "Leitung entziehen" : "Zur Leitung machen"}
              onClick={() => start(() => setMemberRoleAction(groupId, m.id, m.leader ? "member" : "leader"))}
            >
              <Crown aria-hidden className={m.leader ? "fill-current" : undefined} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              aria-label={`${m.name} entfernen`}
              title="Aus der Gruppe entfernen"
              onClick={() => start(() => removeMemberAction(groupId, m.id))}
            >
              <UserMinus aria-hidden />
            </Button>
          </li>
        ))}
        {members.length === 0 && <li className="py-6 text-center text-sm text-muted">Noch keine Mitglieder</li>}
      </ul>
    </div>
  );
}

export function FeatureToggles({
  groupId,
  features,
  enabled,
}: {
  groupId: string;
  features: { id: string; label: string; moduleName: string }[];
  enabled: string[];
}) {
  const [pending, start] = useTransition();
  if (features.length === 0) {
    return <p className="text-sm text-muted">Noch kein Modul bietet Gruppenmerkmale an (z. B. Gruppenordner, Gruppenkalender).</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {features.map((f) => {
        const on = enabled.includes(f.id);
        return (
          <li key={f.id}>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-border px-3">
              <input
                type="checkbox"
                className="size-4 accent-[var(--accent)]"
                checked={on}
                disabled={pending}
                onChange={() => start(() => setGroupFeatureAction(groupId, f.id, !on))}
              />
              <span className="flex flex-col leading-tight">
                <span className="font-medium">{f.label}</span>
                <span className="text-xs text-muted">{f.moduleName}</span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

export function DeleteGroup({ id, name }: { id: string; name: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="danger"
        size="sm"
        disabled={pending}
        onClick={() => {
          if (confirm(`Gruppe „${name}“ wirklich löschen? Mitgliedschaften gehen verloren.`))
            start(async () => {
              const res = await deleteGroupAction(id);
              setError(res?.error ?? null);
            });
        }}
      >
        <Trash2 aria-hidden /> Löschen
      </Button>
      {error && (
        <p role="alert" className="basis-full text-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
}
