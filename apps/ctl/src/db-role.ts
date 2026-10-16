// SEC-07: App-Datenbankrolle ohne Superuser-Recht. Neue Installationen richtet compose.yaml so ein (Wartungsrolle „postgres“
// als POSTGRES_USER, Init-Skript legt „schulos“ als NOSUPERUSER-Eigentümerin der Datenbank an). Bestehende Installationen
// (bis v0.3.x war „schulos“ selbst der Superuser, und zwar die Bootstrap-Rolle mit OID 10) stellt `schulosctl update`
// einmalig um – idempotent, jeder Lauf prüft zuerst den Zustand in pg_roles:
//   1. POSTGRES_ADMIN_PASSWORD in .env (fehlt → zufällig erzeugen und zuerst schreiben, damit ein Abbruch nichts verliert)
//   2. App und Backup-Agent anhalten (ihre Sitzungen laufen als „schulos“)
//   3. Hilfsrolle schulos_sec07 (Superuser, nur für diesen Schritt) – die Bootstrap-Rolle lässt sich weder ihr
//      Superuser-Recht nehmen noch per REASSIGN OWNED enteignen, darum wird sie zur Wartungsrolle umbenannt:
//      ALTER ROLE schulos RENAME TO postgres, neue Rolle „schulos“ ohne Superuser mit dem bisherigen Passwort,
//      Eigentum an Datenbank, Schemas, Tabellen, Sequenzen, Typen, Funktionen an „schulos“ (eine Transaktion)
//   4. Hilfsrolle löschen, Stack wieder starten
// Rückweg (INSTALLATION.md §5a.2): `ALTER ROLE schulos SUPERUSER` als postgres – alte Versionen laufen auch ohne.
//
// GATE-031: Die neue App-Rolle übernimmt den Passwort-Verifier der alten (pg_authid.rolpassword, C-02) – kein Klartext aus
// der .env, die Compose evtl. anders interpoliert hat. Das Passwort der Wartungsrolle geht nur als SCRAM-Verifier an den
// Server (S-03), Statistik ist in diesen Sitzungen aus, search_path fest (S-04).
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readEnvValue, setEnvValues } from "./update";

export const APP_ROLE = "schulos";
export const ADMIN_ROLE = "postgres";
export const MIGRATION_ROLE = "schulos_sec07";
export const ADMIN_PASSWORD_KEY = "POSTGRES_ADMIN_PASSWORD";
export const APP_PASSWORD_KEY = "POSTGRES_PASSWORD";

export interface RoleRow {
  name: string;
  superuser: boolean;
  /** Bootstrap-Rolle (OID 10): muss Superuser bleiben, REASSIGN OWNED geht nicht */
  bootstrap: boolean;
}

/** Zustand der beteiligten Rollen; lesbar mit jeder Rolle (pg_roles ist öffentlich). Ausgabe: name|t|f je Zeile. */
export const ROLE_STATE_SQL = `select rolname, rolsuper, oid = 10 from pg_roles where rolname in ('${APP_ROLE}', '${ADMIN_ROLE}', '${MIGRATION_ROLE}') order by rolname`;

export function parseRoleState(out: string): RoleRow[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, superuser, bootstrap] = l.split("|");
      return { name: name ?? "", superuser: superuser === "t", bootstrap: bootstrap === "t" };
    });
}

export type RolePlan =
  /** App-Rolle ohne Superuser, Wartungsrolle vorhanden */
  | { action: "fertig" }
  /** alte Installation: App-Rolle ist die Bootstrap-Rolle → umbenennen und neu anlegen */
  | { action: "umbenennen" }
  /** App-Rolle hat (wieder) Superuser-Recht, ist aber nicht die Bootstrap-Rolle → nur entziehen */
  | { action: "entziehen" }
  | { action: "fehler"; reason: string };

