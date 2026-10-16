// Bündelt den Installer samt Ink/React zu einer Datei (dist/schulos-installer.mjs) – läuft im Live-System direkt mit Node 24.
import { build } from "esbuild";

// Ink lädt die React-Devtools nur mit DEV=true – im Bündel ein leerer Ersatz statt einer fehlenden Abhängigkeit
const noDevtools = {
  name: "no-devtools",
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default { initialize() {}, connectToDevTools() {} };" }));
  },
};

const file = (p) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
await build({
  entryPoints: [file("./src/main.tsx")],
  outfile: file("./dist/schulos-installer.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  jsx: "automatic",
  plugins: [noDevtools],
  define: { "process.env.NODE_ENV": '"production"' },
  // CommonJS-Teile (React) brauchen require im ESM-Bündel
  banner: {
    js: "#!/usr/bin/env node\n// SchulOS-Installer – gebündelt mit esbuild aus apps/installer\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});
