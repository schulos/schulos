import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { listNotifications } from "@/core/notifications";
import { loadPermissions } from "@/core/permissions";
import { listUsers } from "@/modules/verwaltung/users";
import { ValidationError } from "@/modules/verwaltung/users";
import { createPost, deletePost, getPost, listPosts, resolveAudience, updatePost } from "./service";

describe("News", () => {
  let h: DbHandle;
  let mutter: string;
  let fremdesKind: string;
  beforeAll(async () => {
    h = await createSeededTestDb();
    mutter = (await listUsers(h.db, { q: "Daniela Schäfer" })).rows[0]!.id;
    fremdesKind = (await listUsers(h.db, { groupId: "g-9a", role: "schueler" })).rows[0]!.id;
  }, 60_000);
  afterAll(() => h.close());
  const p = (id: string) => loadPermissions(h.db, id);
  const titles = async (id: string) => (await listPosts(h.db, await p(id))).map((x) => x.id);

  it("Angeheftetes zuerst, dann neueste", async () => {
    expect((await titles("u-jana.brandt"))[0]).toBe("news-herbstferien");
  });

  it("Zielgruppen: Klasse 7b sieht den Elternabend, 9a nicht; Eltern über ihr Kind", async () => {
    expect(await titles("u-lea.schaefer")).toContain("news-elternabend-7b");
    expect(await titles(fremdesKind)).not.toContain("news-elternabend-7b");
    expect(await titles(mutter)).toContain("news-elternabend-7b");
    expect(await titles(mutter)).toContain("news-herbstferien"); // Rolle Eltern
    expect(await titles("u-lea.schaefer")).not.toContain("news-herbstferien"); // nur Eltern + LK
    expect(await titles(fremdesKind)).toContain("news-mensa"); // an alle
  });

  it("Schulleitung (news.manage über Gruppe) sieht alles", async () => {
    expect(await titles("u-petra.lindner")).toHaveLength(4);
  });

  it("Volltextsuche mit deutscher Stammform", async () => {
    const hits = await listPosts(h.db, await p(mutter), { q: "herbstferie anmeldung" });
    expect(hits.map((x) => x.id)).toEqual(["news-herbstferien"]);
  });

  it("Lehrkraft schreibt an eine Gruppe, darf nicht anheften; Gong an Mitglieder + Eltern", async () => {
    const lk = await p("u-daniel.okafor");
    const id = await createPost(h.db, lk, { title: "Bio-Exkursion", body: "Treffpunkt 8 Uhr", pinned: true, targetGroupIds: ["g-7b"], notify: true });
    const post = await getPost(h.db, lk, id);
    expect(post?.pinned).toBe(false);
    expect(post?.targets).toEqual(["Klasse 7b"]);
    expect((await listNotifications(h.db, "u-lea.schaefer"))[0]?.title).toBe("Bio-Exkursion");
    expect((await listNotifications(h.db, mutter))[0]?.href).toBe(`/news/${id}`);
    expect(await listNotifications(h.db, fremdesKind)).toEqual([]);
    expect(await listNotifications(h.db, "u-daniel.okafor")).toEqual([]);
  });

  it("Bearbeiten/Löschen nur Autor:in oder news.manage; Schüler:innen dürfen nicht schreiben", async () => {
    const lea = await p("u-lea.schaefer");
    await expect(createPost(h.db, lea, { title: "x", body: "y" })).rejects.toThrow(ValidationError);
    const fremd = await p("u-henrik.albers"); // KLE wäre stellv. Schulleitung (news.manage)
    await expect(updatePost(h.db, fremd, "news-elternabend-7b", { title: "gehackt", body: "x" })).rejects.toThrow(ValidationError);
    const sl = await p("u-petra.lindner");
    await updatePost(h.db, sl, "news-mensa", { title: "Speiseplan", body: "neu", pinned: true });
    expect((await getPost(h.db, sl, "news-mensa"))?.pinned).toBe(true);
    await deletePost(h.db, sl, "news-mensa");
    expect(await getPost(h.db, sl, "news-mensa")).toBeNull();
  });

  it("Abgelaufene Beiträge verschwinden aus der Liste", async () => {
    const lk = await p("u-jana.brandt");
    const id = await createPost(h.db, lk, { title: "Kurzlebig", body: "x", expiresAt: new Date(Date.now() + 60_000) });
    expect(await titles("u-jana.brandt")).toContain(id);
    const later = await listPosts(h.db, lk, { now: new Date(Date.now() + 120_000) });
    expect(later.map((x) => x.id)).not.toContain(id);
  });

  it("validiert", async () => {
    const lk = await p("u-jana.brandt");
    await expect(createPost(h.db, lk, { title: " ", body: "x" })).rejects.toThrow(ValidationError);
    await expect(createPost(h.db, lk, { title: "x", body: "y", expiresAt: new Date(2000, 0, 1) })).rejects.toThrow(ValidationError);
  });

  it("Publikum „an alle“ = alle aktiven Konten", async () => {
    expect((await resolveAudience(h.db, {})).length).toBeGreaterThan(600);
  });
});
