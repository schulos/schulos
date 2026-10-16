// Bündelt schulosctl samt @schulos/server zu einer Datei (dist/schulosctl.mjs) – läuft auf dem Host direkt mit Node 24.
// Der öffentliche Release-Schlüssel (release/cosign.pub) wird eingebacken: damit prüft `update` die Manifeste.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const file = (p) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
// Release-Builds setzen SCHULOS_VERSION (Tag), sonst die Version aus package.json
const version = process.env.SCHULOS_VERSION || JSON.parse(readFileSync(file("./package.json"), "utf8")).version;
await build({
  entryPoints: [file("./src/main.ts")],
  outfile: file("./dist/schulosctl.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  define: {
    CTL_VERSION: JSON.stringify(version),
    CTL_PUBKEY: JSON.stringify(readFileSync(file("../../release/cosign.pub"), "utf8")),
  },
  banner: { js: "#!/usr/bin/env node\n// schulosctl – gebündelt mit esbuild aus apps/ctl" },
  logLevel: "info",
});
