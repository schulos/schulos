import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "./testing";
import type { DbHandle } from "./client";
import { appRoleIsSuperuser, enableQueryStats, shortQuery, slowQueries } from "./statements";

describe("Abfragestatistik (B-51)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it("ist ohne vorgeladenes pg_stat_statements (PGlite, Test-Postgres) aus, ohne Fehler", async () => {
    expect(await enableQueryStats(h.db)).toBe(false);
    expect(await slowQueries(h.db)).toBeNull();
    // die Verbindung bleibt danach benutzbar (kein abgebrochener Zustand)
    expect(await enableQueryStats(h.db)).toBe(false);
  });

  it("GATE-031: Superuser-Hinweis nur mit Server-Postgres (PGlite ist immer Superuser)", async () => {
    const before = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    expect(await appRoleIsSuperuser(h.db)).toBe(false);
    process.env.DATABASE_URL = "postgres://x";
    try {
      expect(await appRoleIsSuperuser(h.db)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
    }
  });

  it("kürzt Abfragen auf eine Zeile", () => {
    expect(shortQuery("select *\n  from users\twhere id = $1")).toBe("select * from users where id = $1");
    const long = shortQuery("select " + "x, ".repeat(200), 50);
    expect(long).toHaveLength(50);
    expect(long.endsWith("…")).toBe(true);
  });
});
