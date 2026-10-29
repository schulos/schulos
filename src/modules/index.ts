// Registry aller Module. Ein neues Modul wird hier eingetragen – sonst nirgends.
import { validateManifests } from "@/core/modules/registry";
import type { ModuleManifest } from "@/core/modules/types";
import abwesenheiten from "./abwesenheiten/manifest";
import adressbuch from "./adressbuch/manifest";
import anmeldung from "./anmeldung/manifest";
import aufgaben from "./aufgaben/manifest";
import buchungen from "./buchungen/manifest";
import buecherei from "./buecherei/manifest";
import dateien from "./dateien/manifest";
import elternbriefe from "./elternbriefe/manifest";
import foren from "./foren/manifest";
import ganztag from "./ganztag/manifest";
import gebaeude from "./gebaeude/manifest";
import heute from "./heute/manifest";
import hilfe from "./hilfe/manifest";
import kalender from "./kalender/manifest";
import klassenbuch from "./klassenbuch/manifest";
import klausurplan from "./klausurplan/manifest";
import kurswahl from "./kurswahl/manifest";
import kurse from "./kurse/manifest";
import messenger from "./messenger/manifest";
import monitor from "./monitor/manifest";
import news from "./news/manifest";
import notenbuch from "./notenbuch/manifest";
import pinnwaende from "./pinnwaende/manifest";
import sitzplan from "./sitzplan/manifest";
import sprechtag from "./sprechtag/manifest";
import stundenplan from "./stundenplan/manifest";
import tafeln from "./tafeln/manifest";
import texte from "./texte/manifest";
import umfragen from "./umfragen/manifest";
import verwaltung from "./verwaltung/manifest";

export const MODULES: readonly ModuleManifest[] = [heute, messenger, news, elternbriefe, foren, umfragen, kurse, aufgaben, pinnwaende, texte, tafeln, stundenplan, klassenbuch, sitzplan, notenbuch, kurswahl, abwesenheiten, ganztag, buchungen, buecherei, gebaeude, klausurplan, sprechtag, kalender, dateien, adressbuch, hilfe, monitor, anmeldung, verwaltung];

validateManifests(MODULES);

export function getModule(id: string): ModuleManifest | undefined {
  return MODULES.find((m) => m.id === id);
}
