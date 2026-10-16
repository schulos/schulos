import { describe, expect, it } from "vitest";
import {
  ensureDbRole,
  parseRoleState,
  planRoleMigration,
  psqlSetLine,
  renameSql,
  revokeSql,
  REASSIGN_SQL,
  scramVerifier,
  SESSION_GUARD,
  type DbRoleDeps,
  type PsqlResult,
  type RoleRow,
} from "./db-role";

const row = (name: string, superuser: boolean, bootstrap = false): RoleRow => ({ name, superuser, bootstrap });
const LEGACY = "schulos|t|t\n";
const NEW = "postgres|t|t\nschulos|f|f\n";
const SEC07 = "schulos_sec07|t|f\n";

describe("SEC-07: Zustand der Datenbankrollen", () => {
  it("liest psql -tA-Ausgabe", () => {
    expect(parseRoleState("postgres|t|t\nschulos|f|f\n\n")).toEqual([row("postgres", true, true), row("schulos", false)]);
  });

  it("plant je Zustand", () => {
    expect(planRoleMigration([row("postgres", true, true), row("schulos", false)])).toEqual({ action: "fertig" });
    expect(planRoleMigration([row("schulos", true, true)])).toEqual({ action: "umbenennen" });
    expect(planRoleMigration([row("postgres", true, true), row("schulos", true)])).toEqual({ action: "entziehen" });
    expect(planRoleMigration([])).toMatchObject({ action: "fehler", reason: expect.stringContaining("fehlt") });
    // postgres gibt es schon neben der Bootstrap-Rolle schulos → nicht raten
    expect(planRoleMigration([row("postgres", true), row("schulos", true, true)])).toMatchObject({ action: "fehler" });
    expect(planRoleMigration([row("schulos", false)])).toMatchObject({ action: "fehler" });
    expect(planRoleMigration([row("postgres", false), row("schulos", true)])).toMatchObject({ action: "fehler" });
  });
});

