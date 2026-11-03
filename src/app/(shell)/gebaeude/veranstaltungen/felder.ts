import { EVENT_MAX_PERSONS, EVENT_NEED_KEYS, EVENT_NEEDS, EVENT_SEATING, EVENT_SEATING_LABELS, EVENT_TEXT_MAX } from "@/modules/gebaeude/labels";
import { toBerlinLocal } from "@/core/time";
import type { EventRow } from "@/modules/gebaeude/veranstaltungen";
import type { FieldSpec } from "@/ui/spec-form";

/**
 * Felder einer Veranstaltung für Anmelden (VA-02) und Bearbeiten (VA-05). Mit `e` vorbelegt aus der gespeicherten Veranstaltung;
 * ohne `e` mit einem Vorschlag in einer Woche, 18–20 Uhr.
 */
export function eventFields(rooms: { value: string; label: string }[], e: EventRow | null, day: string): FieldSpec[] {
  const local = (d: Date) => toBerlinLocal(d);
  return [
    { name: "title", label: "Was findet statt?", type: "text", required: true, maxLength: 120, wide: true, placeholder: "z. B. Elternabend Jahrgang 5", defaultValue: e?.title },
    { name: "start", label: "Beginn", type: "datetime-local", required: true, defaultValue: e ? local(e.startsAt) : `${day}T18:00` },
    { name: "end", label: "Ende", type: "datetime-local", required: true, defaultValue: e ? local(e.endsAt) : `${day}T20:00` },
    { name: "setup", label: "Aufbau ab", type: "datetime-local", hint: "leer = ab Beginn", defaultValue: e && e.setupAt < e.startsAt ? local(e.setupAt) : undefined },
    { name: "teardown", label: "Abbau bis", type: "datetime-local", hint: "leer = bis Ende", defaultValue: e && e.teardownAt > e.endsAt ? local(e.teardownAt) : undefined },
    { name: "roomIds", label: "Räume", type: "multiselect", options: rooms, wide: true, hint: "mehrere mit Strg bzw. ⌘", defaultValue: e?.rooms.join(",") },
    { name: "location", label: "Ort ohne Raum", type: "text", maxLength: 120, placeholder: "z. B. Schulhof, Sportplatz", defaultValue: e?.location ?? undefined },
    { name: "persons", label: "Erwartete Personen", type: "number", required: true, min: 1, max: EVENT_MAX_PERSONS, defaultValue: e ? String(e.persons) : undefined },
    { name: "seating", label: "Bestuhlung", type: "select", options: EVENT_SEATING.map((s) => ({ value: s, label: EVENT_SEATING_LABELS[s] })), defaultValue: e?.seating ?? "keine" },
    ...EVENT_NEED_KEYS.map((k): FieldSpec => ({ name: k, label: EVENT_NEEDS[k], type: "checkbox", wide: true, checked: e ? e[k] : undefined })),
    {
      name: "details",
      label: "Einzelheiten zum Bedarf",
      type: "textarea",
      maxLength: EVENT_TEXT_MAX,
      wide: true,
      hint: "z. B. Bühne, zwei Mikrofone, Tür zum Hof offen – bitte ohne Namen von Schüler:innen",
      defaultValue: e?.details ?? undefined,
    },
  ];
}
