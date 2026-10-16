// Monatlicher Test-Restore auf DB-Ebene (B-26, Entscheidung 2026-10-04: ohne Docker-Socket). Der neueste Datenbank-Dump wird
// zurückgeholt und in eine Wegwerf-Datenbank des Test-Postgres (Sidecar) eingespielt; geprüft werden Migrationsstand und
// Tabellen. Ergebnis nur als Kennzahlen – keine Inhalte. Den Start des SchulOS-Images dagegen ergänzt OPS-3 über den Host.
// SEC-06: Der Dump kommt vom Hauptsystem und ist nicht vertrauenswürdig (dort reicht eine SQL-Injection, um ihn zu präparieren).
// Darum: Inhaltsverzeichnis prüfen (nur Arten des SchulOS-Schemas) und mit einer Wegwerf-Rolle ohne Superuser-Recht einspielen,
// die nur Eigentümerin der Wegwerf-Datenbank ist – nie als `postgres`.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { checkDumpToc } from "@schulos/server/dump-toc";
import { lastLine, type Exec } from "@schulos/server/exec";
import { ResticFailed, restoreDump, type LocalRestic } from "@/restic/local";

export interface RestoreTestResult {
  snapshot: string;
  dumpBytes: number;
  /** Einträge im Dump-Inhaltsverzeichnis (pg_restore --list) */
  dumpEntries: number;
  /** nur mit Test-Postgres: */
  tables?: number;
  migrations?: number;
  accounts?: number;
}

export interface RestoreTestContext {
  restic: LocalRestic;
  exec: Exec;
  pgRestore: string;
  /** postgres://… des Test-Postgres (Sidecar); ohne: nur Lesbarkeit des Dumps */
  testDbUrl: string | null;
}

export function restoreTestContext(restic: LocalRestic, env: Record<string, string | undefined> = process.env): RestoreTestContext {
  return { restic, exec: restic.exec, pgRestore: env.PG_RESTORE_BIN ?? "pg_restore", testDbUrl: env.SCHULOS_RESTORE_TEST_DB ?? null };
}

/** Datenbank-URL mit anderem Datenbanknamen und anderer Rolle. */
function withDatabase(url: string, db: string, user: string, password: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  u.username = user;
  u.password = password;
  return u.toString();
}

export async function runRestoreTest(ctx: RestoreTestContext, restUser: string, password: string): Promise<RestoreTestResult> {
  const work = mkdtempSync(path.join(tmpdir(), "schulos-restore-test-"));
  const dbName = `restore_test_${Date.now().toString(36)}`;
  try {
    const { snapshot, file } = await restoreDump(ctx.restic, restUser, password, work);
    const dumpBytes = statSync(file).size;
    const list = await ctx.exec(ctx.pgRestore, ["--list", file]);
    if (list.code !== 0) throw new ResticFailed(`Dump nicht lesbar: ${lastLine(list.stderr)}`);
    const dumpEntries = list.stdout.split(/\r?\n/).filter((l) => l && !l.startsWith(";")).length;
    const toc = checkDumpToc(list.stdout);
    if (toc.rejected.length) throw new ResticFailed(`Dump enthält Einträge, die SchulOS nie anlegt (${toc.rejected.slice(0, 3).join("; ")}) – nicht eingespielt.`);
    const result: RestoreTestResult = { snapshot, dumpBytes, dumpEntries };
    if (!ctx.testDbUrl) return result;

    const listFile = path.join(work, "inhalt.list");
    writeFileSync(listFile, toc.list, { mode: 0o600 });
    const rolePassword = randomBytes(24).toString("hex");
    const admin = postgres(ctx.testDbUrl, { max: 1, onnotice: () => {} });
    try {
      // Rolle = Name der Datenbank (nur [a-z0-9_]); Passwort nur hex – beides ohne Anführungszeichen-Probleme
      await admin.unsafe(`create role ${dbName} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '${rolePassword}'`);
      await admin.unsafe(`create database ${dbName} owner ${dbName}`);
      const target = withDatabase(ctx.testDbUrl, dbName, dbName, rolePassword);
      const u = new URL(target);
      const r = await ctx.exec(ctx.pgRestore, ["--no-owner", "--no-privileges", "--exit-on-error", "--use-list", listFile, "--dbname", dbName, file], {
        env: { PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: dbName, PGPASSWORD: rolePassword },
      });
      if (r.code !== 0) throw new ResticFailed(`Einspielen fehlgeschlagen: ${lastLine(r.stderr)}`);
      const db = postgres(target, { max: 1, onnotice: () => {} });
      try {
        const [t] = await db<{ n: number }[]>`select count(*)::int as n from information_schema.tables where table_schema = 'public'`;
        const [m] = await db<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`.catch(() => [{ n: 0 }]);
        const [a] = await db<{ n: number }[]>`select count(*)::int as n from users`.catch(() => [{ n: 0 }]);
        if (!t?.n) throw new ResticFailed("Eingespielte Datenbank enthält keine Tabellen.");
        if (!m?.n) throw new ResticFailed("Eingespielte Datenbank hat keinen Migrationsstand.");
        return { ...result, tables: t.n, migrations: m.n, accounts: a?.n ?? 0 };
      } finally {
        await db.end();
      }
    } finally {
      await admin.unsafe(`drop database if exists ${dbName} with (force)`).catch(() => {});
      await admin.unsafe(`drop role if exists ${dbName}`).catch(() => {});
      await admin.end();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
