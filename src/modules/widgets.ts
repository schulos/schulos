// Alle Startseiten-Widgets. Neue Module tragen ihre Widgets hier ein.
// Getrennt von src/modules/index.ts, damit Manifeste frei von React-Komponenten bleiben.
import type { WidgetDef } from "@/core/widgets";
import { anmeldungWidgets } from "./anmeldung/widgets";
import { aufgabenWidgets } from "./aufgaben/widgets";
import { gebaeudeWidgets } from "./gebaeude/widgets";
import { heuteWidgets } from "./heute/widgets";
import { kalenderWidgets } from "./kalender/widgets";
import { klassenbuchWidgets } from "./klassenbuch/widgets";
import { kurseWidgets } from "./kurse/widgets";
import { newsWidgets } from "./news/widgets";
import { notenbuchWidgets } from "./notenbuch/widgets";
import { sprechtagWidgets } from "./sprechtag/widgets";
import { stundenplanWidgets } from "./stundenplan/widgets";
import { verwaltungWidgets } from "./verwaltung/widgets";

export const WIDGETS: readonly WidgetDef[] = [
  ...stundenplanWidgets,
  ...heuteWidgets,
  ...aufgabenWidgets,
  ...klassenbuchWidgets,
  ...kurseWidgets,
  ...kalenderWidgets,
  ...newsWidgets,
  ...gebaeudeWidgets,
  ...sprechtagWidgets,
  ...notenbuchWidgets,
  ...anmeldungWidgets,
  ...verwaltungWidgets,
];
