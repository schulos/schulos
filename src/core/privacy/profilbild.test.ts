import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DbHandle } from "@/core/db/client";
import { auditLog, parentChild, profilePhotos, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { loadPermissions, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { deleteAccounts } from "./konto";
import { sweepOrphanFiles } from "./dateispeicher";
import { ascii, bytes, JPEG, PNG, WEBP_VP8 } from "@/core/images.fixtures";
import { cleanPhoto, consentAuthority, photoSubjects, removeProfilePhoto, setProfilePhoto } from "./profilbild";

describe("Profilbild: Bilddaten", () => {
  it("nur JPEG und PNG bis 2 MB – WebP und SVG nicht, Metadaten fallen weg (Bild-Baustein src/core/images.ts)", () => {
    expect(cleanPhoto(JPEG).mime).toBe("image/jpeg");
    expect(ascii(cleanPhoto(JPEG).data)).not.toContain("Exif");
    expect(cleanPhoto(PNG).mime).toBe("image/png");
    expect(() => cleanPhoto(WEBP_VP8)).toThrow(ValidationError);
    expect(() => cleanPhoto(new Uint8Array())).toThrow(ValidationError);
    expect(() => cleanPhoto(new Uint8Array(3 * 1024 * 1024).fill(0xff))).toThrow(ValidationError);
    expect(() => cleanPhoto(bytes("<svg onload=alert(1)>"))).toThrow(ValidationError);
    expect(() => cleanPhoto(JPEG.subarray(0, 12))).toThrow(ValidationError);
  });
});

describe("Profilbild: Einwilligung (Demo-Schule)", () => {
  let h: DbHandle;
  let storage: FileStorage;
  let dir: string;
  let parent: string;
  let child: string;
  const perms = (id: string): Promise<PermissionSet> => loadPermissions(h.db, id);
  const today = "2026-10-04";

  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-photo-"));
    storage = localStorage(dir);
    const [link] = await h.db.select().from(parentChild).limit(1);
    parent = link!.parentId;
    child = link!.childId;
  });
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("Befugnis: Lehrkraft für sich, Eltern fürs Kind, Verwaltung schriftlich; Schüler:in nicht für sich", async () => {
    const t = { id: "u-jana.brandt", role: "lehrkraft" };
    const s = { id: child, role: "schueler" };
    expect(consentAuthority(await perms("u-jana.brandt"), t, false)).toBe("self");
    expect(consentAuthority(await perms("u-jana.brandt"), s, false)).toBeNull();
    expect(consentAuthority(await perms(parent), s, true)).toBe("parent");
    expect(consentAuthority(await perms(child), s, false)).toBeNull();
    expect(consentAuthority(await perms("u-sabine.kowalski"), s, false)).toBe("paper");
  });

  it("ohne Häkchen keine Speicherung; mit Einwilligung Foto ohne EXIF, Audit als Nachweis", async () => {
    const p = await perms(parent);
    await expect(setProfilePhoto(h.db, storage, p, child, { bytes: JPEG, consent: false }, today)).rejects.toThrow(ValidationError);
    expect(await storage.list()).toHaveLength(0);
    await setProfilePhoto(h.db, storage, p, child, { bytes: JPEG, consent: true }, today);
    const [row] = await h.db.select().from(profilePhotos).where(eq(profilePhotos.userId, child));
    expect(row).toMatchObject({ consentBasis: "parent", consentBy: parent, consentOn: today, mime: "image/jpeg" });
    const stored = new Uint8Array(await new Response(await storage.get(row!.storageKey)).arrayBuffer());
    expect(ascii(stored)).not.toContain("Exif");
    const [log] = await h.db.select().from(auditLog).where(eq(auditLog.action, "profilbild.einwilligung"));
    expect(log).toMatchObject({ actorId: parent, target: child, meta: { basis: "parent", consentOn: today } });
  });

  it("Seite „Profilbild“: Eltern sehen ihre Kinder, Schüler:in sieht ihr Foto und darf widerrufen", async () => {
    const forParent = await photoSubjects(h.db, await perms(parent));
    expect(forParent.find((x) => x.id === child)).toMatchObject({ basis: "parent", canWithdraw: true });
    expect(forParent.some((x) => x.own)).toBe(false);
    const [mine] = await photoSubjects(h.db, await perms(child));
    expect(mine).toMatchObject({ own: true, basis: null, canWithdraw: true });
    expect(mine!.url).toMatch(/^\/api\/profilbild\//);
  });

  it("fremde Personen dürfen weder hinterlegen noch widerrufen", async () => {
    const other = await perms("u-jana.brandt");
    await expect(setProfilePhoto(h.db, storage, other, child, { bytes: JPEG, consent: true }, today)).rejects.toThrow(ValidationError);
    await expect(removeProfilePhoto(h.db, storage, other, child)).rejects.toThrow(ValidationError);
  });

  it("Widerruf durch die Schüler:in löscht Zeile und Datei sofort", async () => {
    const [row] = await h.db.select().from(profilePhotos).where(eq(profilePhotos.userId, child));
    expect(await removeProfilePhoto(h.db, storage, await perms(child), child)).toBe(true);
    expect(await h.db.select().from(profilePhotos).where(eq(profilePhotos.userId, child))).toEqual([]);
    expect(await storage.get(row!.storageKey)).toBeNull();
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "profilbild.widerruf"))).toHaveLength(1);
  });

  it("Verwaltung: schriftliche Einwilligung braucht ein Datum, nicht in der Zukunft; Austausch ersetzt die Datei", async () => {
    const office = await perms("u-sabine.kowalski");
    await expect(setProfilePhoto(h.db, storage, office, child, { bytes: PNG, consent: true }, today)).rejects.toThrow(ValidationError);
    await expect(setProfilePhoto(h.db, storage, office, child, { bytes: PNG, consent: true, consentOn: "2026-12-01" }, today)).rejects.toThrow(
      ValidationError,
    );
    await setProfilePhoto(h.db, storage, office, child, { bytes: PNG, consent: true, consentOn: "2026-09-01" }, today);
    await setProfilePhoto(h.db, storage, office, child, { bytes: JPEG, consent: true, consentOn: "2026-09-02" }, today);
    const rows = await h.db.select().from(profilePhotos).where(eq(profilePhotos.userId, child));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ consentBasis: "paper", consentOn: "2026-09-02", mime: "image/jpeg" });
    expect((await storage.list()).map((f) => f.key)).toEqual([rows[0]!.storageKey]);
  });

  it("Kontolöschung nimmt das Foto mit; der Dateispeicher räumt die Datei auf", async () => {
    const [u] = await h.db.insert(users).values({ id: "u-foto.test", name: "Foto Test", email: "foto@t", role: "lehrkraft" }).returning();
    await setProfilePhoto(h.db, storage, await perms(u!.id), u!.id, { bytes: JPEG, consent: true }, today);
    const [row] = await h.db.select().from(profilePhotos).where(eq(profilePhotos.userId, u!.id));
    await deleteAccounts(h.db, [u!.id]);
    expect(await h.db.select().from(profilePhotos).where(eq(profilePhotos.userId, u!.id))).toEqual([]);
    await sweepOrphanFiles(h.db, storage, new Date(Date.now() + 2 * 3600_000));
    expect(await storage.get(row!.storageKey)).toBeNull();
  });
});
