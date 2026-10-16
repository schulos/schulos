// Startet den gebauten Server (`next start`), ruft Pfade ab und beendet ihn wieder.
// Aufruf: node scripts/probe.mjs api/health login
// (Pfade ohne führenden Slash angeben – Git Bash schreibt "/x" sonst in Windows-Pfade um.)
import { spawn } from "node:child_process";

const port = process.env.PROBE_PORT ?? "3123";
const paths = process.argv.slice(2).map((p) => "/" + p.replace(/^\/+/, ""));
if (paths.length === 0) paths.push("/api/health");

// Läuft schon etwas auf dem Port (z. B. verwaister Server), würden wir den alten Build testen.
try {
  await fetch(`http://localhost:${port}/`, { redirect: "manual" });
  console.error(`Port ${port} ist schon belegt – alten Server beenden oder PROBE_PORT setzen.`);
  process.exit(2);
} catch {
  // frei – gut
}

const server = spawn(`npx next start -p ${port}`, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://localhost:${port}/`, { redirect: "manual" });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

function kill() {
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill("SIGTERM");
}

let failed = false;
try {
  if (!(await waitUp())) {
    console.error("Server kam nicht hoch:\n" + log);
    failed = true;
  } else {
    for (const p of paths) {
      const res = await fetch(`http://localhost:${port}${p}`, { redirect: "manual" });
      const body = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
      console.log(`${res.status} ${p} ${res.headers.get("location") ?? ""} ${body}`);
      if (res.status >= 500) failed = true;
    }
    if (failed) console.error("--- Server-Log ---\n" + log.slice(-3000));
  }
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  kill();
}
process.exitCode = failed ? 1 : 0;
