"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { setEntryAction, setFinalAction } from "@/modules/notenbuch/actions";
import {
  COMMENT_MAX,
  computeStudent,
  defaultKey,
  distribution,
  formatAverage,
  gradeFromPoints,
  normalizeInput,
  parseEntry,
  scaleValues,
  weightsSum,
  type ColumnKind,
  type GradeKey,
  type Scale,
  type RoundingMode,
  type Weights,
} from "@/modules/notenbuch/berechnung";
import type { OfflineDecision } from "@/modules/notenbuch/offline-reasons";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { Textarea } from "@schulos/ui/field";
import { Kbd } from "@schulos/ui/misc";
import { OfflineConflicts, OfflinePanel, useOfflineGrades } from "./offline";

export interface TableColumn {
  id: string;
  kind: ColumnKind;
  title: string;
  date: string | null;
  weight: number;
  maxPoints: number | null;
  key: GradeKey | null;
}

export interface TableCell {
  value: string;
  comment: string | null;
  version: number;
}

const cellKey = (columnId: string, studentId: string) => `${columnId}:${studentId}`;
const finalKey = (studentId: string) => `final:${studentId}`;
const shown = (v: string) => v.replace(".", ",");
const KIND_SHORT: Record<ColumnKind, string> = { schriftlich: "schriftl.", sonstige: "sonst." };

/** Kurzformen beim Tippen: „f“ = fehlt, „b“ = befreit. */
function expandShortcut(raw: string): string {
  const t = raw.trim().toLowerCase();
  return t === "f" ? "fehlt" : t === "b" ? "befreit" : raw;
}

function formatDate(ymd: string | null): string {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-");
  return `${d}.${m}.${y}`;
}

/**
 * Notentabelle (P5-12): Schüler:innen × Spalten, reine Tastatureingabe. Pfeiltasten wechseln die Zelle (links/rechts am
 * Rand des Textes), Enter speichert und geht nach unten, Tab nach rechts, Escape verwirft, F2 öffnet den Kommentar. Werte
 * werden sofort geprüft (ungültig → rot, nicht gespeichert) und optimistisch angezeigt; gespeichert wird mit der erwarteten
 * Version der Zelle – hat jemand anderes sie inzwischen geändert, erscheint ein Hinweis zum Neuladen. Vorschlag, Durchschnitt
 * und Notenspiegel rechnen live mit (dieselbe Rechenlogik wie der Server, berechnung.ts). Die letzte bedienbare Spalte ist die
 * festgelegte Halbjahresnote (P5-13, abweichend vom Vorschlag erlaubt, „b“ = befreit, leer = zurücknehmen).
 * P5-20: Ist die Offline-Eingabe auf diesem Gerät eingeschaltet, landet eine Teilnote ohne Verbindung in der verschlüsselten
 * Warteschlange (offline.tsx) und wird beim nächsten Kontakt abgeglichen – Konflikte erscheinen unter der Tabelle.
 */
