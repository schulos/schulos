import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, calendarEvents, calendarFeedTokens, groupMembers, parentChild, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { saveExternalSettings } from "@/core/device-certs/service";
import { EXTERN_HEADER, externalPathAllowed } from "@/core/external-access";
import { loadPermissions } from "@/core/permissions";
import { EXPORT_OMIT } from "@/core/privacy/auskunft";
import { isPublicPath } from "@/core/public-paths";
import { hashPublicToken, isTokenShape } from "@/core/public-token";
import { ValidationError } from "@/modules/verwaltung/users";
import { createFeed, FEED_MAX_PER_USER, listFeeds, readFeed, revokeFeed } from "./abo";

const NOW = new Date("2026-10-12T08:00:00Z");
const intern = new Headers();
const ctx = (ip: string, headers: Headers = intern, now = NOW) => ({ ip, headers, now });

describe("Kalender-Abo per Link (Q5-15)", () => {
  let h: DbHandle;
  const perms = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.insert(calendarEvents).values({
      title: "Zahnarzt (privat)",
      scope: "personal",
      ownerId: "u-jana.brandt",
      startsAt: new Date("2026-10-20T08:00:00Z"),
      endsAt: new Date("2026-10-20T09:00:00Z"),
    });
  }, 60_000);
  afterAll(() => h.close());

  it("anlegen: Token nur einmal, in der DB nur der Hash, Audit ohne Token", async () => {
    const jana = await perms("u-jana.brandt");
    const { id, token } = await createFeed(h.db, jana, { calendar: "personal", label: "  Handy  " });
    expect(isTokenShape(token)).toBe(true);
    const [row] = await h.db.select().from(calendarFeedTokens).where(eq(calendarFeedTokens.id, id));
    expect(row).toMatchObject({ userId: "u-jana.brandt", calendar: "personal", label: "Handy", tokenHash: hashPublicToken(token), lastUsedAt: null });
    expect(JSON.stringify(row)).not.toContain(token);
    const [a] = await h.db.select().from(auditLog).where(eq(auditLog.action, "kalender.abo.anlegen"));
    expect(a).toMatchObject({ actorId: "u-jana.brandt", target: id });
    expect(JSON.stringify(a!.meta)).not.toContain(token);
    expect((await listFeeds(h.db, jana)).map((f) => [f.label, f.calendarLabel])).toEqual([["Handy", "Persönlich"]]);
    // die Auskunft enthält den Hash nicht
    expect(EXPORT_OMIT.calendar_feed_tokens).toContain("token_hash");
  });

  it("Abruf ohne Sitzung: nur die Termine dieses Kalenders, „zuletzt genutzt“ stundengenau", async () => {
    const jana = await perms("u-jana.brandt");
    const { id, token } = await createFeed(h.db, jana, { calendar: "personal", label: "Laptop" });
    const r = await readFeed(h.db, token, ctx("10.0.0.1"));
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.ics).toContain("BEGIN:VCALENDAR");
    expect(r.ics).toContain("Zahnarzt (privat)");
    const used = async () => (await h.db.select({ t: calendarFeedTokens.lastUsedAt }).from(calendarFeedTokens).where(eq(calendarFeedTokens.id, id)))[0]!.t;
    expect(await used()).toEqual(NOW);
    await readFeed(h.db, token, ctx("10.0.0.1", intern, new Date(NOW.getTime() + 10 * 60_000)));
    expect(await used()).toEqual(NOW); // nicht bei jedem Abruf
  });

  it("ungültige, fremde oder widerrufene Links: 404; widerrufen nur der eigene; Audit", async () => {
    const jana = await perms("u-jana.brandt");
    const { id, token } = await createFeed(h.db, jana, { calendar: "school", label: "Schulkalender" });
    expect((await readFeed(h.db, "kein-token", ctx("10.0.0.2"))).state).toBe("not-found");
    expect((await readFeed(h.db, token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), ctx("10.0.0.2"))).state).toBe("not-found");
    expect(await revokeFeed(h.db, await perms("u-lea.schaefer"), id)).toBe(false);
    expect((await readFeed(h.db, token, ctx("10.0.0.2"))).state).toBe("ok");
    expect(await revokeFeed(h.db, jana, id)).toBe(true);
    expect((await readFeed(h.db, token, ctx("10.0.0.2"))).state).toBe("not-found");
    expect((await h.db.select().from(auditLog).where(and(eq(auditLog.action, "kalender.abo.widerrufen"), eq(auditLog.target, id)))).length).toBe(1);
  });

  it("nur lesbare Kalender: fremde Gruppe lässt sich nicht abonnieren; Gruppe verlassen → 404", async () => {
    const lea = await perms("u-lea.schaefer");
    await expect(createFeed(h.db, lea, { calendar: "group:g-9a", label: "fremd" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createFeed(h.db, lea, { calendar: "personal", label: "" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createFeed(h.db, lea, { calendar: "personal", label: "x".repeat(61) })).rejects.toBeInstanceOf(ValidationError);
    const { token } = await createFeed(h.db, lea, { calendar: "group:g-7b", label: "Klasse" });
    expect((await readFeed(h.db, token, ctx("10.0.0.3"))).state).toBe("ok");
    const [m] = await h.db.select().from(groupMembers).where(and(eq(groupMembers.groupId, "g-7b"), eq(groupMembers.userId, "u-lea.schaefer")));
    await h.db.delete(groupMembers).where(and(eq(groupMembers.groupId, "g-7b"), eq(groupMembers.userId, "u-lea.schaefer")));
    expect((await readFeed(h.db, token, ctx("10.0.0.3"))).state).toBe("not-found");
    await h.db.insert(groupMembers).values(m!);
  });

  it(`höchstens ${FEED_MAX_PER_USER} Links je Person`, async () => {
    const tobias = await perms("u-tobias.kleine");
    for (let i = 0; i < FEED_MAX_PER_USER; i++) await createFeed(h.db, tobias, { calendar: "personal", label: `Gerät ${i}` });
    await expect(createFeed(h.db, tobias, { calendar: "personal", label: "eins zu viel" })).rejects.toThrow(ValidationError);
  });

  it("gesperrtes Konto: Link liefert nichts mehr", async () => {
    const { token } = await createFeed(h.db, await perms("u-lea.schaefer"), { calendar: "personal", label: "vor Sperre" });
    await h.db.update(users).set({ status: "locked" }).where(eq(users.id, "u-lea.schaefer"));
    expect((await readFeed(h.db, token, ctx("10.0.0.4"))).state).toBe("not-found");
    await h.db.update(users).set({ status: "active" }).where(eq(users.id, "u-lea.schaefer"));
  });

  it("von außen wie eine Anmeldung: nur Allowlist-Zone → 403; Modus „alles“ nach Rolle und Zertifikatspflicht", async () => {
    const [{ parentId }] = (await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, "u-lea.schaefer"))) as [{ parentId: string }];
    const parent = await createFeed(h.db, await perms(parentId), { calendar: "school", label: "Eltern" });
    const teacher = await createFeed(h.db, await perms("u-jana.brandt"), { calendar: "school", label: "Lehrkraft" });
    const admin = await createFeed(h.db, await perms("u-admin"), { calendar: "school", label: "Admin" });
    const zone = (v: string) => new Headers({ [EXTERN_HEADER]: v });
    expect(await readFeed(h.db, parent.token, ctx("203.0.113.9", zone("1")))).toMatchObject({ state: "denied" });
    expect((await readFeed(h.db, parent.token, ctx("203.0.113.9", zone("alles")))).state).toBe("ok");
    expect(await readFeed(h.db, admin.token, ctx("203.0.113.9", zone("alles")))).toMatchObject({ state: "denied" });
    // ohne Schul-CA keine Zertifikatspflicht (Vorgabe) – mit Pflicht kommt die Lehrkraft ohne Gerätezertifikat nicht an ihre Termine
    expect((await readFeed(h.db, teacher.token, ctx("203.0.113.9", zone("alles")))).state).toBe("ok");
    await saveExternalSettings(h.db, "u-admin", "intern", { staffCert: "an", adminAllowed: null });
    expect(await readFeed(h.db, teacher.token, ctx("203.0.113.9", zone("alles")))).toMatchObject({ state: "denied" });
    expect((await readFeed(h.db, teacher.token, ctx("10.0.0.5"))).state).toBe("ok");
    await saveExternalSettings(h.db, "u-admin", "intern", { staffCert: null, adminAllowed: null });
  });

  it("Rate-Limit je Link und je IP", async () => {
    const { token } = await createFeed(h.db, await perms("u-sabine.kowalski"), { calendar: "school", label: "viel" });
    const states: string[] = [];
    for (let i = 0; i < 21; i++) states.push((await readFeed(h.db, token, ctx(`10.1.0.${i}`))).state);
    expect(states.slice(0, 20).every((s) => s === "ok")).toBe(true);
    expect(states[20]).toBe("limited");
    // GATE-4f C-09: gültige Abrufe zählen nicht gegen die IP (Kalenderdienste rufen viele Links von einer Adresse ab)
    const { token: other } = await createFeed(h.db, await perms("u-sabine.kowalski"), { calendar: "school", label: "dienst" });
    for (let i = 0; i < 20; i++) expect((await readFeed(h.db, other, ctx("10.2.0.1"))).state).toBe("ok");
    const ipStates: string[] = [];
    for (let i = 0; i < 122; i++) ipStates.push((await readFeed(h.db, i % 2 ? "x".repeat(43) : "kurz", ctx("10.2.0.1"))).state);
    expect(ipStates[119]).toBe("not-found");
    expect(ipStates[120]).toBe("limited");
    expect(ipStates[121]).toBe("limited");
    // gesperrte IP: auch ein gültiger Link geht dann nicht
    const { token: third } = await createFeed(h.db, await perms("u-sabine.kowalski"), { calendar: "school", label: "dritter" });
    expect((await readFeed(h.db, third, ctx("10.2.0.1"))).state).toBe("limited");
    expect((await readFeed(h.db, third, ctx("10.2.0.2"))).state).toBe("ok");
  }, 60_000);

  it("Pfad: ohne Anmeldung erreichbar, aber nicht in der Außen-Allowlist", () => {
    const p = `/api/kalender/abo/${"a".repeat(43)}`;
    expect(isPublicPath(p)).toBe(true);
    expect(externalPathAllowed(p)).toBe(false);
    expect(isPublicPath("/api/kalender/abo/a/b")).toBe(false);
    expect(isPublicPath("/api/kalender/ics")).toBe(false);
    expect(isPublicPath("/api/kalender/abo/")).toBe(false);
  });
});
