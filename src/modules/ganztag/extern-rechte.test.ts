// GT-15 (Projektleitung 04.11.2026): Externe Ganztags-Leitungen (befristetes Konto, `users.expires_on`) dürfen nur den Ganztag –
// ihre Angebote und Anwesenheitslisten, dazu Konto/Passwort/2FA. Adressbuch, Messenger und alle anderen Module sind serverseitig
// zu: Seiten (404), Server Actions (ForbiddenError), API (403), Navigation, Startseite, Suche, Gong und Live-Ereignisse. Rollen-
// und Gruppen-Grants zählen für sie nicht, ebenso die „group.*“-Rechte der Gruppenleitung.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db, DbHandle } from "@/core/db/client";

const state = vi.hoisted(() => ({ db: null as unknown as Db, userId: "" }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));
vi.mock("@/core/db/client", async (orig) => ({
  ...(await orig<typeof import("@/core/db/client")>()),
  getDb: async () => state.db,
}));
vi.mock("@/core/auth/session", async (orig) => {
  const { loadPermissions: load } = await import("@/core/permissions");
  const current = async () => {
    const perms = await load(state.db, state.userId);
    return { user: { id: state.userId, name: "", firstName: "", lastName: "", shortCode: null, role: perms.role, username: "" }, perms };
  };
  return {
    ...(await orig<typeof import("@/core/auth/session")>()),
    getCurrentUser: current,
    requireUser: current,
    requirePermission: async (permission: string) => {
      const c = await current();
      const { assertPermission } = await import("@/core/permissions");
      assertPermission(c.perms, permission);
      return c;
    },
  };
});

