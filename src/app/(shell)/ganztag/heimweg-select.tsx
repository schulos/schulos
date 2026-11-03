"use client";

import { useState, useTransition } from "react";
import type { GanztagWayHome } from "@/core/db/schema";
import { setDayWayAction, setWayRuleAction } from "@/modules/ganztag/actions";
import { WAY_LABEL } from "@/modules/ganztag/labels";
import { Select } from "@schulos/ui/field";

const WAYS = Object.keys(WAY_LABEL) as GanztagWayHome[];

/**
 * GT-09: Heimweg wählen – als Regel je Angebot (`groupId`) oder als Tagesänderung je Termin (`sessionId`). Nur die Art, keine
 * Namen Abholberechtigter.
 */
export function WaySelect({
  label,
  studentId,
  groupId,
  sessionId,
  value,
  emptyLabel,
}: {
  label: string;
  studentId: string;
  groupId?: string;
  sessionId?: string;
  value: GanztagWayHome | null;
  emptyLabel: string;
}) {
  const [current, setCurrent] = useState<string>(value ?? "");
  const [msg, setMsg] = useState<{ error?: string; message?: string }>({});
  const [pending, start] = useTransition();

  function change(next: string) {
    const before = current;
    setCurrent(next);
    start(async () => {
      const r = sessionId ? await setDayWayAction(sessionId, studentId, next || null) : await setWayRuleAction(groupId!, studentId, next || null);
      if (r.error) setCurrent(before);
      setMsg(r);
    });
  }

  return (
    <span className="flex flex-col gap-1">
      <Select aria-label={label} value={current} disabled={pending} onChange={(e) => change(e.target.value)} className="w-auto">
        <option value="">{emptyLabel}</option>
        {WAYS.map((w) => (
          <option key={w} value={w}>
            {WAY_LABEL[w]}
          </option>
        ))}
      </Select>
      {msg.error ? (
        <span role="alert" className="text-sm text-danger">
          {msg.error}
        </span>
      ) : msg.message ? (
        <span role="status" className="text-sm text-muted">
          {msg.message}
        </span>
      ) : null}
    </span>
  );
}
