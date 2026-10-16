// Unit-/Integrationstests gegen echtes PostgreSQL 18 (B-14).
// Ohne TEST_DATABASE_URL startet ein lokaler Docker-Container `schulos-pg-test` (Port 55432, bleibt laufen;
// entfernen: docker rm -f schulos-pg-test). In der CI kommt TEST_DATABASE_URL vom Service-Container.
// Aufruf: npm run test:pg [-- <vitest-Argumente>]
import { spawnSync } from "node:child_process";

const CONTAINER = "schulos-pg-test";
const sh = (cmd, opts = {}) => spawnSync(cmd, { shell: true, encoding: "utf8", ...opts });

let url = process.env.TEST_DATABASE_URL;
if (!url) {
  url = "postgres://postgres:schulos@127.0.0.1:55432/postgres";
  const state = sh(`docker inspect -f "{{.State.Running}}" ${CONTAINER}`);
  if (state.status !== 0) {
    console.log(`[test:pg] starte ${CONTAINER} (postgres:18)`);
    const r = sh(
      `docker run -d --name ${CONTAINER} -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=schulos ` +
        `--tmpfs /var/lib/postgresql postgres:18 -c max_connections=300 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
      { stdio: "inherit" },
    );
    if (r.status !== 0) process.exit(r.status ?? 1);
  } else if (state.stdout.trim() !== "true") {
    sh(`docker start ${CONTAINER}`, { stdio: "inherit" });
  }
  for (let i = 0; ; i++) {
    if (sh(`docker exec ${CONTAINER} pg_isready -U postgres -h 127.0.0.1`).status === 0) break;
    if (i > 60) {
      console.error("[test:pg] PostgreSQL wird nicht bereit");
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const args = process.argv.slice(2).map((a) => JSON.stringify(a)).join(" ");
const r = spawnSync(`npx vitest run ${args}`, { shell: true, stdio: "inherit", env: { ...process.env, TEST_DATABASE_URL: url } });
process.exit(r.status ?? 1);
