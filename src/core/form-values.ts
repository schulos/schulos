// Eingaben eines Formulars nach einem Validierungsfehler zurückgeben (TD-02): React 19 setzt Formulare nach einer Server
// Action zurück – die Formulare bauen sich mit diesen Werten als Vorgabe neu auf (FormState.values + key).

/**
 * Felder als Text; interne Felder von Next ($ACTION_…) und Dateien fallen weg. Mehrfachwerte (Mehrfachauswahl): unter dem
 * Namen der letzte, zusätzlich alle als JSON-Liste unter `<name>[]` – siehe listAfter.
 */
export function formValues(form: FormData): Record<string, string> {
  const entries = [...form.entries()].filter(([k, v]) => !k.startsWith("$") && typeof v === "string") as [string, string][];
  const out: Record<string, string> = Object.fromEntries(entries);
  const all = new Map<string, string[]>();
  for (const [k, v] of entries) all.set(k, [...(all.get(k) ?? []), v]);
  for (const [k, list] of all) if (list.length > 1) out[`${k}[]`] = JSON.stringify(list);
  return out;
}

/** Mehrfachauswahl: nach einem Fehler die abgeschickten Werte (auch keiner), sonst die Vorgabe. */
export function listAfter(values: Record<string, string> | undefined, name: string, initial: string[]): string[] {
  if (!values) return initial;
  const many = values[`${name}[]`];
  if (many) {
    try {
      const list: unknown = JSON.parse(many);
      if (Array.isArray(list)) return list.map(String);
    } catch {
      // kaputter Wert: wie einzelner Wert behandeln
    }
  }
  return values[name] ? [values[name]] : [];
}

/** Kontrollkästchen: nach einem Fehler wie abgeschickt, sonst die Vorgabe */
export function checkedAfter(values: Record<string, string> | undefined, name: string, initial: boolean | undefined): boolean | undefined {
  return values ? values[name] === "on" : initial;
}
