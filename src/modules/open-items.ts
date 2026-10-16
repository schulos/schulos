// Alle Lieferanten für das Heute-Widget „Offen für dich“ (Q5-07). Neue Module tragen sich hier ein.
import type { OpenItemsProvider } from "@/core/open-items";
import { abwesenheitenOpen } from "./abwesenheiten/open";
import { elternbriefeOpen } from "./elternbriefe/open";
import { stundenplanOpen } from "./stundenplan/open";
import { umfragenOpen } from "./umfragen/open";
import { verwaltungOpen } from "./verwaltung/open";

export const OPEN_ITEM_PROVIDERS: readonly OpenItemsProvider[] = [stundenplanOpen, abwesenheitenOpen, elternbriefeOpen, umfragenOpen, verwaltungOpen()];