export function GradeTable({
  bookId,
  userId,
  finals,
  scale,
  weights,
  rounding = "schueler",
  locked,
  columns,
  students,
  entries,
  absences,
  offline: offlineDecision,
  lockedNote = "Das Notenbuch ist abgeschlossen und gesperrt – Noten lassen sich nur noch lesen.",
}: {
  bookId: string;
  /** eigenes Konto – Offline-Zwischenspeicher je Konto (G5A-S05) */
  userId: string;
  /** festgelegte Halbjahresnote je Schüler:in (P5-13) */
  finals: Record<string, string | null>;
  scale: Scale;
  weights: Weights;
  /** Q-5A-1: Rundung auf der Grenze x,5 nach Einstellung der Schule */
  rounding?: RoundingMode;
  locked: boolean;
  columns: TableColumn[];
  students: { id: string; name: string }[];
  entries: Record<string, TableCell>;
  absences: Record<string, number>;
  /** Offline-Eingabe auf diesem Gerät erlaubt? (P5-20, Entscheidung des Servers für diese Anfrage) */
  offline: OfflineDecision;
  /** Hinweis über der gesperrten Tabelle (abgeschlossen bzw. Vorjahr, P5-15) */
  lockedNote?: string;
}) {
  const [cells, setCells] = useState<Record<string, TableCell>>(entries);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const [announce, setAnnounce] = useState("");
  const [comment, setComment] = useState<{ key: string; text: string } | null>(null);
  const [finalValues, setFinalValues] = useState<Record<string, string | null>>(finals);

  // synchron lesbare Spiegel (Blur nach Enter darf nicht doppelt speichern; Speichern je Zelle nacheinander mit aktueller Version)
  const cellsRef = useRef(cells);
  const finalsRef = useRef(finalValues);
  const draftsRef = useRef(drafts);
  const queue = useRef(new Map<string, Promise<void>>());
  const inputs = useRef(new Map<string, HTMLInputElement>());

  const updateCells = (fn: (c: Record<string, TableCell>) => Record<string, TableCell>) => {
    cellsRef.current = fn(cellsRef.current);
    setCells(cellsRef.current);
  };
  const updateDrafts = (fn: (d: Record<string, string>) => Record<string, string>) => {
    draftsRef.current = fn(draftsRef.current);
    setDrafts(draftsRef.current);
  };
  const setError = (k: string, msg: string | null) =>
    setErrors((e) => {
      const next = { ...e };
      if (msg) next[k] = msg;
      else delete next[k];
      return next;
    });

  // P5-20: Offline-Warteschlange – angewendete Änderungen bringen die neue Revision, „Server-Wert behalten“ den Server-Stand
  const offline = useOfflineGrades(bookId, userId, offlineDecision, locked, {
    onApplied: (k, op, version) =>
      updateCells((c) => {
        const next = { ...c };
        if (op.value === "") delete next[k];
        else next[k] = { value: op.value, comment: op.comment, version };
        return next;
      }),
    onServerValue: (k, cell) =>
      updateCells((c) => {
        const next = { ...c };
        if (cell) next[k] = { value: cell.value, comment: cell.comment, version: cell.version };
        else delete next[k];
        return next;
      }),
    onRejected: (k, _op, reason) => setError(k, reason),
  });
  const offlineRef = useRef(offline);
  useEffect(() => {
    offlineRef.current = offline;
  }, [offline]);

  const dirty = pending > 0 || Object.keys(drafts).length > 0;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const results = useMemo(
    () =>
      new Map(
        students.map((s) => {
          const values = new Map<string, string>();
          for (const c of columns) {
            const v = cells[cellKey(c.id, s.id)]?.value;
            if (v !== undefined) values.set(c.id, v);
          }
          return [s.id, computeStudent(scale, weights, columns, values, rounding)];
        }),
      ),
    [cells, columns, students, scale, weights, rounding],
  );
  const spiegel = useMemo(
    () => columns.map((c) => distribution(scale, c, students.map((s) => cells[cellKey(c.id, s.id)]?.value).filter((v): v is string => v !== undefined))),
    [cells, columns, students, scale],
  );
  const sum = weightsSum(weights);

  /** Speichern einer Zelle – je Zelle nacheinander, immer mit der zuletzt bestätigten Version. */
  const save = (columnId: string, studentId: string, value: string, commentText: string | null, label: string) => {
    const k = cellKey(columnId, studentId);
    const before = cellsRef.current[k];
    updateCells((c) => {
      const next = { ...c };
      if (value === "") delete next[k];
      else next[k] = { value, comment: commentText, version: before?.version ?? 0 };
      return next;
    });
    setPending((n) => n + 1);
    const run = async () => {
      const expectedVersion = cellsRef.current[k]?.version ?? before?.version ?? 0;
      // P5-20: ohne Verbindung (oder wenn die Anfrage scheitert) in die verschlüsselte Warteschlange – nur mit eingeschalteter
      // Offline-Eingabe; die Zelle behält den eingegebenen Wert und wird als „noch nicht übertragen“ markiert
      const queueOffline = async () => {
        const o = offlineRef.current;
        if (o.status !== "aktiv") return false;
        if (!(await o.enqueue({ columnId, studentId, value, comment: commentText, baseVersion: expectedVersion }))) return false;
        setError(k, null);
        setAnnounce(`${label}: offline gespeichert – wird übertragen, sobald Verbindung besteht`);
        return true;
      };
      try {
        if (!navigator.onLine && offlineRef.current.status === "aktiv" && (await queueOffline())) return;
        const res = await setEntryAction({ columnId, studentId, value, comment: commentText, expectedVersion });
        if (res.ok) {
          updateCells((c) => (value === "" ? c : { ...c, [k]: { value, comment: commentText, version: res.version ?? expectedVersion + 1 } }));
          setError(k, null);
        } else {
          updateCells((c) => {
            const next = { ...c };
            if (before) next[k] = before;
            else delete next[k];
            return next;
          });
          if (res.conflict) setConflict(true);
          else setError(k, res.error ?? "Nicht gespeichert");
          setAnnounce(`${label}: ${res.error ?? "nicht gespeichert"}`);
        }
      } catch {
        if (!(await queueOffline())) setError(k, "Nicht gespeichert – Verbindung prüfen");
      } finally {
        setPending((n) => n - 1);
      }
    };
    const p = (queue.current.get(k) ?? Promise.resolve()).then(run);
    queue.current.set(k, p);
  };

  /** Halbjahresnote prüfen und speichern (P5-13) – zuletzt gewinnt, ohne Versionsprüfung (Q-5A-13). */
  const commitFinal = (r: number): boolean => {
    const s = students[r];
    if (!s || locked) return true;
    const k = finalKey(s.id);
    const draft = draftsRef.current[k];
    if (draft === undefined) return true;
    const label = `${s.name}, Halbjahresnote`;
    const t = draft.trim().toLowerCase();
    const value = t === "b" ? "befreit" : normalizeInput(draft);
    if (value !== "" && value !== "befreit" && !scaleValues(scale).includes(value)) {
      const msg = `Halbjahresnote: ${scale === "noten6" ? "1 bis 6" : scale === "noten6_tendenz" ? "1+ bis 6" : "0 bis 15 Punkte"} oder „befreit“`;
      setError(k, msg);
      setAnnounce(`${label}: ${msg}`);
      return false;
    }
    updateDrafts((d) => {
      const next = { ...d };
      delete next[k];
      return next;
    });
    setError(k, null);
    const before = finalsRef.current[s.id] ?? null;
    if ((before ?? "") === value) return true;
    finalsRef.current = { ...finalsRef.current, [s.id]: value || null };
    setFinalValues(finalsRef.current);
    setPending((n) => n + 1);
    const run = async () => {
      try {
        const res = await setFinalAction(bookId, s.id, value);
        if (!res.ok) {
          finalsRef.current = { ...finalsRef.current, [s.id]: before };
          setFinalValues(finalsRef.current);
          setError(k, res.error ?? "Nicht gespeichert");
          setAnnounce(`${label}: ${res.error ?? "nicht gespeichert"}`);
        }
      } catch {
        setError(k, "Nicht gespeichert – Verbindung prüfen");
      } finally {
        setPending((n) => n - 1);
      }
    };
    const p = (queue.current.get(k) ?? Promise.resolve()).then(run);
    queue.current.set(k, p);
    setAnnounce(`${label}: ${value || "zurückgenommen"}`);
    return true;
  };

  /** Entwurf einer Zelle prüfen und speichern. false = ungültig (Fokus bleibt). */
  const commit = (r: number, c: number): boolean => {
    if (c === columns.length) return commitFinal(r);
    const s = students[r];
    const col = columns[c];
    if (!s || !col || locked) return true;
    const k = cellKey(col.id, s.id);
    const draft = draftsRef.current[k];
    if (draft === undefined) return true;
    const label = `${s.name}, ${col.title}`;
    const parsed = parseEntry(expandShortcut(draft), scale, col);
    if (parsed.kind === "invalid") {
      setError(k, parsed.error);
      setAnnounce(`${label}: ${parsed.error}`);
      return false;
    }
    const value = parsed.kind === "grade" ? (parsed.points !== undefined ? String(parsed.points) : parsed.label) : parsed.kind === "empty" ? "" : parsed.kind;
    updateDrafts((d) => {
      const next = { ...d };
      delete next[k];
      return next;
    });
    setError(k, null);
    const stored = cellsRef.current[k];
    if (value === (stored?.value ?? "")) return true;
    // ein Kommentar braucht einen Wert – beim Leeren fällt er mit weg
    save(col.id, s.id, value, value === "" ? null : (stored?.comment ?? null), label);
    setAnnounce(`${label}: ${value === "" ? "gelöscht" : shown(value)}`);
    return true;
  };

  const focusCell = (r: number, c: number) => {
    const rr = Math.max(0, Math.min(students.length - 1, r));
    const cc = Math.max(0, Math.min(columns.length, c));
    const el = inputs.current.get(`${rr}:${cc}`);
    el?.focus();
  };

  const openComment = (r: number, c: number) => {
    const s = students[r];
    const col = columns[c];
    if (!s || !col) return;
    const k = cellKey(col.id, s.id);
    setComment({ key: k, text: cellsRef.current[k]?.comment ?? "" });
    requestAnimationFrame(() => document.getElementById("nb-kommentar")?.focus());
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    const el = e.currentTarget;
    // ganz markiert (frisch angesprungen) zählt als Rand: dann wechseln ←/→ die Zelle, beim Tippen erst am Textrand
    const all = el.selectionStart === 0 && el.selectionEnd === el.value.length;
    const atStart = all || (el.selectionStart === 0 && el.selectionEnd === 0);
    const atEnd = all || (el.selectionStart === el.value.length && el.selectionEnd === el.value.length);
    const go = (dr: number, dc: number) => {
      e.preventDefault();
      if (commit(r, c)) focusCell(r + dr, c + dc);
    };
    if (e.key === "Enter") go(e.shiftKey ? -1 : 1, 0);
    else if (e.key === "ArrowDown") go(1, 0);
    else if (e.key === "ArrowUp") go(-1, 0);
    else if (e.key === "ArrowLeft" && atStart) go(0, -1);
    else if (e.key === "ArrowRight" && atEnd) go(0, 1);
    else if (e.key === "F2") {
      e.preventDefault();
      if (c < columns.length && commit(r, c)) openComment(r, c);
    } else if (e.key === "Escape") {
      const k = c === columns.length ? finalKey(students[r]!.id) : cellKey(columns[c]!.id, students[r]!.id);
      updateDrafts((d) => {
        const next = { ...d };
        delete next[k];
        return next;
      });
      setError(k, null);
    }
  };

  const activeStudent = active ? students[active.r] : undefined;
  const activeColumn = active ? columns[active.c] : undefined;
  const commentCell = comment ? cells[comment.key] : undefined;
  const commentTarget = comment ? { student: students.find((s) => comment.key.endsWith(`:${s.id}`)), column: columns.find((c) => comment.key.startsWith(`${c.id}:`)) } : null;
  const errorList = Object.entries(errors);

  return (
    <section aria-labelledby="noten" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="noten" className="font-display text-xl font-bold">
          Noten
        </h2>
        <p className="text-xs text-muted">
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> <Kbd>←</Kbd> <Kbd>→</Kbd> Zelle wechseln · <Kbd>Enter</Kbd> speichern · <Kbd>Esc</Kbd> verwerfen · <Kbd>F2</Kbd> Kommentar ·{" "}
          <Kbd>f</Kbd> fehlt · <Kbd>b</Kbd> befreit
        </p>
      </div>
      {columns.length === 0 && (
        <p className="rounded-card border border-dashed border-border-strong px-6 py-6 text-center text-sm text-muted">
          Noch keine Spalte – lege unten eine Spalte an oder übernimm einen Termin aus dem Klausurplan.
        </p>
      )}
      {sum !== 100 && (
        <p role="note" className="rounded-xl border border-warn-border bg-warn-soft px-4 py-2 text-sm text-warn">
          Die Gewichte ergeben zusammen {sum} % statt 100 %. Der Vorschlag rechnet mit den Anteilen ({weights.schriftlich ?? 0} : {weights.sonstige ?? 0}).
        </p>
      )}
      {conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-danger bg-danger-soft px-4 py-2 text-sm text-danger">
          <span>Eine Zelle wurde inzwischen von einer anderen Lehrkraft geändert – deine Eingabe dort ist nicht gespeichert. Bitte neu laden.</span>
          <Button size="sm" onClick={() => window.location.reload()}>
            Neu laden
          </Button>
        </div>
      )}
      {locked && (
        <p role="note" className="rounded-xl border border-border bg-surface-2 px-4 py-2 text-sm text-muted">
          {lockedNote}
        </p>
      )}
      <OfflinePanel offline={offline} locked={locked} />
      <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <table className="w-full border-collapse text-left text-sm" aria-label="Notentabelle" aria-describedby="noten-hinweis">
          <thead>
            <tr className="align-bottom text-xs text-muted">
              <th scope="col" className="sticky left-0 z-10 bg-surface px-3 py-2 font-semibold">
                Name
              </th>
              {columns.map((c) => (
                <th key={c.id} scope="col" className="min-w-24 px-2 py-2 font-semibold" title={[c.title, formatDate(c.date)].filter(Boolean).join(" · ")}>
                  <span className="block max-w-32 truncate text-ink">{c.title}</span>
                  <span className="font-normal">
                    {KIND_SHORT[c.kind]}
                    {c.weight !== 100 && ` · ×${shown(String(c.weight / 100))}`}
                    {c.maxPoints !== null && ` · ${shown(String(c.maxPoints))} P`}
                  </span>
                </th>
              ))}
              <th scope="col" className="px-2 py-2 font-semibold">
                Ø
              </th>
              <th scope="col" className="px-2 py-2 font-semibold">
                Vorschlag
              </th>
              <th scope="col" className="px-2 py-2 font-semibold" title="festgelegte Halbjahresnote (abweichend vom Vorschlag erlaubt)">
                Halbjahresnote
              </th>
              <th scope="col" className="px-2 py-2 font-semibold" title="Fehlstunden aus deinen eigenen Stunden (Klassenbuch), ohne Grund">
                Fehlst.
              </th>
            </tr>
          </thead>
          <tbody>
            {students.map((s, r) => {
              const res = results.get(s.id);
              return (
                <tr key={s.id} className="border-t border-border">
                  <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-1.5 text-left font-medium whitespace-nowrap">
                    {s.name}
                  </th>
                  {columns.map((col, c) => {
                    const k = cellKey(col.id, s.id);
                    const cell = cells[k];
                    const draft = drafts[k];
                    const err = errors[k];
                    const derived =
                      draft === undefined && cell && col.maxPoints !== null && /^\d/.test(cell.value)
                        ? gradeFromPoints(Number(cell.value), col.maxPoints, col.key ?? defaultKey(scale))
                        : null;
                    const queued = offline.pending.has(k);
                    return (
                      <td key={col.id} className="px-1 py-1">
                        <span className="flex items-center gap-1">
                          <input
                            ref={(el) => {
                              if (el) inputs.current.set(`${r}:${c}`, el);
                              else inputs.current.delete(`${r}:${c}`);
                            }}
                            aria-label={`${s.name} – ${col.title}`}
                            aria-invalid={err ? true : undefined}
                            data-offline={queued ? "pending" : undefined}
                            title={err ?? (queued ? "Offline gespeichert – wird übertragen, sobald Verbindung besteht" : (cell?.comment ?? undefined))}
                            readOnly={locked}
                            inputMode="text"
                            autoComplete="off"
                            spellCheck={false}
                            className={cn(
                              "h-9 w-16 rounded-lg border border-transparent bg-transparent px-2 text-center outline-none focus:border-accent focus:ring-2 focus:ring-accent/25",
                              err && "border-danger bg-danger-soft text-danger",
                              !err && draft !== undefined && "border-border-strong",
                            )}
                            value={draft ?? (cell ? shown(cell.value) : "")}
                            onChange={(e) => {
                              const v = e.target.value;
                              updateDrafts((d) => ({ ...d, [k]: v }));
                              if (err) setError(k, null);
                            }}
                            onFocus={(e) => {
                              setActive({ r, c });
                              e.currentTarget.select();
                            }}
                            onBlur={() => commit(r, c)}
                            onKeyDown={(e) => onKeyDown(e, r, c)}
                          />
                          {derived && <span className="text-xs text-muted">{derived}</span>}
                          {queued && (
                            <span className="text-xs text-warn" aria-label="offline gespeichert, noch nicht übertragen" title="Offline gespeichert – wird übertragen, sobald Verbindung besteht">
                              ⟳
                            </span>
                          )}
                          {cell?.comment && (
                            <span className="text-xs text-accent-ink" aria-label="mit Kommentar" title={cell.comment}>
                              •
                            </span>
                          )}
                        </span>
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5 text-muted tabular-nums">{formatAverage(res?.average ?? null)}</td>
                  <td className="px-2 py-1.5 font-semibold" data-testid={`vorschlag-${s.id}`}>
                    {res?.grade ?? "–"}
                  </td>
                  <td className="px-1 py-1">
                    <input
                      ref={(el) => {
                        if (el) inputs.current.set(`${r}:${columns.length}`, el);
                        else inputs.current.delete(`${r}:${columns.length}`);
                      }}
                      aria-label={`${s.name} – Halbjahresnote`}
                      aria-invalid={errors[finalKey(s.id)] ? true : undefined}
                      title={errors[finalKey(s.id)] ?? (finalValues[s.id] && res?.grade && finalValues[s.id] !== res.grade ? "weicht vom Vorschlag ab" : undefined)}
                      readOnly={locked}
                      autoComplete="off"
                      spellCheck={false}
                      className={cn(
                        "h-9 w-16 rounded-lg border border-border bg-surface-2 px-2 text-center font-semibold outline-none focus:border-accent focus:ring-2 focus:ring-accent/25",
                        errors[finalKey(s.id)] && "border-danger bg-danger-soft text-danger",
                      )}
                      value={drafts[finalKey(s.id)] ?? finalValues[s.id] ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        updateDrafts((d) => ({ ...d, [finalKey(s.id)]: v }));
                        if (errors[finalKey(s.id)]) setError(finalKey(s.id), null);
                      }}
                      onFocus={(e) => {
                        setActive({ r, c: columns.length });
                        e.currentTarget.select();
                      }}
                      onBlur={() => commit(r, columns.length)}
                      onKeyDown={(e) => onKeyDown(e, r, columns.length)}
                    />
                  </td>
                  <td className="px-2 py-1.5 text-muted tabular-nums">{absences[s.id] ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border align-top text-xs text-muted">
              <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-semibold">
                Notenspiegel
              </th>
              {spiegel.map((d, c) => (
                <td key={columns[c]!.id} className="px-2 py-2" aria-label={`Notenspiegel ${columns[c]!.title}`}>
                  <span className="block whitespace-nowrap">{d.buckets.map((b) => `${b.grade}:${b.count}`).join(" ")}</span>
                  <span className="block">
                    Ø {formatAverage(d.average)}
                    {d.fehlt > 0 && ` · fehlt ${d.fehlt}`}
                    {d.befreit > 0 && ` · befreit ${d.befreit}`}
                  </span>
                </td>
              ))}
              <td colSpan={4} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p id="noten-hinweis" className="text-xs text-muted">
        {scale === "noten6" ? "Noten 1 bis 6" : scale === "noten6_tendenz" ? "Noten 1+ bis 6 (mit + oder −)" : "0 bis 15 Punkte"}, bei Spalten mit
        Höchstpunktzahl die erreichten Punkte. „fehlt“ und „befreit“ zählen nicht. Der Notenspiegel zeigt nur Anzahlen, keine Namen.
      </p>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted" data-testid="noten-status">
        {pending > 0 ? "Speichert …" : announce}
      </p>
      <OfflineConflicts
        offline={offline}
        label={(op) => `${students.find((x) => x.id === op.studentId)?.name ?? "?"}, ${columns.find((x) => x.id === op.columnId)?.title ?? "?"}`}
      />
      {errorList.length > 0 && (
        <ul role="alert" className="text-sm text-danger">
          {errorList.map(([k, msg]) => {
            const s = students.find((x) => k.endsWith(`:${x.id}`));
            const col = k.startsWith("final:") ? { title: "Halbjahresnote" } : columns.find((x) => k.startsWith(`${x.id}:`));
            return <li key={k}>{`${s?.name ?? ""}, ${col?.title ?? ""}: ${msg}`}</li>;
          })}
        </ul>
      )}
      {comment && commentTarget?.student && commentTarget.column && (
        <form
          aria-label="Kommentar zur Note"
          className="flex max-w-2xl flex-col gap-2 rounded-card border border-border bg-surface p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!commentCell || locked) return;
            const text = comment.text.trim();
            save(commentTarget.column!.id, commentTarget.student!.id, commentCell.value, text || null, `${commentTarget.student!.name}, ${commentTarget.column!.title}`);
            setAnnounce(`Kommentar ${text ? "gespeichert" : "entfernt"}`);
            setComment(null);
            const r = students.indexOf(commentTarget.student!);
            const c = columns.indexOf(commentTarget.column!);
            requestAnimationFrame(() => focusCell(r, c));
          }}
        >
          <label htmlFor="nb-kommentar" className="text-sm font-medium">
            Kommentar: {commentTarget.student.name} – {commentTarget.column.title}
          </label>
          <Textarea
            id="nb-kommentar"
            maxLength={COMMENT_MAX}
            rows={2}
            readOnly={locked}
            aria-describedby="nb-kommentar-hinweis"
            value={comment.text}
            disabled={!commentCell}
            onChange={(e) => setComment({ ...comment, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                const r = students.indexOf(commentTarget.student!);
                const c = columns.indexOf(commentTarget.column!);
                setComment(null);
                requestAnimationFrame(() => focusCell(r, c));
              }
            }}
          />
          <p id="nb-kommentar-hinweis" className="text-xs text-muted">
            {commentCell ? `${comment.text.length}/${COMMENT_MAX} Zeichen. ` : "Erst einen Wert eintragen (Note, „fehlt“ oder „befreit“). "}
            Nur kurze fachliche Hinweise – <strong>keine Gesundheits- oder Verhaltensangaben</strong>. Kommentare sehen nur die Lehrkräfte dieses
            Notenbuchs; Schüler:innen und Eltern können sie per Auskunft erhalten.
          </p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={!commentCell || locked}>
              Kommentar speichern
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setComment(null)}>
              Schließen
            </Button>
          </div>
        </form>
      )}
      {!comment && activeStudent && activeColumn && active!.c < columns.length && (
        <p className="text-xs text-muted">
          {activeStudent.name} – {activeColumn.title}
          {cells[cellKey(activeColumn.id, activeStudent.id)]?.comment ? `: „${cells[cellKey(activeColumn.id, activeStudent.id)]!.comment}“` : ""} · Kommentar mit{" "}
          <Kbd>F2</Kbd> oder{" "}
          <button type="button" className="font-medium text-accent-ink hover:underline" onClick={() => openComment(active!.r, active!.c)}>
            hier
          </button>
        </p>
      )}
    </section>
  );
}
