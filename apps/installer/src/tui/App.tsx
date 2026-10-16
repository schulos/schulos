// Text-Oberfläche des Installers (INSTALLATION.md §1–§3, B-41): alle Fragen vorab, Plattenwahl, Erreichbarkeit des
// Backupservers samt Kopplungscode, Zusammenfassung. Am Ende gehen die Antworten an onFinish – installiert wird in B-42.
// Aussehen (INST-02): Rahmen mit Logo und Version, Schrittleiste der Abschnitte links, Tasten in der Fußzeile (layout.tsx).
import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DISCLAIMER_LINES, DISCLAIMER_TITLE, DISCLAIMER_WORD, disclaimerConfirmed } from "@schulos/server/disclaimer";
import { resolve } from "../answers";
import { backupCheckFor, nextStep, question, submitAnswer, visibleSteps, type Mode, type Step } from "../flow";
import { summarize } from "../generate";
import type { Answers, InstallContext, Option, Value } from "../questions";
import { MultiSelectField, SelectField, TextField } from "./fields";
import { keys, metrics, Screen, UiContext, useUi, type Size, type Ui } from "./layout";
import { sectionOf, sections, windowAround, type Position } from "./sections";
import { detectCharset, themeFor, type Charset } from "./theme";

export interface AppProps {
  initial: Answers;
  ctx: InstallContext;
  mode: Mode;
  /** Vorab-Prüfung (checkBackupServer) – wirft mit verständlicher Meldung */
  checkBackup(url: string, code: string): Promise<{ serverName: string }>;
  onFinish(answers: Answers): void;
  onAbort(): void;
  /** Version vom Medium (VERSION), sonst „dev“ */
  version?: string;
  /** Zeichensatz; Vorgabe aus TERM/LANG (theme.ts) */
  charset?: Charset;
  /** feste Größe (Tests); sonst die des Terminals */
  size?: Size;
  /** REPO-03: Vorschau-/Haftungshinweis schon bestätigt (nur Tests) – sonst kommt er vor allen Fragen und der Plattenauswahl */
  disclaimerAccepted?: boolean;
}

type Phase =
  | { kind: "disclaimer"; error: string | null; attempt: number }
  | { kind: "question"; step: Step; error: string | null; first?: string }
  | { kind: "checking"; url: string; code: string; key: string }
  | { kind: "check-failed"; message: string }
  | { kind: "summary" };

const BOOL: Option[] = [
  { value: "ja", label: "ja" },
  { value: "nein", label: "nein" },
];

/** Nach den Fragen: Backupserver prüfen (einmal je Adresse + Code), sonst gleich die Zusammenfassung. */
function afterQuestions(a: Answers, ctx: InstallContext, verifiedKey: string | null): Phase {
  const check = backupCheckFor(a, ctx);
  if (!check) return { kind: "summary" };
  const key = `${check.url} ${check.code}`;
  return key === verifiedKey ? { kind: "summary" } : { kind: "checking", ...check, key };
}

