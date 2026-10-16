import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { MODULES } from "@/modules";
import { listAudit } from "./audit-view";
import { addMembers, createGroup, deleteGroup } from "./groups";
import { setRoleGrant } from "./rights";
import { setUserLocked } from "./users";

describe("Protokoll-Ansicht", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
    await setUserLocked(h.db, "u-admin", "u-lea.schaefer", true);
    const g = await createGroup(h.db, "u-sabine.kowalski", { name: "AG Imkern", kind: "ag" });
    await addMembers(h.db, "u-sabine.kowalski", g, ["u-lea.schaefer", "u-jana.brandt"]);
    await setRoleGrant(h.db, MODULES, "u-admin", "lehrkraft", "verwaltung.access", true);
    const tmp = await createGroup(h.db, "u-admin", { name: "Wegwerf", kind: "frei" });
    await deleteGroup(h.db, "u-admin", tmp);
  }, 60_000);
  afterAll(() => h.close());

  it("listet neueste zuerst mit Beschriftung, Akteur und aufgelöstem Ziel", async () => {
    const { rows, total } = await listAudit(h.db);
    expect(total).toBe(6);
    expect(rows[0]).toMatchObject({ label: "Gruppe gelöscht", actor: "Admin IT", target: "Wegwerf" });
    expect(rows.find((r) => r.action === "verwaltung.user.lock")).toMatchObject({ label: "Benutzer gesperrt", target: "Lea Schäfer" });
    expect(rows.find((r) => r.action === "verwaltung.group.members_add")).toMatchObject({ actor: "Sabine Kowalski", target: "AG Imkern", detail: "2 Personen" });
    expect(rows.find((r) => r.action === "verwaltung.rights.grant")).toMatchObject({ target: "Rolle Lehrkraft", detail: "verwaltung.access" });
  });

  it("filtert nach Bereich", async () => {
    const { rows } = await listAudit(h.db, { prefix: "verwaltung.group." });
    expect(rows.every((r) => r.action.startsWith("verwaltung.group."))).toBe(true);
    expect(rows).toHaveLength(4);
  });
});
