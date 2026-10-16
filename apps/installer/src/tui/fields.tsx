// Eingabefelder der Text-Oberfläche: Text/Passwort, Auswahl, Mehrfachauswahl (Platten). Nur Anzeige und Tasten – geprüft wird in flow.ts.
// Lange Listen (Bundesländer) zeigen einen Ausschnitt um die Auswahl (maxVisible), damit alles in 80×25 passt.
import { Box, Text, useInput } from "ink";
import { useState, type ReactNode } from "react";
import type { Option } from "../questions";
import { useUi } from "./layout";
import { windowAround } from "./sections";

export function TextField(props: { initial: string; mask?: boolean; onSubmit(v: string): void; onBack(): void }) {
  const { g, c } = useUi().theme;
  const [value, setValue] = useState(props.initial);
  useInput((input, key) => {
    if (key.return) return props.onSubmit(value);
    if (key.escape) return props.onBack();
    if (key.backspace || key.delete) return setValue((v) => v.slice(0, -1));
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
    // eingefügter Text kommt in einem Stück; Zeilenumbrüche daraus nicht übernehmen
    if (input) setValue((v) => v + input.replace(/[\r\n]+/g, ""));
  });
  return (
    <Text>
      <Text color={c.accent}>{g.cursor} </Text>
      {props.mask ? g.mask.repeat(value.length) : value}
      <Text inverse> </Text>
    </Text>
  );
}

/** Zeilen einer Liste mit Ausschnitt und Hinweis auf weitere Einträge */
function Rows(props: { count: number; index: number; maxVisible?: number; row(i: number): ReactNode }) {
  const { g } = useUi().theme;
  const { start, end } = windowAround(props.count, props.index, props.maxVisible ?? props.count);
  const rows = [];
  for (let i = start; i < end; i++) rows.push(props.row(i));
  return (
    <Box flexDirection="column">
      {start > 0 ? <Text dimColor>  {g.more.up} {start} weitere</Text> : null}
      {rows}
      {end < props.count ? <Text dimColor>  {g.more.down} {props.count - end} weitere</Text> : null}
    </Box>
  );
}

export function SelectField(props: { options: Option[]; initial?: string; maxVisible?: number; onSubmit(v: string): void; onBack(): void }) {
  const { g, c } = useUi().theme;
  const start = Math.max(0, props.options.findIndex((o) => o.value === props.initial));
  const [index, setIndex] = useState(start);
  useInput((_input, key) => {
    if (key.return) return props.onSubmit(props.options[index]!.value);
    if (key.escape) return props.onBack();
    if (key.upArrow) setIndex((i) => (i + props.options.length - 1) % props.options.length);
    if (key.downArrow) setIndex((i) => (i + 1) % props.options.length);
  });
  // Ausschnitt: Hinweiszeilen „weitere“ zählen mit
  const max = props.maxVisible && props.options.length > props.maxVisible ? Math.max(1, props.maxVisible - 2) : undefined;
  return (
    <Rows
      count={props.options.length}
      index={index}
      maxVisible={max}
      row={(i) => (
        <Text key={props.options[i]!.value} color={i === index ? c.accent : undefined} bold={i === index}>
          {i === index ? `${g.cursor} ` : "  "}
          {props.options[i]!.label}
        </Text>
      )}
    />
  );
}

export function MultiSelectField(props: { options: Option[]; initial: string[]; maxVisible?: number; onSubmit(v: string[]): void; onBack(): void }) {
  const { g, c } = useUi().theme;
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState(new Set(props.initial));
  useInput((input, key) => {
    if (key.return) return props.onSubmit(props.options.map((o) => o.value).filter((v) => chosen.has(v)));
    if (key.escape) return props.onBack();
    if (key.upArrow) setIndex((i) => (i + props.options.length - 1) % props.options.length);
    if (key.downArrow) setIndex((i) => (i + 1) % props.options.length);
    if (input === " ") {
      const v = props.options[index]!.value;
      setChosen((c) => {
        const n = new Set(c);
        if (n.has(v)) n.delete(v);
        else n.add(v);
        return n;
      });
    }
  });
  const max = props.maxVisible && props.options.length > props.maxVisible ? Math.max(1, props.maxVisible - 2) : undefined;
  return (
    <Rows
      count={props.options.length}
      index={index}
      maxVisible={max}
      row={(i) => {
        const o = props.options[i]!;
        return (
          <Text key={o.value} color={i === index ? c.accent : undefined} bold={i === index}>
            {i === index ? `${g.cursor} ` : "  "}
            <Text color={chosen.has(o.value) ? c.ok : undefined}>[{chosen.has(o.value) ? "x" : " "}]</Text> {o.label}
          </Text>
        );
      }}
    />
  );
}
