// Alle Suchanbieter für die globale Suche (Strg+K). Neue Module tragen sich hier ein.
import type { SearchProvider } from "@/core/search";
import { adressbuchSearch } from "./adressbuch/search";
import { aufgabenSearch } from "./aufgaben/search";
import { buechereiSearch } from "./buecherei/search";
import { forenSearch } from "./foren/search";
import { gebaeudeSearch } from "./gebaeude/search";
import { hilfeSearch } from "./hilfe/search";
import { kalenderSearch } from "./kalender/search";
import { kurseSearch } from "./kurse/search";
import { newsSearch } from "./news/search";
import { notenbuchSearch } from "./notenbuch/search";
import { sitzplanSearch } from "./sitzplan/search";
import { sprechtagSearch } from "./sprechtag/search";
import { raeumeSearch } from "./verwaltung/search";

export const SEARCH_PROVIDERS: readonly SearchProvider[] = [
  adressbuchSearch,
  kurseSearch,
  aufgabenSearch,
  kalenderSearch,
  newsSearch,
  forenSearch,
  gebaeudeSearch,
  sprechtagSearch,
  sitzplanSearch,
  notenbuchSearch,
  buechereiSearch,
  raeumeSearch,
  hilfeSearch,
];