describe("SEC-07: SQL", () => {
  it("Passwörter als psql-Variable mit maskierten Zeichen, nie im SQL-Text", () => {
    expect(psqlSetLine("pw", "a'b\\c")).toBe("\\set pw 'a''b\\\\c'");
    expect(() => psqlSetLine("pw", "a\nb")).toThrow(/Zeilenumbruch/);
    const sql = renameSql("SCRAM-SHA-256$4096:geheim");
    expect(sql.split("\n").filter((l) => l.includes("geheim"))).toEqual(["\\set admin_pw 'SCRAM-SHA-256$4096:geheim'"]);
    expect(sql).toContain("alter role schulos rename to postgres;");
    expect(sql).toContain("create role schulos login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'app_pw';");
    expect(sql).toContain("alter database schulos owner to schulos;");
    expect(sql.indexOf("rename")).toBeLessThan(sql.indexOf("create role"));
  });

  it("GATE-031 C-02: App-Rolle übernimmt den gespeicherten Verifier der alten Rolle – vor dem Umbenennen gelesen", () => {
    const sql = renameSql("v");
    expect(sql).toContain("select coalesce(rolpassword, '') as app_pw from pg_authid where oid = 10 \\gset");
    expect(sql.indexOf("\\gset")).toBeLessThan(sql.indexOf("rename"));
    expect(sql).not.toContain("POSTGRES_PASSWORD");
  });

  it("GATE-031 S-03/S-04: Rollen-Sitzungen ohne Statistik und mit festem search_path", () => {
    expect(SESSION_GUARD).toEqual(["set local pg_stat_statements.track = 'none';", "set local search_path = pg_catalog, pg_temp;"]);
    expect(renameSql("v").split("\n").slice(0, 2)).toEqual(SESSION_GUARD);
    expect(revokeSql().split("\n").slice(0, 2)).toEqual(SESSION_GUARD);
  });

  it("GATE-031 S-03: SCRAM-Verifier wie Postgres (StoredKey zum Beispiel aus RFC 7677, Passwort „pencil“)", () => {
    const v = scramVerifier("pencil", Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"), 4096);
    expect(v.startsWith("SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:")).toBe(true);
    expect(Buffer.from(v.split(":").at(-1)!, "base64")).toHaveLength(32);
    expect(scramVerifier("pencil")).not.toBe(scramVerifier("pencil")); // Salz je Aufruf
  });

  it("Eigentum: nur Nicht-System-Schemas, Erweiterungen bleiben, Restprüfung am Ende", () => {
    expect(REASSIGN_SQL).toContain("n.nspname not like 'pg\\_%'");
    expect(REASSIGN_SQL).toContain("d.deptype = 'e'");
    expect(REASSIGN_SQL).toContain("raise exception");
    expect(revokeSql()).toContain("alter role schulos with nosuperuser nocreatedb nocreaterole noreplication nobypassrls;");
    expect(revokeSql()).not.toContain("admin_pw");
    expect(revokeSql("x")).toContain("alter role postgres with password :'admin_pw';");
  });
});

/** Rollen-Zustand als Text; Hilfsrolle entsteht/verschwindet mit create/drop, Umbenennen macht aus LEGACY → NEW. */
function fake(state: string, env = "POSTGRES_PASSWORD=app-pw\n", opts: { fail?: (user: string, sql: string) => boolean; startFails?: boolean; dropFails?: boolean } = {}) {
  const calls: string[] = [];
  const sqls: string[] = [];
  const st = { env, state };
  const deps: DbRoleDeps = {
    psql: async (user, db, sql, single): Promise<PsqlResult> => {
      sqls.push(sql);
      const line = sql.split("\n").find((l) => l && !l.startsWith("\\set") && !l.startsWith("set local") && !l.includes("\\gset")) ?? "";
      calls.push(`psql ${user}@${db}${single ? " -1" : ""}: ${line}`);
      if (opts.fail?.(user, sql)) return { code: 3, stdout: "", stderr: "psql: FEHLER: kaputt\n" };
      if (sql.startsWith("select rolname")) return { code: 0, stdout: st.state, stderr: "" };
      if (sql.includes(`create role schulos_sec07`)) st.state += SEC07;
      else if (sql.startsWith("drop role if exists schulos_sec07")) {
        if (opts.dropFails) return { code: 1, stdout: "", stderr: "FEHLER: keine Berechtigung\n" };
        st.state = st.state.replace(SEC07, "");
      }
      if (sql.includes("rename to postgres")) st.state = st.state.replace(LEGACY, NEW);
      return { code: 0, stdout: "", stderr: "" };
    },
    readEnv: () => st.env,
    writeEnv: (t) => {
      calls.push("env schreiben");
      st.env = t;
    },
    stopApp: async () => void calls.push("app stop"),
    startStack: async () => {
      calls.push("stack start");
      if (opts.startFails) throw new Error("Stack startet nach der Umstellung der Datenbankrolle nicht");
    },
    secret: () => "neu-adm",
  };
  return { deps, calls, sqls, st };
}

const STATE = "psql schulos@postgres: select rolname, rolsuper, oid = 10 from pg_roles where rolname in ('schulos', 'postgres', 'schulos_sec07') order by rolname";

describe("SEC-07: ensureDbRole", () => {
  it("alte Installation: Passwort zuerst in .env, App anhalten, umbenennen in einer Transaktion, Hilfsrolle weg, Start", async () => {
    const f = fake(LEGACY);
    const r = await ensureDbRole(f.deps);
    expect(r).toMatchObject({ plan: "umbenennen", changed: true });
    expect(f.st.env).toBe("POSTGRES_PASSWORD=app-pw\nPOSTGRES_ADMIN_PASSWORD=neu-adm\n");
    expect(f.calls).toEqual([
      STATE,
      "env schreiben",
      "app stop",
      "psql schulos@postgres: drop role if exists schulos_sec07;",
      "psql schulos_sec07@schulos -1: alter role schulos rename to postgres;",
      // C-03: Zustand lesen, mit der Rolle löschen, die jetzt Superuser ist, nachprüfen
      STATE,
      "psql postgres@postgres: drop role if exists schulos_sec07;",
      STATE,
      "stack start",
    ]);
    // S-03: das Wartungspasswort geht nur als SCRAM-Verifier an den Server, das App-Passwort gar nicht
    const all = f.sqls.join("\n");
    expect(all).not.toContain("neu-adm");
    expect(all).not.toContain("app-pw");
    expect(all).toMatch(/\\set admin_pw 'SCRAM-SHA-256\$4096:/);
  });

  it("C-02: ohne POSTGRES_PASSWORD in .env trotzdem umstellbar (Verifier kommt aus der Datenbank)", async () => {
    const f = fake(LEGACY, "");
    expect(await ensureDbRole(f.deps)).toMatchObject({ plan: "umbenennen", changed: true });
  });

  it("vorhandenes POSTGRES_ADMIN_PASSWORD wird übernommen, nicht neu erzeugt", async () => {
    const f = fake(LEGACY, "POSTGRES_PASSWORD=app-pw\nPOSTGRES_ADMIN_PASSWORD=vom-admin\n");
    await ensureDbRole(f.deps);
    expect(f.calls).not.toContain("env schreiben");
    expect(f.st.env).toContain("POSTGRES_ADMIN_PASSWORD=vom-admin");
  });

  it("zweiter Lauf: nichts zu tun, App läuft weiter", async () => {
    const f = fake(NEW, "POSTGRES_PASSWORD=a\nPOSTGRES_ADMIN_PASSWORD=b\n");
    expect(await ensureDbRole(f.deps)).toEqual({ plan: "fertig", changed: false, detail: "schulos ohne Superuser-Recht" });
    expect(f.calls).toHaveLength(1);
  });

  it("fertig, aber Passwort fehlt in .env bzw. Hilfsrolle übrig → nachziehen (Passwort in einer Transaktion, als Verifier)", async () => {
    const f = fake(`${NEW}${SEC07}`, "POSTGRES_PASSWORD=a\n");
    const r = await ensureDbRole(f.deps);
    expect(r).toMatchObject({ plan: "fertig", changed: true });
    expect(f.st.env).toContain("POSTGRES_ADMIN_PASSWORD=neu-adm");
    expect(f.calls).toContain("psql postgres@postgres -1: alter role postgres with password :'admin_pw';");
    expect(f.calls).toContain("psql postgres@postgres: drop role if exists schulos_sec07;");
    expect(f.calls).not.toContain("app stop");
    expect(f.sqls.join("\n")).not.toContain("neu-adm");
  });

  it("App-Rolle hat wieder Superuser-Recht (nicht Bootstrap) → entziehen als postgres, ohne Neustart", async () => {
    const f = fake("postgres|t|t\nschulos|t|f\n", "POSTGRES_PASSWORD=a\nPOSTGRES_ADMIN_PASSWORD=b\n");
    expect(await ensureDbRole(f.deps)).toMatchObject({ plan: "entziehen", changed: true });
    expect(f.calls.at(-1)).toBe("psql postgres@schulos -1: alter role schulos with nosuperuser nocreatedb nocreaterole noreplication nobypassrls;");
    expect(f.calls).not.toContain("app stop");
  });

  it("Fehler beim Umstellen: Hilfsrolle mit der alten Superuser-Rolle weg, Stack trotzdem wieder an, Fehler weiter", async () => {
    const f = fake(LEGACY, "POSTGRES_PASSWORD=a\n", { fail: (user, sql) => user === "schulos_sec07" && sql.includes("rename") });
    await expect(ensureDbRole(f.deps)).rejects.toThrow("Rollen umstellen: psql: FEHLER: kaputt");
    expect(f.calls.slice(-3)).toEqual(["psql schulos@postgres: drop role if exists schulos_sec07;", STATE, "stack start"]);
    expect(f.st.state).not.toContain("schulos_sec07");
    // Passwort bleibt in .env – der nächste Lauf nimmt dasselbe
    expect(f.st.env).toContain("POSTGRES_ADMIN_PASSWORD=neu-adm");
  });

  it("C-03: psql meldet Fehler, obwohl die Transaktion durch ist → Hilfsrolle trotzdem mit postgres gelöscht", async () => {
    const f = fake(LEGACY, "", { fail: () => false });
    // Umbenennen klappt, aber psql liefert ≠ 0 (z. B. Abbruch von `compose exec` beim Beenden)
    const orig = f.deps.psql;
    f.deps.psql = async (user, db, sql, single) => {
      const r = await orig(user, db, sql, single);
      return sql.includes("rename to postgres") ? { code: 1, stdout: "", stderr: "exec abgebrochen\n" } : r;
    };
    await expect(ensureDbRole(f.deps)).rejects.toThrow("Rollen umstellen: exec abgebrochen");
    expect(f.calls).toContain("psql postgres@postgres: drop role if exists schulos_sec07;");
    expect(f.st.state).not.toContain("schulos_sec07");
  });

  it("C-03: Hilfsrolle bleibt bzw. Start scheitert → beide Ursachen in der Meldung", async () => {
    const f = fake(LEGACY, "", { fail: (user, sql) => user === "schulos_sec07" && sql.includes("rename"), startFails: true, dropFails: true });
    const e = (await ensureDbRole(f.deps).catch((x: unknown) => x)) as Error;
    expect(e.message).toContain("Rollen umstellen: psql: FEHLER: kaputt");
    expect(e.message).toContain("Hilfsrolle schulos_sec07 nicht entfernt");
    expect(e.message).toContain("Stack startet nach der Umstellung");
  });

  it("bei unklarem Zustand: nichts anfassen", async () => {
    const g = fake("postgres|t|f\nschulos|t|t\n");
    await expect(ensureDbRole(g.deps)).rejects.toThrow(/von Hand/);
    expect(g.calls).toHaveLength(1);
  });
});
