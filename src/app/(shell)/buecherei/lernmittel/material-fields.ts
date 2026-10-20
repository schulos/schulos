import { COPY_CONDITIONS, CONDITION_LABELS, MATERIAL_PROVISIONS, PROVISION_LABELS, formatEuro } from "@/modules/buecherei/labels";
import type { FieldSpec } from "@/ui/spec-form";

export const CONDITION_OPTIONS = COPY_CONDITIONS.map((k) => ({ value: k, label: CONDITION_LABELS[k] }));
const PROVISION_OPTIONS = MATERIAL_PROVISIONS.map((k) => ({ value: k, label: PROVISION_LABELS[k] }));

export interface MaterialChoices {
  grades: { level: number; name: string }[];
  subjects: { id: string; name: string }[];
}

type Defaults = Partial<{
  title: string;
  author: string | null;
  isbn: string | null;
  publisher: string | null;
  subjectId: string | null;
  grades: number[];
  course: string | null;
  provision: string;
  priceCents: number | null;
  note: string | null;
}>;

/** Felder eines Lernmittels (BU-10) – Anlegen und Ändern. */
export function materialFields(c: MaterialChoices, d: Defaults = {}): FieldSpec[] {
  const s = (v: string | null | undefined) => v ?? "";
  return [
    { name: "title", label: "Titel", type: "text", required: true, maxLength: 200, wide: true, defaultValue: s(d.title) },
    {
      name: "grades",
      label: "Jahrgänge",
      type: "multiselect",
      options: c.grades.map((g) => ({ value: String(g.level), label: g.name })),
      defaultValue: (d.grades ?? []).join(","),
      hint: "mehrere mit Strg bzw. ⌘",
    },
    { name: "subjectId", label: "Fach", type: "select", options: [{ value: "", label: "– ohne Fach –" }, ...c.subjects.map((x) => ({ value: x.id, label: x.name }))], defaultValue: s(d.subjectId) },
    { name: "course", label: "Kurs/Zweig", type: "text", maxLength: 60, defaultValue: s(d.course), hint: "nur wenn nicht der ganze Jahrgang, z. B. „E-Kurs“" },
    { name: "provision", label: "Bereitstellung", type: "select", options: PROVISION_OPTIONS, defaultValue: d.provision ?? "leihe" },
    { name: "price", label: "Preis", type: "text", maxLength: 10, defaultValue: d.priceCents != null ? formatEuro(d.priceCents).replace(" €", "") : "", hint: "in Euro, z. B. 24,50" },
    { name: "isbn", label: "ISBN", type: "text", maxLength: 20, defaultValue: s(d.isbn) },
    { name: "publisher", label: "Verlag", type: "text", maxLength: 120, defaultValue: s(d.publisher) },
    { name: "author", label: "Autor:in/Herausgeber", type: "text", maxLength: 120, defaultValue: s(d.author) },
    { name: "note", label: "Hinweis auf der Bücherliste", type: "textarea", maxLength: 500, wide: true, defaultValue: s(d.note), hint: "z. B. „nur Arbeitsheft, ohne Lösungen“ – keine Personennamen" },
  ];
}
