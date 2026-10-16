// Bündelt den Agenten samt @schulos/server zu einer Datei (dist/agent.mjs) – das Image braucht dann kein node_modules.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

// Release-Builds setzen SCHULOS_VERSION (Tag), sonst die Version aus package.json
const version =
  process.env.SCHULOS_VERSION || JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
await build({
  entryPoints: [new URL("./src/main.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
  outfile: new URL("./dist/agent.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  define: { AGENT_VERSION: JSON.stringify(version) },
  banner: { js: "// SchulOS Backup-Agent – gebündelt mit esbuild aus apps/agent" },
  logLevel: "info",
});
