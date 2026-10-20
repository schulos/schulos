"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useState } from "react";
import { Button } from "@schulos/ui/button";

// SP-08: Läufe aus der Historie zum Vergleich ankreuzen (höchstens drei). Ohne Skript sendet das Formular `laeufe` mehrfach,
// mit Skript geht es auf die kanonische Adresse `?laeufe=a,b,c`.

const FORM_ID = "vergleich-form";
export const VERGLEICH_PFAD = "/planung/solver/vergleich";

interface Ctx {
  selected: string[];
  max: number;
  toggle: (id: string) => void;
}
const CompareContext = createContext<Ctx>({
  selected: [],
  max: 3,
  toggle: () => {},
});

export function CompareProvider({
  max,
  children,
}: {
  max: number;
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) =>
    setSelected((s) =>
      s.includes(id)
        ? s.filter((x) => x !== id)
        : s.length < max
          ? [...s, id]
          : s,
    );
  return (
    <CompareContext.Provider value={{ selected, max, toggle }}>
      {children}
    </CompareContext.Provider>
  );
}

export function CompareCheckbox({ id, label }: { id: string; label: string }) {
  const { selected, max, toggle } = useContext(CompareContext);
  const checked = selected.includes(id);
  return (
    <input
      type="checkbox"
      name="laeufe"
      value={id}
      form={FORM_ID}
      checked={checked}
      disabled={!checked && selected.length >= max}
      onChange={() => toggle(id)}
      aria-label={`${label} zum Vergleich auswählen`}
      className="size-4 accent-[var(--accent)]"
    />
  );
}

export function CompareBar({ min }: { min: number }) {
  const { selected, max } = useContext(CompareContext);
  const router = useRouter();
  return (
    <form
      id={FORM_ID}
      method="get"
      action={VERGLEICH_PFAD}
      aria-label="Läufe vergleichen"
      className="flex flex-wrap items-center gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (selected.length >= min)
          router.push(
            `${VERGLEICH_PFAD}?laeufe=${selected.map(encodeURIComponent).join(",")}`,
          );
      }}
    >
      <Button type="submit" size="sm" disabled={selected.length < min}>
        Ausgewählte Läufe vergleichen
      </Button>
      <span role="status" className="text-sm text-muted">
        {selected.length === 0
          ? `${min} bis ${max} fertige Läufe ankreuzen.`
          : selected.length < min
            ? `${selected.length} gewählt – noch mindestens ${min - selected.length} ankreuzen.`
            : selected.length >= max
              ? `${selected.length} gewählt (höchstens ${max}).`
              : `${selected.length} gewählt.`}
      </span>
    </form>
  );
}