import { notifications, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { moduleActions } from "@/core/modules/guard";
import { buildNav, loadModuleStates, setModuleEnabled } from "@/core/modules/registry";
import { notify } from "@/core/notifications";
import { externalLiveEvent } from "@/core/notifications/stream";
import { externalApiAllowed, ForbiddenError, hasPermission, loadPermissions, moduleAllowed, usersWithPermission } from "@/core/permissions";
import { addDays, toBerlinDate } from "@/core/time";
import { widgetsFor } from "@/core/widgets";
import { MODULES } from "@/modules";
import { WIDGETS } from "@/modules/widgets";
import * as messenger from "@/modules/messenger/actions";
import AdressbuchLayout from "@/app/(shell)/adressbuch/layout";
import MessengerLayout from "@/app/(shell)/messenger/layout";
import GanztagLayout from "@/app/(shell)/ganztag/layout";
import RaeumeLayout from "@/app/(shell)/raeume/layout";
import DruckLayout from "@/app/druck/layout";
import { searchAction } from "@/app/(shell)/_shell/search-actions";
import { createExternalLeader } from "./extern";
import { listOffers, setListFeature } from "./service";

const SEKRETARIAT = "u-sabine.kowalski";
const LEHRKRAFT = "u-jana.brandt";
const CHOR = "g-ag-schulchor";

describe("Ganztag GT-15: externe Leitungen nur im Ganztag", () => {
  let h: DbHandle;
  let ext = "";
  const as = (id: string) => {
    state.userId = id;
  };

  beforeAll(async () => {
    h = await createSeededTestDb();
    state.db = h.db;
    for (const id of ["ganztag", "adressbuch", "messenger", "news"]) await setModuleEnabled(h.db, MODULES.find((m) => m.id === id)!, true);
    await setListFeature(h.db, await loadPermissions(h.db, SEKRETARIAT), CHOR, true);
    const today = toBerlinDate(new Date());
    const r = await createExternalLeader(h.db, await loadPermissions(h.db, SEKRETARIAT), {
      firstName: "Extern",
      lastName: "Chorleitung",
      provider: "Musikverein am Ort",
      groupId: CHOR,
      expiresOn: addDays(today, 30),
      confidentiality: true,
    });
    ext = r.userId;
    // nach Startpasswort und 2FA – sonst hätte das Konto ohnehin keine Rechte
    await h.db.update(users).set({ mustChangePassword: false, twoFactorEnabled: true }).where(eq(users.id, ext));
  }, 60_000);
  afterAll(async () => h?.close());

  it("Rechte: keine Grants der Rolle Personal, keine „group.*“-Rechte der Leitung; Modulfreigabe nur Ganztag", async () => {
    const perms = await loadPermissions(h.db, ext);
    expect(perms.external).toBe(true);
    expect(perms.granted.size).toBe(0);
    expect([...perms.leaderOf]).toEqual([CHOR]);
    // Personal hat sonst z. B. „Bücherei nutzen“ und „Schaden melden“
    expect(hasPermission(perms, "gebaeude.report")).toBe(false);
    expect(hasPermission(perms, "buecherei.use")).toBe(false);
    expect(hasPermission(perms, "group.manage_members", { groupId: CHOR })).toBe(false);
    expect(hasPermission(perms, "group.features", { groupId: CHOR })).toBe(false);
    expect(moduleAllowed(perms, "ganztag")).toBe(true);
    for (const id of ["adressbuch", "messenger", "news", "dateien", "kalender", "hilfe"]) expect(moduleAllowed(perms, id)).toBe(false);
    // andere Konten unverändert
    const teacher = await loadPermissions(h.db, LEHRKRAFT);
    expect(teacher.external).toBeUndefined();
    expect(moduleAllowed(teacher, "adressbuch")).toBe(true);
    // Empfänger nach Recht (Benachrichtigungen an Zuständige) ohne externe Konten
    expect(await usersWithPermission(h.db, "buecherei.use")).not.toContain(ext);
  });

  it("Ganztag bleibt: eigene Angebote, Seiten und Actions des Moduls", async () => {
    const perms = await loadPermissions(h.db, ext);
    expect((await listOffers(h.db, perms)).map((o) => o.id)).toEqual([CHOR]);
    as(ext);
    await expect(GanztagLayout({ children: null })).resolves.toBeNull();
    await expect(moduleActions("ganztag").requireUser()).resolves.toMatchObject({ perms: { userId: ext } });
  });

  it("Adressbuch und Messenger: Seiten 404, Actions verboten – auch direkt aufgerufen", async () => {
    as(ext);
    await expect(AdressbuchLayout({ children: null })).rejects.toThrow("NOT_FOUND");
    await expect(MessengerLayout({ children: null })).rejects.toThrow("NOT_FOUND");
    await expect(RaeumeLayout({ children: null })).rejects.toThrow("NOT_FOUND");
    await expect(DruckLayout({ children: null })).rejects.toThrow("NOT_FOUND");
    await expect(moduleActions("adressbuch").requireUser()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(messenger.findPeopleAction("Brandt")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(messenger.openDirectAction(LEHRKRAFT)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(messenger.sendMessageAction("irgendein-raum", "Hallo")).rejects.toThrow(/externes Konto/);
    // Gegenprobe: die Lehrkraft kommt hin
    as(LEHRKRAFT);
    await expect(AdressbuchLayout({ children: null })).resolves.toBeNull();
    await expect(MessengerLayout({ children: null })).resolves.toBeDefined();
    await expect(messenger.findPeopleAction("Kowalski")).resolves.toBeDefined();
  });

  it("Navigation, Startseite und Suche zeigen nur den Ganztag", async () => {
    const perms = await loadPermissions(h.db, ext);
    const states = await loadModuleStates(h.db);
    const nav = buildNav(MODULES, states, perms).flatMap((g) => g.items);
    expect(nav.length).toBeGreaterThan(0);
    expect(new Set(nav.map((n) => n.moduleId))).toEqual(new Set(["ganztag"]));
    expect(widgetsFor(WIDGETS, MODULES, states, perms).every((w) => w.moduleId === "ganztag")).toBe(true);
    as(ext);
    expect(await searchAction("Brandt")).toEqual([]);
    as(LEHRKRAFT);
    expect((await searchAction("Kowalski")).length).toBeGreaterThan(0);
  });

  it("Gong: nur aus dem Ganztag und Kontohinweise; Live-Strom nur Gong-Ereignisse; API nur Ganztag/Gong/Profilbild/Export", async () => {
    await notify(h.db, [ext, LEHRKRAFT], { moduleId: "news", title: "GT-15 News an alle" });
    await notify(h.db, [ext, LEHRKRAFT], { moduleId: "ganztag", title: "GT-15 Ganztag" });
    const titles = async (id: string) => (await h.db.select({ title: notifications.title }).from(notifications).where(eq(notifications.userId, id))).map((n) => n.title);
    expect(await titles(ext)).toContain("GT-15 Ganztag");
    expect(await titles(ext)).not.toContain("GT-15 News an alle");
    expect(await titles(LEHRKRAFT)).toEqual(expect.arrayContaining(["GT-15 News an alle", "GT-15 Ganztag"]));

    expect(externalLiveEvent({ type: "notification", unread: 1 })).toBe(true);
    expect(externalLiveEvent({ type: "read", unread: 0 })).toBe(true);
    expect(externalLiveEvent({ type: "board", boardId: "b" })).toBe(false);
    expect(externalLiveEvent({ type: "text", docId: "d" })).toBe(false);

    for (const p of ["/api/ganztag/essen", "/api/gong/stream", "/api/profilbild/u-1", "/api/eigenexport"]) expect(externalApiAllowed(p)).toBe(true);
    for (const p of ["/api/dateien/x", "/api/kalender/ics", "/api/texte/x/sync", "/api/raeume/foto/x", "/api/eigenexportx", "/api/ganztag"]) expect(externalApiAllowed(p)).toBe(false);
  });
});
