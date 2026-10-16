// Installationsphase in der Text-Oberfläche (INST-02): Fortschrittsbalken über die Systemschritte, aktueller Schritt,
// verstrichene Zeit, dezent die letzten Protokollzeilen; bei einem Fehler ein klarer Abbruch-Bildschirm mit Protokoll/Alt+F2.
// Nur interaktiv – unbeaufsichtigt (CI, seriell) und --abbild schreiben weiter Zeilen (main.tsx).
import { Box, Text } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import { keys, metrics, Screen, useUi } from "./layout";
import type { ProgressStore } from "./progress";
import type { SectionState } from "./sections";
import { bar, elapsed } from "./theme";

export interface InstallViewProps {
  store: ProgressStore;
  /** Pfad des Protokolls (Anzeige) */
  log: string;
  /** letzte Zeilen des Protokolls */
  readLog(n: number): string[];
  steps: { title: string; state: SectionState }[] | null;
  now?: () => number;
  /** Takt für Uhr und Protokoll (ms) */
  interval?: number;
}

export function InstallView(props: InstallViewProps) {
  const ui = useUi();
  const { c, g } = ui.theme;
  const s = useSyncExternalStore(props.store.subscribe, props.store.get);
  const now = props.now ?? Date.now;
  const [time, setTime] = useState(now());
  const m = metrics(ui, { sidebar: !!props.steps, heightOffset: s.error ? 3 : 0 });
  const logRows = Math.max(0, Math.min(8, m.body - (s.error ? 10 : 8)));
  const [lines, setLines] = useState<string[]>(() => props.readLog(logRows));
  const { readLog, interval = 1000 } = props;
  useEffect(() => {
    if (s.error) return;
    const t = setInterval(() => {
      setTime(now());
      setLines(readLog(logRows));
    }, interval);
    return () => clearInterval(t);
  }, [s.error, s.index, readLog, logRows, interval, now]);

  const done = Math.max(0, s.index); // abgeschlossene Schritte: alle vor dem laufenden
  const pct = s.total ? Math.floor((done / s.total) * 100) : 0;
  const width = Math.max(10, m.content - 6);
  const stepNo = s.index >= 0 ? `Schritt ${s.index + 1} von ${s.total}` : "Vorbereitung";
  const log = (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor wrap="truncate-middle">
        Protokoll {g.sep} {props.log}
      </Text>
      {/* nach einem Fehler steht die Uhr; dann das Protokoll so, wie es beim Abbruch war */}
      {(s.error ? readLog(logRows) : lines).map((l, i) => (
        <Text key={i} dimColor wrap="truncate-end">
          {"  "}
          {l}
        </Text>
      ))}
    </Box>
  );

  if (s.error)
    return (
      <Screen status="Abgebrochen" steps={props.steps} heightOffset={3} keys={keys(ui, "Installer endet", "danach Enter = neu starten")}>
        <Text color={c.danger} bold>
          {g.fail} Installation abgebrochen
        </Text>
        <Text>
          {stepNo}: <Text bold>{s.title}</Text>
        </Text>
        <Text color={c.danger}>{s.error.message}</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text>Die Zielplatte ist nur teilweise eingerichtet – ein neuer Lauf beginnt von vorn.</Text>
          <Text>
            Ursache im Protokoll: <Text bold>{props.log}</Text>
          </Text>
          <Text>
            Konsole mit <Text bold>Alt+F2</Text>, zurück mit <Text bold>Alt+F1</Text>.
          </Text>
        </Box>
        {log}
      </Screen>
    );

  return (
    <Screen status="Installation" steps={props.steps} keys={keys(ui, "bitte warten", "nicht ausschalten")}>
      <Text bold color={c.accent}>
        Installation läuft
      </Text>
      <Text dimColor>Bitte nicht ausschalten und das Startmedium eingelegt lassen.</Text>
      <Box marginTop={1} justifyContent="space-between" width={width + 6}>
        <Text>{stepNo}</Text>
        <Text dimColor>{elapsed(time - s.startedAt)}</Text>
      </Box>
      <Text>
        <Text color={c.accent}>{bar(g, done, s.total, width)}</Text> {String(pct).padStart(3)} %
      </Text>
      <Text bold wrap="truncate-end">
        {s.index >= 0 ? `${g.current} ${s.title}` : " "}
      </Text>
      {log}
    </Screen>
  );
}