function display(v: Value | undefined): string {
  if (v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

/** Oberfläche mit Zeichensatz, Größe und Version für alle Ansichten (auch InstallView in main.tsx) */
export function UiProvider(props: { charset?: Charset; size?: Size; version?: string; children: ReactNode }) {
  const win = useWindowSize();
  const size = props.size ?? win;
  const charset = props.charset ?? detectCharset(process.env);
  const ui = useMemo<Ui>(() => ({ theme: themeFor(charset), size, version: props.version ?? "dev" }), [charset, size.columns, size.rows, props.version]); // eslint-disable-line react-hooks/exhaustive-deps
  return <UiContext.Provider value={ui}>{props.children}</UiContext.Provider>;
}

export function App(props: AppProps) {
  return (
    <UiProvider charset={props.charset} size={props.size} version={props.version}>
      <Installer {...props} />
    </UiProvider>
  );
}

function Installer(props: AppProps) {
  const { ctx } = props;
  const ui = useUi();
  const [answers, setAnswers] = useState<Answers>(props.initial);
  const [mode, setMode] = useState<Mode>(props.mode);
  const [history, setHistory] = useState<string[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [verified, setVerified] = useState<{ key: string; serverName: string } | null>(null);
  const start = (): Phase => {
    const first = nextStep(props.initial, ctx, props.mode, null);
    return first ? { kind: "question", step: first, error: null } : afterQuestions(props.initial, ctx, null);
  };
  const [phase, setPhase] = useState<Phase>(() => (props.disclaimerAccepted ? start() : { kind: "disclaimer", error: null, attempt: 0 }));

  const { checkBackup } = props;
  useEffect(() => {
    if (phase.kind !== "checking") return;
    let cancelled = false;
    checkBackup(phase.url, phase.code).then(
      (r) => !cancelled && (setVerified({ key: phase.key, serverName: r.serverName }), setPhase({ kind: "summary" })),
      (e: unknown) => !cancelled && setPhase({ kind: "check-failed", message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [phase, checkBackup]);

  const ask = (id: string, a: Answers) => {
    const step = visibleSteps(a, ctx).find((s) => s.question.id === id);
    if (step) setPhase({ kind: "question", step, error: null });
  };

  const advance = (a: Answers, fromId: string | null, m: Mode) => {
    const next = nextStep(a, ctx, m, fromId);
    setPhase(next ? { kind: "question", step: next, error: null } : afterQuestions(a, ctx, verified?.key ?? null));
  };

  const submit = (raw: Value) => {
    if (phase.kind !== "question") return;
    const q = phase.step.question;
    // Passwörter zweimal eingeben; leer = bisheriges behalten
    if (q.kind === "password") {
      const s = raw as string;
      if (s === "" && typeof answers[q.id] === "string") raw = answers[q.id]!;
      else if (phase.first === undefined) {
        const pre = submitAnswer(q, s, answers, ctx);
        if (!pre.ok) return setPhase({ ...phase, error: pre.error });
        return setPhase({ ...phase, first: s, error: null });
      } else if (phase.first !== s) return setPhase({ ...phase, first: undefined, error: "Die Wiederholung stimmt nicht überein – bitte noch einmal." });
    }
    const r = submitAnswer(q, raw, answers, ctx);
    if (!r.ok) return setPhase({ ...phase, first: undefined, error: r.error });
    setAnswers(r.answers);
    setWarning(r.warning);
    setHistory((h) => [...h, q.id]);
    advance(r.answers, q.id, mode);
  };

  const back = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1]!;
    setHistory((h) => h.slice(0, -1));
    setWarning(null);
    ask(prev, answers);
  };

  const steps = (at: Position) => sections(answers, ctx, at);
  const { c, g } = ui.theme;

  if (phase.kind === "disclaimer")
    return (
      <Screen status="Vorschau-Hinweis" steps={steps({ questionId: "locale.language" })} keys={keys(ui, `${DISCLAIMER_WORD} + Enter weiter`, "Esc beenden")}>
        <Text bold color={c.warn}>
          {DISCLAIMER_TITLE}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {DISCLAIMER_LINES.map((l) => (
            <Text key={l}>
              - {l}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Weiter nur mit „{DISCLAIMER_WORD}“ – vorher wird nichts gefragt und keine Platte angefasst.</Text>
        </Box>
        <Box marginTop={1}>
          <TextField
            key={phase.attempt}
            initial=""
            onSubmit={(v) => (disclaimerConfirmed(v) ? setPhase(start()) : setPhase({ kind: "disclaimer", error: `Bitte „${DISCLAIMER_WORD}“ eintippen.`, attempt: phase.attempt + 1 }))}
            onBack={props.onAbort}
          />
        </Box>
        {phase.error ? (
          <Text color={c.danger}>
            {g.fail} {phase.error}
          </Text>
        ) : null}
      </Screen>
    );

  if (phase.kind === "question")
    return (
      <QuestionView {...{ phase, answers, ctx, warning, submit, back }} progress={progress(answers, ctx, phase.step.question.id)} steps={steps({ questionId: phase.step.question.id })} />
    );
  if (phase.kind === "checking")
    return (
      <Screen status="Backupserver" steps={steps({ questionId: "backup.url" })} keys="bitte warten">
        <Text bold>Prüfe den Backupserver …</Text>
        <Text dimColor>{phase.url}</Text>
      </Screen>
    );
  if (phase.kind === "check-failed")
    return (
      <Screen status="Backupserver" steps={steps({ questionId: "backup.url" })} keys={keys(ui, `${g.arrows} wählen`, "Enter weiter", "Esc zurück")}>
        <Text color={c.danger} bold>
          {g.fail} Backupserver: {phase.message}
        </Text>
        {/* Wiederherstellen geht nur mit gültigem Ersatz-Code – „später“ hieße: Platte löschen, dann scheitert der Erststart */}
        {answers.instance === "restore-backup" ? <Text dimColor>Wiederherstellen braucht einen gültigen Ersatz-Kopplungscode – ohne ihn wird nicht installiert.</Text> : null}
        <Box marginTop={1}>
          <SelectField
            options={[
              { value: "edit", label: "Adresse oder Kopplungscode ändern" },
              { value: "retry", label: "erneut prüfen" },
              ...(answers.instance === "restore-backup" ? [] : [{ value: "later", label: "später koppeln" }]),
            ]}
            onBack={() => ask("backup.url", answers)}
            onSubmit={(v) => {
              if (v === "retry") return setPhase(afterQuestions(answers, ctx, null));
              if (v === "later") {
                const a = { ...answers, "backup.mode": "later" };
                setAnswers(a);
                return setPhase({ kind: "summary" });
              }
              setMode("fehlende");
              ask("backup.url", answers);
            }}
          />
        </Box>
      </Screen>
    );
  return (
    <Summary
      answers={answers}
      ctx={ctx}
      serverName={verified?.serverName ?? null}
      steps={steps("summary")}
      onEdit={(id) => {
        setMode("fehlende");
        setHistory([]);
        ask(id, answers);
      }}
      onInstall={() => props.onFinish(resolve(answers, ctx).answers)}
      onAbort={props.onAbort}
    />
  );
}

function progress(answers: Answers, ctx: InstallContext, id: string): string {
  const steps = visibleSteps(answers, ctx);
  return `${steps.findIndex((s) => s.question.id === id) + 1} von ${steps.length}`;
}

function QuestionView(props: {
  phase: Extract<Phase, { kind: "question" }>;
  answers: Answers;
  ctx: InstallContext;
  warning: string | null;
  progress: string;
  steps: ReturnType<typeof sections>;
  submit(v: Value): void;
  back(): void;
}) {
  const ui = useUi();
  const { c, g } = ui.theme;
  const { step, error, first } = props.phase;
  const q = step.question;
  const options = q.options?.(resolve(props.answers, props.ctx).answers, props.ctx) ?? [];
  const m = metrics(ui, { sidebar: true });
  // Platz für die Liste: Inhalt minus Bezeichnung, Hilfe, Abstand, Fehler, Hinweis
  const helpRows = q.help ? Math.ceil(q.help.length / Math.max(20, m.content)) : 0;
  const maxVisible = Math.max(3, m.body - 4 - helpRows - (props.warning ? 2 : 0));
  // key: Feld bei jeder neuen Frage (und für die Wiederholung) frisch anlegen
  const key = `${q.id}:${first === undefined ? 1 : 2}:${error ?? ""}`;
  let field: ReactNode;
  if (q.kind === "select") field = <SelectField key={key} options={options} initial={display(step.value)} maxVisible={maxVisible} onSubmit={props.submit} onBack={props.back} />;
  else if (q.kind === "bool")
    field = <SelectField key={key} options={BOOL} initial={step.value === true ? "ja" : "nein"} onSubmit={(v) => props.submit(v === "ja")} onBack={props.back} />;
  else if (q.kind === "disks" && options.length)
    field = <MultiSelectField key={key} options={options} initial={Array.isArray(step.value) ? step.value : []} maxVisible={maxVisible} onSubmit={props.submit} onBack={props.back} />;
  else
    field = (
      <TextField key={key} initial={q.kind === "password" ? "" : display(step.value)} mask={q.kind === "password"} onSubmit={props.submit} onBack={props.back} />
    );
  const list = q.kind === "select" || q.kind === "bool" || (q.kind === "disks" && options.length > 0);
  return (
    <Screen
      status={`Frage ${props.progress}`}
      steps={props.steps}
      keys={keys(ui, list && `${g.arrows} wählen`, q.kind === "disks" && "Leertaste markieren", "Enter weiter", "Esc zurück", q.optional && "leer = keine Angabe")}
    >
      {props.warning ? (
        <Text color={c.warn}>
          Hinweis: {props.warning}
        </Text>
      ) : null}
      <Text bold color={c.accent}>
        {first === undefined ? q.label : `${q.label} – bitte wiederholen`}
      </Text>
      {q.help ? <Text dimColor>{q.help}</Text> : null}
      {q.kind === "list" ? <Text dimColor>mehrere durch Komma getrennt</Text> : null}
      <Box marginTop={1}>{field}</Box>
      {error ? (
        <Text color={c.danger}>
          {g.fail} {error}
        </Text>
      ) : null}
    </Screen>
  );
}

/** Zeilen der Zusammenfassung: Abschnitt als Überschrift, darunter Bezeichnung und Wert */
type Row = { kind: "head"; title: string } | { kind: "line"; id: string; label: string; value: string; item: number };

function Summary(props: {
  answers: Answers;
  ctx: InstallContext;
  serverName: string | null;
  steps: ReturnType<typeof sections>;
  onEdit(id: string): void;
  onInstall(): void;
  onAbort(): void;
}) {
  const ui = useUi();
  const { c, g } = ui.theme;
  const lines = summarize(props.answers, props.ctx);
  const r = resolve(props.answers, props.ctx);
  const items = [...lines.map((l) => l.id), "!install", "!abort"];
  const [index, setIndex] = useState(items.indexOf("!install"));
  useInput((_input, key) => {
    if (key.upArrow) setIndex((i) => (i + items.length - 1) % items.length);
    if (key.downArrow) setIndex((i) => (i + 1) % items.length);
    if (!key.return) return;
    const item = items[index]!;
    if (item === "!install") return r.complete ? props.onInstall() : undefined;
    if (item === "!abort") return props.onAbort();
    props.onEdit(question(item).id);
  });

  const rows: Row[] = [];
  let section = "";
  lines.forEach((l, i) => {
    const s = sectionOf(l.id);
    if (s !== section) rows.push({ kind: "head", title: (section = s) });
    // Geheimnisse: summarize() maskiert mit •, im ASCII-Zeichensatz mit *
    rows.push({ kind: "line", id: l.id, label: l.label, value: question(l.id).secret ? g.mask.repeat(8) : l.value, item: i });
  });

  const disks = r.answers["disk.devices"];
  const notes: { text: string; color: string }[] = [
    ...(props.serverName ? [{ text: `${g.ok} Backupserver „${props.serverName}“ erreichbar, Kopplungscode gültig – gekoppelt wird nach der Installation.`, color: c.ok }] : []),
    ...r.warnings.map((w) => ({ text: `Hinweis: ${w.message}`, color: c.warn })),
    ...(r.complete ? [] : [{ text: `Unvollständig: ${[...r.missing, ...r.errors.map((e) => e.id)].join(", ")}`, color: c.danger }]),
    { text: `Achtung: ${Array.isArray(disks) ? disks.join(" und ") : "die Zielplatte"} wird vollständig gelöscht.`, color: c.danger },
  ];
  const m = metrics(ui, { sidebar: true });
  // Wortumbruch: lieber eine Zeile zu viel rechnen
  const noteRows = notes.reduce((n, x) => n + Math.ceil(x.text.length / Math.max(20, m.content - 8)), 0);
  // Überschrift 1, „weitere“-Zeilen 2, Abstand 1, Hinweise, Abstand 1, Knöpfe 1
  const tableRows = Math.max(3, m.body - 6 - noteRows);
  const selectedRow = rows.findIndex((x) => x.kind === "line" && x.item === index);
  const win = windowAround(rows.length, selectedRow < 0 ? 0 : selectedRow, tableRows);
  const labelWidth = Math.min(Math.max(...lines.map((l) => l.label.length)), Math.floor(m.content * 0.45));
  const sel = items[index];
  const button = (id: string, label: string) => (
    <Text color={sel === id ? c.accent : undefined} bold={sel === id} inverse={sel === id && ui.theme.charset !== "ascii"}>
      {sel === id ? `${g.cursor} ` : "  "}
      {label}
      {sel === id ? " " : "  "}
    </Text>
  );
  return (
    <Screen status="Zusammenfassung" steps={props.steps} keys={keys(ui, `${g.arrows} wählen`, "Enter: Zeile ändern bzw. Knopf")}>
      <Text bold color={c.accent}>
        Zusammenfassung <Text dimColor>– bitte prüfen</Text>
      </Text>
      <Box flexDirection="column">
        {win.start > 0 ? <Text dimColor>{g.more.up} {win.start} weitere Zeilen</Text> : null}
        {rows.slice(win.start, win.end).map((row) =>
          row.kind === "head" ? (
            <Text key={`h:${row.title}`} bold dimColor>
              {row.title}
            </Text>
          ) : (
            <Box key={row.id}>
              <Box width={labelWidth + 3} marginRight={2} flexShrink={0}>
                <Text color={row.item === index ? c.accent : undefined} bold={row.item === index} wrap="truncate-end">
                  {row.item === index ? ` ${g.cursor} ` : "   "}
                  {row.label}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text bold={row.item === index} wrap="truncate-end" inverse={row.item === index && ui.theme.charset !== "ascii"}>
                  {row.value}
                </Text>
              </Box>
            </Box>
          ),
        )}
        {win.end < rows.length ? <Text dimColor>{g.more.down} {rows.length - win.end} weitere Zeilen</Text> : null}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {notes.map((n) => (
          <Text key={n.text} color={n.color}>
            {n.text}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        {button("!install", "Installieren")}
        <Text> </Text>
        {button("!abort", "Abbrechen")}
      </Box>
    </Screen>
  );
}
