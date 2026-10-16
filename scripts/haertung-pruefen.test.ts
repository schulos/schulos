// G4E-O14: scripts/haertung-pruefen.sh echt in bash, `docker` als Attrappe (Antworten je Container aus Dateien) – am laufenden
// Stack prüft die CI (Jobs „stack“, „backup“).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "haertung-pruefen.sh");
const bash = spawnSync("bash", ["-c", "declare -A x=(); echo ok"]).stdout?.toString().trim() === "ok";

// Attrappe: `docker ps -q …` → c1; `docker inspect -f <format> c1` → Wert aus $D/<feld>; `docker exec c1 id -u` → $D/uid
const DOCKER = `#!/bin/bash
D=\${FAKE:?}
case "$1" in
  ps) echo c1 ;;
  exec) cat "$D/uid" ;;
  inspect)
    f=$3
    case "$f" in
      *com.docker.compose.service*) echo app ;;
      *'.Config.User'*) cat "$D/user" ;;
      *ReadonlyRootfs*) echo true ;;
      *CapDrop*) echo ALL ;;
      *CapAdd*) echo "" ;;
      *SecurityOpt*) cat "$D/sec" ;;
      *Mounts*) echo "/var/lib/docker/volumes/x" ;;
      *Privileged*) cat "$D/priv" ;;
      *PidMode*) cat "$D/pid" ;;
      *IpcMode*|*NetworkMode*|*UTSMode*|*UsernsMode*) echo "" ;;
      *Devices*) cat "$D/devs" ;;
      *) echo "?" ;;
    esac ;;
esac
`;

describe.skipIf(!bash)("G4E-O14: haertung-pruefen.sh", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  function run(o: Partial<Record<"user" | "uid" | "sec" | "priv" | "pid" | "devs", string>> = {}) {
    dir = mkdtempSync(path.join(tmpdir(), "schulos-haertung-"));
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(path.join(dir, "bin", "docker"), DOCKER);
    const v = { user: "node", uid: "1000", sec: "no-new-privileges:true", priv: "false", pid: "", devs: "0", ...o };
    for (const [k, val] of Object.entries(v)) writeFileSync(path.join(dir, k), `${val}\n`);
    const r = spawnSync(
      "bash",
      ["-c", 'u() { cygpath -u "$1" 2>/dev/null || echo "$1"; }; D=$(u "$D"); S=$(u "$S"); chmod +x "$D/bin/docker"; PATH="$D/bin:$PATH" FAKE="$D" bash "$S" schulos'],
      { encoding: "utf8", env: { ...process.env, D: dir, S: SCRIPT } },
    );
    return { code: r.status, out: r.stdout + r.stderr };
  }

  it("gehärteter Dienst besteht", () => {
    const r = run();
    expect(r.out).toContain("SEC-13 ✓ app");
    expect(r.code).toBe(0);
  });

  it("no-new-privileges:false, privileged, Host-PID, Geräte → Fehler", () => {
    expect(run({ sec: "no-new-privileges:false" })).toMatchObject({ code: 1, out: expect.stringContaining("no-new-privileges fehlt") });
    expect(run({ priv: "true" })).toMatchObject({ code: 1, out: expect.stringContaining("privileged") });
    expect(run({ pid: "host" })).toMatchObject({ code: 1, out: expect.stringContaining("PidMode=host") });
    expect(run({ devs: "1" })).toMatchObject({ code: 1, out: expect.stringContaining("Geräte eingebunden") });
    expect(run({ uid: "0", user: "" })).toMatchObject({ code: 1, out: expect.stringContaining("läuft als root") });
  });
});