export function planRoleMigration(rows: RoleRow[]): RolePlan {
  const app = rows.find((r) => r.name === APP_ROLE);
  const admin = rows.find((r) => r.name === ADMIN_ROLE);
  if (!app) return { action: "fehler", reason: `Datenbankrolle ${APP_ROLE} fehlt` };
  if (!app.superuser) {
    if (admin?.superuser) return { action: "fertig" };
    return { action: "fehler", reason: `${APP_ROLE} hat kein Superuser-Recht, aber die Wartungsrolle ${ADMIN_ROLE} fehlt bzw. ist kein Superuser` };
  }
  if (app.bootstrap) {
    if (!admin) return { action: "umbenennen" };
    return { action: "fehler", reason: `Rolle ${ADMIN_ROLE} existiert schon neben der Bootstrap-Rolle ${APP_ROLE} – von Hand umstellen (INSTALLATION.md §5a.2)` };
  }
  if (admin?.superuser) return { action: "entziehen" };
  return { action: "fehler", reason: `${APP_ROLE} ist Superuser, eine Wartungsrolle ${ADMIN_ROLE} mit Superuser-Recht fehlt` };
}

/** Wert für psql `\set name '…'` (Backslash und Hochkomma maskiert) – Passwörter gehen über stdin, nie als Argument. */
export function psqlSetLine(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${name}: Zeilenumbruch im Passwort`);
  return `\\set ${name} '${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

const APP_ATTRS = "nosuperuser nocreatedb nocreaterole noreplication nobypassrls";

/**
 * SCRAM-SHA-256-Verifier wie ihn Postgres speichert (RFC 5802/7677): Der Server bekommt nie den Klartext, also landet er
 * weder in pg_stat_statements noch im Server-Log. SASLprep entfällt für druckbares ASCII (Passwörter von schulosctl und
 * Installer sind hex); sonst NFKC als Näherung – Postgres nimmt bei nicht normalisierbaren Zeichen ebenfalls die Rohbytes.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const pw = /^[ -~]*$/.test(password) ? password : password.normalize("NFKC");
  const salted = pbkdf2Sync(Buffer.from(pw, "utf8"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** Kopf jeder Wartungssitzung, die Rollen ändert: keine Statistik dieser Befehle, kein search_path aus der App-Datenbank. */
export const SESSION_GUARD = ["set local pg_stat_statements.track = 'none';", "set local search_path = pg_catalog, pg_temp;"];

/**
 * Eigentum der Bootstrap-Rolle (OID 10, nach der Umstellung „postgres“) in dieser Datenbank an die App-Rolle – außer
 * System-Schemas und Objekten von Erweiterungen (pg_stat_statements bleibt bei der Wartungsrolle). Am Ende Prüfung:
 * bleibt etwas übrig, bricht die Transaktion ab.
 */
export const REASSIGN_SQL = `do $$
declare
  r record;
  rest int;
begin
  for r in select n.nspname from pg_namespace n
    where n.nspowner = 10 and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
      and not exists (select 1 from pg_depend d where d.classid = 'pg_namespace'::regclass and d.objid = n.oid and d.deptype = 'e')
  loop
    execute format('alter schema %I owner to ${APP_ROLE}', r.nspname);
  end loop;
  for r in select c.oid::regclass as obj, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relowner = 10 and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
  loop
    execute format('alter %s %s owner to ${APP_ROLE}',
      case r.relkind when 'v' then 'view' when 'm' then 'materialized view' when 'f' then 'foreign table' else 'table' end, r.obj);
  end loop;
  -- Sequenzen von Spalten wandern mit ihrer Tabelle; übrig bleiben eigenständige
  for r in select c.oid::regclass as obj from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relowner = 10 and c.relkind = 'S'
      and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype in ('e', 'a', 'i'))
  loop
    execute format('alter sequence %s owner to ${APP_ROLE}', r.obj);
  end loop;
  for r in select t.oid::regtype as obj, t.typtype from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where t.typowner = 10 and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
      and (t.typtype in ('e', 'd', 'r') or (t.typtype = 'c' and exists (select 1 from pg_class c where c.oid = t.typrelid and c.relkind = 'c')))
      and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')
  loop
    execute format('alter %s %s owner to ${APP_ROLE}', case r.typtype when 'd' then 'domain' else 'type' end, r.obj);
  end loop;
  for r in select p.oid::regprocedure as obj from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proowner = 10 and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter routine %s owner to ${APP_ROLE}', r.obj);
  end loop;
  select count(*) into rest from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relowner = 10 and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e');
  if rest > 0 then
    raise exception 'SEC-07: % Objekte gehören noch der Wartungsrolle', rest;
  end if;
end
$$;`;

/**
 * Umstellung einer alten Installation – als MIGRATION_ROLE in der Datenbank schulos, eine Transaktion (psql -1).
 * adminVerifier: SCRAM-Verifier des neuen Wartungspassworts. Die neue App-Rolle bekommt den gespeicherten Verifier der alten
 * (vor dem Umbenennen gelesen – ein md5-Verifier hängt am Rollennamen, der für „schulos“ derselbe bleibt).
 */
export function renameSql(adminVerifier: string): string {
  return [
    ...SESSION_GUARD,
    psqlSetLine("admin_pw", adminVerifier),
    "select coalesce(rolpassword, '') as app_pw from pg_authid where oid = 10 \\gset",
    `alter role ${APP_ROLE} rename to ${ADMIN_ROLE};`,
    `alter role ${ADMIN_ROLE} with superuser login password :'admin_pw';`,
    `create role ${APP_ROLE} login ${APP_ATTRS} password :'app_pw';`,
    `alter database ${APP_ROLE} owner to ${APP_ROLE};`,
    REASSIGN_SQL,
    "",
  ].join("\n");
}

/** App-Rolle hat Superuser-Recht, ist aber nicht die Bootstrap-Rolle – als ADMIN_ROLE, eine Transaktion. */
export function revokeSql(adminVerifier?: string): string {
  return [
    ...SESSION_GUARD,
    ...(adminVerifier ? [psqlSetLine("admin_pw", adminVerifier), `alter role ${ADMIN_ROLE} with password :'admin_pw';`] : []),
    `alter role ${APP_ROLE} with ${APP_ATTRS};`,
    `alter database ${APP_ROLE} owner to ${APP_ROLE};`,
    REASSIGN_SQL,
    "",
  ].join("\n");
}

export interface PsqlResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DbRoleDeps {
  /** psql im Postgres-Container über den Socket (lokal ohne Passwort), SQL über stdin; single = eine Transaktion */
  psql(user: string, db: string, sql: string, single?: boolean): Promise<PsqlResult>;
  readEnv(): string;
  writeEnv(text: string): void;
  /** App und Backup-Agent anhalten (Sitzungen als „schulos“) */
  stopApp(): Promise<void>;
  /** Stack wieder starten und warten, bis er gesund ist */
  startStack(): Promise<void>;
  secret(): string;
}

export interface DbRoleResult {
  plan: RolePlan["action"];
  changed: boolean;
  detail: string;
}

const last = (r: PsqlResult) => (r.stderr || r.stdout).trim().split("\n").at(-1) ?? `Exit ${r.code}`;

async function must(d: DbRoleDeps, user: string, db: string, sql: string, what: string, single = false): Promise<string> {
  const r = await d.psql(user, db, sql, single);
  if (r.code !== 0) throw new Error(`${what}: ${last(r)}`);
  return r.stdout;
}

/** Einmalige, idempotente Umstellung (s. o.). Ergebnis für das Update-Protokoll; Fehler als Exception. */
export async function ensureDbRole(d: DbRoleDeps): Promise<DbRoleResult> {
  // als App-Rolle lesen: die gibt es in jedem Zustand, die Wartungsrolle erst nach der Umstellung
  const rows = parseRoleState(await must(d, APP_ROLE, "postgres", ROLE_STATE_SQL, "Rollen lesen"));
  const plan = planRoleMigration(rows);
  if (plan.action === "fehler") throw new Error(plan.reason);
  const leftover = rows.some((r) => r.name === MIGRATION_ROLE);

  let env = d.readEnv();
  const existing = readEnvValue(env, ADMIN_PASSWORD_KEY);
  const adminPassword = existing || d.secret();
  if (!existing) {
    env = setEnvValues(env, { [ADMIN_PASSWORD_KEY]: adminPassword });
    d.writeEnv(env);
  }
  const adminVerifier = scramVerifier(adminPassword);

  if (plan.action === "fertig") {
    const notes: string[] = [];
    if (!existing) {
      await must(
        d,
        ADMIN_ROLE,
        "postgres",
        [...SESSION_GUARD, psqlSetLine("admin_pw", adminVerifier), `alter role ${ADMIN_ROLE} with password :'admin_pw';`, ""].join("\n"),
        "Passwort der Wartungsrolle",
        true,
      );
      notes.push(`${ADMIN_PASSWORD_KEY} neu in .env`);
    }
    if (leftover) {
      await must(d, ADMIN_ROLE, "postgres", `drop role if exists ${MIGRATION_ROLE};`, "Hilfsrolle löschen");
      notes.push(`Hilfsrolle ${MIGRATION_ROLE} entfernt`);
    }
    return { plan: "fertig", changed: notes.length > 0, detail: notes.length ? notes.join(", ") : `${APP_ROLE} ohne Superuser-Recht` };
  }

  if (plan.action === "entziehen") {
    await must(d, ADMIN_ROLE, APP_ROLE, revokeSql(existing ? undefined : adminVerifier), "Superuser-Recht entziehen", true);
    if (leftover) await must(d, ADMIN_ROLE, "postgres", `drop role if exists ${MIGRATION_ROLE};`, "Hilfsrolle löschen");
    return { plan: "entziehen", changed: true, detail: `${APP_ROLE}: Superuser-Recht entzogen, Eigentum geprüft` };
  }

  // umbenennen: alte Installation
  let failure: unknown = null;
  try {
    await d.stopApp();
    await must(
      d,
      APP_ROLE,
      "postgres",
      `drop role if exists ${MIGRATION_ROLE};\ncreate role ${MIGRATION_ROLE} superuser login;\n`,
      "Hilfsrolle anlegen",
    );
    await must(d, MIGRATION_ROLE, APP_ROLE, renameSql(adminVerifier), "Rollen umstellen", true);
  } catch (e) {
    failure = e;
  }
  const problems: string[] = [];
  // C-03: Hilfsrolle weg – mit der Rolle, die laut Datenbank jetzt Superuser ist (nicht raten: psql kann ≠ 0 melden, obwohl
  // die Transaktion durch ist), danach nachprüfen
  const cleanup = await removeMigrationRole(d);
  if (cleanup) problems.push(cleanup);
  try {
    await d.startStack();
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  if (failure || problems.length) {
    const first = failure instanceof Error ? failure.message : failure ? String(failure) : null;
    throw new Error([first, ...problems].filter(Boolean).join("; danach: "));
  }
  return { plan: "umbenennen", changed: true, detail: `Wartungsrolle ${ADMIN_ROLE} (bisher ${APP_ROLE}), neue App-Rolle ${APP_ROLE} ohne Superuser-Recht` };
}

/** Hilfsrolle löschen und prüfen; null = weg, sonst Meldung (die Rolle hat Superuser-Recht und kein Passwort). */
async function removeMigrationRole(d: DbRoleDeps): Promise<string | null> {
  const state = await d.psql(APP_ROLE, "postgres", ROLE_STATE_SQL);
  const rows = state.code === 0 ? parseRoleState(state.stdout) : [];
  if (state.code === 0 && !rows.some((r) => r.name === MIGRATION_ROLE)) return null;
  const admin = rows.some((r) => r.name === ADMIN_ROLE && r.superuser) ? ADMIN_ROLE : APP_ROLE;
  const drop = await d.psql(admin, "postgres", `drop role if exists ${MIGRATION_ROLE};`);
  const after = await d.psql(APP_ROLE, "postgres", ROLE_STATE_SQL);
  if (after.code === 0 && !parseRoleState(after.stdout).some((r) => r.name === MIGRATION_ROLE)) return null;
  return `Hilfsrolle ${MIGRATION_ROLE} nicht entfernt (${drop.code === 0 ? "noch vorhanden" : last(drop)}) – \`schulosctl db-rolle\` erneut ausführen`;
}
