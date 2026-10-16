import { describe, expect, it } from "vitest";
import { health } from "@/lib/health";

describe("health", () => {
  it("meldet die Backup-App mit Version und Datenbankstand", () => {
    expect(health("0.1.0", true)).toEqual({ ok: true, app: "schulos-backup", version: "0.1.0", db: "up" });
    expect(health("0.1.0", false)).toMatchObject({ ok: false, db: "down" });
  });
});
