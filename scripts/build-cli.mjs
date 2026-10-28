// Bündelt src/cli.ts zu .next/cli.mjs (für das App-Image: /app/cli.mjs, Aufruf durch schulosctl, B-31).
// PGlite bleibt extern (liegt samt pglite.data in node_modules des Images); postgres-js wird mitgebündelt – Next
// bündelt es in seine Server-Chunks, im Standalone-node_modules fehlt es.
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: ".next/cli.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  tsconfig: "tsconfig.json",
  // sharp (natives Modul, RS-04 Raumfotos) lädt images-resize.ts erst bei Bedarf – die Kommandozeile verkleinert nie Bilder
  external: ["@electric-sql/pglite", "sharp"],
  // CommonJS-Abhängigkeiten im ESM-Bündel brauchen require
  banner: { js: "// SchulOS cli – gebündelt aus src/cli.ts\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
