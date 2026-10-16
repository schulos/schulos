// Bildschirmaufbau der Text-Oberfläche (INST-02): Rahmen, Kopf mit Logo und Version, Schrittleiste links, Inhalt rechts,
// Fußzeile mit Tasten. Passt in 80×25 und nutzt größere Terminals bis 120×40.
import { Box, Text } from "ink";
import { createContext, useContext, type ReactNode } from "react";
import { windowAround, type SectionState } from "./sections";
import { themeFor, type Theme } from "./theme";

export interface Size {
  columns: number;
  rows: number;
}

export interface Ui {
  theme: Theme;
  size: Size;
  version: string;
}

export const UiContext = createContext<Ui>({ theme: themeFor("unicode"), size: { columns: 80, rows: 25 }, version: "dev" });
export const useUi = () => useContext(UiContext);

const SIDEBAR = 22;

/** Maße des Rahmens: Breite/Höhe, Zeilen für den Inhalt, Breite des Inhalts, mit oder ohne Schrittleiste */
export function metrics(ui: Ui, opts: { sidebar: boolean; heightOffset?: number }) {
  const width = Math.max(40, Math.min(ui.size.columns, 120));
  const height = Math.max(16, Math.min(ui.size.rows, 40) - (opts.heightOffset ?? 0));
  const sidebar = opts.sidebar && width >= 70;
  // Rahmen 2, Kopf 2 (Logo bzw. Name + Untertitel), 2 Trennlinien, Fußzeile 1
  const body = height - 2 - 2 - 2 - 1;
  const content = width - 2 - (sidebar ? SIDEBAR : 0) - 2;
  return { width, height, sidebar, body, content };
}

function Rule() {
  const ui = useUi();
  const { width } = metrics(ui, { sidebar: false });
  return <Text dimColor>{ui.theme.g.hr.repeat(width - 2)}</Text>;
}

function Header(props: { status: string }) {
  const { theme, version } = useUi();
  const { g, c } = theme;
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Box flexDirection="column">
          {g.logo.map((l, i) => (
            <Text key={i} color={c.accent} bold>
              {l}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" marginLeft={2}>
          <Text bold>Installer</Text>
          <Text dimColor>Schulserver einrichten</Text>
        </Box>
      </Box>
      <Box flexDirection="column" alignItems="flex-end">
        <Text dimColor>Version {version}</Text>
        {props.status ? <Text color={c.accent}>{props.status}</Text> : null}
      </Box>
    </Box>
  );
}

export function StepBar(props: { steps: { title: string; state: SectionState }[]; height: number }) {
  const { g, c } = useUi().theme;
  const cur = Math.max(
    0,
    props.steps.findIndex((s) => s.state === "current"),
  );
  const { start, end } = windowAround(props.steps.length, cur, props.height);
  return (
    <Box flexDirection="column">
      {props.steps.slice(start, end).map((s, i) => {
        const mark = s.state === "done" ? g.done : s.state === "current" ? g.current : g.open;
        const more = (i === 0 && start > 0) || (i === end - start - 1 && end < props.steps.length);
        return (
          <Text key={s.title} wrap="truncate-end" color={s.state === "current" ? c.accent : undefined} bold={s.state === "current"} dimColor={s.state === "open"}>
            <Text color={s.state === "done" ? c.ok : undefined}>{more ? (i === 0 ? g.more.up : g.more.down) : mark}</Text> {s.title}
          </Text>
        );
      })}
    </Box>
  );
}

export function Screen(props: {
  status?: string;
  steps?: { title: string; state: SectionState }[] | null;
  keys: string;
  children: ReactNode;
  /** Zeilen unten frei lassen (Fehlerbild: start-installer.sh schreibt danach noch) */
  heightOffset?: number;
}) {
  const ui = useUi();
  const { g, c } = ui.theme;
  const m = metrics(ui, { sidebar: !!props.steps, heightOffset: props.heightOffset });
  return (
    <Box width={m.width} height={m.height} flexDirection="column" borderStyle={g.border} borderColor={c.accent}>
      <Header status={props.status ?? ""} />
      <Rule />
      <Box height={m.body} flexDirection="row" overflow="hidden">
        {m.sidebar && props.steps ? (
          <Box width={SIDEBAR} flexShrink={0} paddingX={1} borderStyle={g.border} borderTop={false} borderBottom={false} borderLeft={false} borderDimColor>
            <StepBar steps={props.steps} height={m.body} />
          </Box>
        ) : null}
        <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
          {/* natürliche Höhe; was nicht passt, schneidet der Rahmen ab (statt Zeilen zu stauchen) */}
          <Box flexDirection="column" flexShrink={0}>
            {props.children}
          </Box>
        </Box>
      </Box>
      <Rule />
      {/* immer genau eine Zeile: Hinweise kürzen statt umbrechen */}
      <Box paddingX={1} height={1}>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {props.keys}
          </Text>
        </Box>
        {ui.theme.charset === "konsole" ? (
          <Box flexShrink={0} marginLeft={2}>
            <Text dimColor>Alt+F2 Konsole</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

/** Tastenhinweise mit dem Trennzeichen des Zeichensatzes */
export function keys(ui: Ui, ...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(` ${ui.theme.g.sep} `);
}
