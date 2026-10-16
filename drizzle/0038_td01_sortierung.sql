-- TD-01: deutsche Sortierung für Namenslisten (DIN 5007-1: Ä wie A, Groß-/Kleinschreibung nachrangig, Zahlen natürlich).
-- ICU ist in PostgreSQL 18 und PGlite enthalten; PGlite kennt nur die Wurzel-Regeln (ohne natürliche Zahlen) – für deutsche
-- Namen gleich. Verwendung über `de()` aus src/core/db/sort.ts.
CREATE COLLATION IF NOT EXISTS "schulos_de" (provider = icu, locale = 'de-u-kn-true');
