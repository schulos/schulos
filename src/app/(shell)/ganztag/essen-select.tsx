"use client";

import { useState, useTransition } from "react";
import { setMealOrderAction } from "@/modules/ganztag/actions";
import { Select } from "@schulos/ui/field";

/** GT-11: An- bzw. Abmelden für einen Tag mit Menüwahl (nur die Menünummer, keine Gesundheitsangaben). */
export function MealSelect({ label, studentId, date, menus, value }: { label: string; studentId: string; date: string; menus: { number: number; title: string }[]; value: number | null }) {
  const [current, setCurrent] = useState(value === null ? "" : String(value));
  const [msg, setMsg] = useState<{ error?: string; message?: string }>({});
  const [pending, start] = useTransition();

  function change(next: string) {
    const before = current;
    setCurrent(next);
    start(async () => {
      const r = await setMealOrderAction(studentId, date, next ? Number(next) : null);
      if (r.error) setCurrent(before);
      setMsg(r);
    });
  }

  return (
    <span className="flex flex-col gap-1">
      <Select aria-label={label} value={current} disabled={pending} onChange={(e) => change(e.target.value)} className="w-auto max-w-full">
        <option value="">nicht angemeldet</option>
        {menus.map((m) => (
          <option key={m.number} value={m.number}>
            Menü {m.number}: {m.title}
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
