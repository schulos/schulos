// Antworten prüfen und vervollständigen, schulos-install.yaml lesen und schreiben (INSTALLATION.md §2 „Unbeaufsichtigte
// Installation“). Die Datei ist verschachtelt (`network: { hostname: … }`), intern sind die Antworten flach (`network.hostname`).
import { Document, parse } from "yaml";
import { envSafe } from "./checks";
import { QUESTION_BY_ID, QUESTIONS, type Answers, type InstallContext, type Question, type Value } from "./questions";

export const INSTALL_FILE = "schulos-install.yaml";

export interface Issue {
  id: string;
  message: string;
}

export interface Resolved {
  /** nur die Angaben, die für Rolle/Instanztyp gelten, mit Vorgaben aufgefüllt */
  answers: Answers;
  errors: Issue[];
  warnings: Issue[];
  /** Pflichtfragen ohne Antwort (und ohne Vorgabe) – die TUI fragt sie, unbeaufsichtigt bricht der Installer ab */
  missing: string[];
  /** alles beantwortet und gültig */
  complete: boolean;
}

export function applies(q: Question, a: Answers, ctx: InstallContext = {}): boolean {
  if (q.hardware && ctx.image) return false;
  return q.when ? q.when(a) : true;
}

function isEmpty(v: Value | undefined): boolean {
  return v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Rohwert (YAML, Eingabezeile) in den Typ der Frage bringen. */
export function coerce(q: Question, raw: unknown): { ok: true; value: Value } | { ok: false; error: string } {
  switch (q.kind) {
    case "bool":
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (typeof raw === "string" && /^(ja|j|true|an|1)$/i.test(raw.trim())) return { ok: true, value: true };
      if (typeof raw === "string" && /^(nein|n|false|aus|0)$/i.test(raw.trim())) return { ok: true, value: false };
      return { ok: false, error: "ja oder nein" };
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
      return Number.isInteger(n) ? { ok: true, value: n } : { ok: false, error: "Ganze Zahl" };
    }
    case "list":
    case "disks": {
      const xs = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,;\n]+/) : null;
      if (!xs || xs.some((x) => typeof x !== "string" && typeof x !== "number")) return { ok: false, error: "Liste" };
      return { ok: true, value: xs.map((x) => String(x).trim()).filter(Boolean) };
    }
    default:
      if (typeof raw === "string") return { ok: true, value: q.kind === "password" ? raw : raw.trim() };
      if (typeof raw === "number" && q.kind === "text") return { ok: true, value: String(raw) };
      return { ok: false, error: "Text" };
  }
}

/** Eine (nicht leere) Antwort prüfen – `answers` enthält die früheren Antworten. Fehlertext oder null. */
export function checkValue(q: Question, v: Value, answers: Answers, ctx: InstallContext): string | null {
  const options = q.kind === "select" ? q.options?.(answers, ctx) : undefined;
  if (options && !options.some((o) => o.value === v)) return `Erlaubt: ${options.map((o) => o.value).join(", ")}`;
  if (typeof v === "string" && !q.notInEnv && !envSafe(v)) return "Apostroph zusammen mit $, \" oder \\ wird hier nicht unterstützt";
  return q.validate?.(v, answers, ctx) ?? null;
}

/**
 * Antworten der Reihe nach durchgehen (spätere Fragen hängen von früheren ab): Vorgaben einsetzen, prüfen, Fehlendes
 * sammeln. Angaben zu Fragen, die für Rolle/Instanztyp nicht gelten, fallen weg.
 */
export function resolve(input: Answers, ctx: InstallContext = {}): Resolved {
  const answers: Answers = {};
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const missing: string[] = [];
  for (const key of Object.keys(input)) if (!QUESTION_BY_ID.has(key)) errors.push({ id: key, message: "Unbekannte Angabe" });
  for (const q of QUESTIONS) {
    if (!applies(q, answers, ctx)) continue;
    let v: Value | undefined = input[q.id];
    if (isEmpty(v)) v = q.default?.(answers, ctx);
    if (isEmpty(v)) {
      if (!q.optional) missing.push(q.id);
      continue;
    }
    const problem = checkValue(q, v!, answers, ctx);
    if (problem) {
      errors.push({ id: q.id, message: problem });
      continue;
    }
    answers[q.id] = v!;
    const hint = q.warn?.(v!, answers, ctx);
    if (hint) warnings.push({ id: q.id, message: hint });
  }
  return { answers, errors, warnings, missing, complete: errors.length === 0 && missing.length === 0 };
}

function flatten(obj: unknown, prefix: string, out: Record<string, unknown>, errors: Issue[]): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj !== "object" || Array.isArray(obj)) {
    out[prefix] = obj;
    return;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const id = prefix ? `${prefix}.${k}` : k;
    // verschachteln nur, wo es keine Frage mit genau diesem Namen gibt
    if (v !== null && typeof v === "object" && !Array.isArray(v) && !QUESTION_BY_ID.has(id)) flatten(v, id, out, errors);
    else if (QUESTION_BY_ID.has(id)) out[id] = v;
    else errors.push({ id, message: "Unbekannte Angabe" });
  }
}

/** schulos-install.yaml lesen: Werte in den Typ der jeweiligen Frage bringen; prüfen erst resolve(). */
export function readInstallYaml(text: string): { answers: Answers; errors: Issue[] } {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return { answers: {}, errors: [{ id: "", message: `Keine gültige YAML-Datei: ${(e as Error).message.split("\n")[0]}` }] };
  }
  if (doc === null || doc === undefined) return { answers: {}, errors: [] };
  if (typeof doc !== "object" || Array.isArray(doc)) return { answers: {}, errors: [{ id: "", message: "Erwartet werden Angaben wie „role: main“" }] };
  const flat: Record<string, unknown> = {};
  const errors: Issue[] = [];
  flatten(doc, "", flat, errors);
  const answers: Answers = {};
  for (const [id, raw] of Object.entries(flat)) {
    if (raw === null || raw === undefined) continue;
    const r = coerce(QUESTION_BY_ID.get(id)!, raw);
    if (r.ok) answers[id] = r.value;
    else errors.push({ id, message: r.error });
  }
  return { answers, errors };
}

/**
 * Antworten als schulos-install.yaml **ohne Passwörter, Schlüssel und Kopplungscode** (§2: „bietet die Antworten am Ende
 * als Datei an“). Damit lässt sich die nächste Schule gleich aufsetzen; der Installer fragt die Geheimnisse dann nach.
 */
export function writeInstallYaml(answers: Answers, header = "SchulOS – Antworten des Installers (ohne Passwörter)"): string {
  const nested: Record<string, unknown> = {};
  for (const q of QUESTIONS) {
    const v = answers[q.id];
    if (q.secret || v === undefined) continue;
    const parts = q.id.split(".");
    let node = nested;
    for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Record<string, unknown>;
    node[parts[parts.length - 1]!] = v;
  }
  const doc = new Document(nested);
  doc.commentBefore = ` ${header}\n Fehlende Angaben (Passwörter, Kopplungscode) fragt der Installer beim Start nach.`;
  return doc.toString({ lineWidth: 0 });
}
