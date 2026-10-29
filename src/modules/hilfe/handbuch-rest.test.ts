// HB-05…HB-07: Anhänge, Seitenverlauf, Starter-Seiten und Kontexthilfe (Service-Ebene, Demo-Schule).
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { hilfeAttachments, hilfePages, hilfeRevisions, hilfeSections, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { EICAR } from "@/core/files/virus-scan";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { collectPersonalData } from "@/core/privacy/auskunft";
import { referencedStorageKeys, sweepOrphanFiles } from "@/core/privacy/dateispeicher";
import { deleteAccounts } from "@/core/privacy/konto";
import { listUsers, ValidationError } from "@/modules/verwaltung/users";
import {
  ATTACHMENTS_MAX,
  addAttachment,
  attachmentFile,
  checkAttachment,
  deleteAttachment,
  listAttachments,
} from "./attachments";
import { CONTEXT_PAGES, FIRST_STEPS, contextPagesFor, helpHref } from "./context";
import {
  REVISIONS_KEEP,
  createPage,
  createSection,
  deletePage,
  getPage,
  listRevisions,
  restoreRevision,
  slugify,
  STAFF_TARGET_ROLES,
  updatePage,
  visibleSlugs,
  type PageInput,
} from "./service";
import { STARTER_PAGES, STARTER_SECTION, installStarterPages, starterStatus } from "./starter";

/** Feldmeldung (file) eines ValidationError */
const msg = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as ValidationError).fieldErrors.file;
  }
};
const bytes = (s: string) => new TextEncoder().encode(s);
const PDF = bytes("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF");
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6]);
const OLE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

/** Nachgebaute clamd (INSTREAM): EICAR → Fund, sonst OK. */
function fakeClamd(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!buf.toString("latin1").startsWith("zINSTREAM\0")) return;
      let off = 10;
      const parts: Buffer[] = [];
      for (;;) {
        if (buf.length < off + 4) return;
        const len = buf.readUInt32BE(off);
        if (len === 0) break;
        if (buf.length < off + 4 + len) return;
        parts.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
      sock.end(Buffer.concat(parts).toString("latin1").includes("EICAR-STANDARD") ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) })),
  );
}

describe("HB-05: Dateitypen (rein)", () => {
  it("erkennt PDF, Bilder, Office-Container an den Bytes und verlangt eine passende Endung", async () => {
    expect(checkAttachment("Plan.pdf", PDF).mime).toBe("application/pdf");
    expect(checkAttachment("Brief.DOCX", ZIP).mime).toContain("wordprocessingml");
    expect(checkAttachment("Liste.ods", ZIP).mime).toContain("opendocument.spreadsheet");
    expect(checkAttachment("alt.xls", OLE).mime).toBe("application/vnd.ms-excel");
    const png = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).png().toBuffer());
    expect(checkAttachment("bild.png", png).mime).toBe("image/png");
    // Endung passt nicht zum Inhalt
    expect(() => checkAttachment("bild.pdf", png)).toThrow(ValidationError);
    expect(() => checkAttachment("brief.docx", PDF)).toThrow(ValidationError);
    expect(() => checkAttachment("brief.pdf", ZIP)).toThrow(ValidationError);
    // nicht erlaubt: ausführbar, Skript, HTML, SVG, Makro-Office, Vererbungs-Schlüssel der Typtabelle
    expect(() => checkAttachment("spiel.exe", bytes("MZ\u0090\u0000"))).toThrow(ValidationError);
    expect(() => checkAttachment("seite.html", bytes("<script>alert(1)</script>"))).toThrow(ValidationError);
    expect(() => checkAttachment("bild.svg", bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toThrow(ValidationError);
    expect(() => checkAttachment("makro.docm", ZIP)).toThrow(ValidationError);
    expect(() => checkAttachment("constructor", ZIP)).toThrow(ValidationError);
    expect(() => checkAttachment("leer.pdf", new Uint8Array())).toThrow(ValidationError);
    expect(msg(() => checkAttachment("gross.pdf", new Uint8Array(21 * 1024 * 1024)))).toMatch(/zu groß/);
  });
});

describe("HB-05/06/07: Handbuch (Demo-Schule)", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  let mutter: string;
  let sectionId: string;
  const p = (id: string) => loadPermissions(h.db, id);
  const SEK = "u-sabine.kowalski"; // Verwaltung: hilfe.edit + hilfe.manage
  const input = (over: Partial<PageInput> = {}): PageInput => ({
    sectionId,
    title: "Seite",
    body: "Text",
    status: "veroeffentlicht",
    contactId: null,
    targetRoles: [],
    targetGroupIds: [],
    ...over,
  });
  const files = async () => (await storage.list()).length;

  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-hilfe-"));
    storage = localStorage(dir);
    mutter = (await listUsers(h.db, { q: "Daniela Schäfer" })).rows[0]!.id;
    sectionId = await createSection(h.db, await p(SEK), "Anhang-Bereich");
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("Anhänge: Pflegende und Ansprechperson dürfen, andere nicht; Sichtbarkeit folgt der Seite", async () => {
    const slug = await createPage(h.db, await p(SEK), input({ title: "Mit Anhang", contactId: "u-frank.schulte", targetRoles: ["eltern"] }));
    const page = (await getPage(h.db, await p(SEK), slug))!;
    const frank = await p("u-frank.schulte");
    const id = await addAttachment(h.db, storage, frank, page.id, { name: "Elternbrief.pdf", data: PDF });
    await addAttachment(h.db, storage, await p(SEK), page.id, { name: "Plan.docx", data: ZIP });
    expect(await files()).toBe(2);
    // Dritte Personen: nein
    await expect(addAttachment(h.db, storage, await p("u-jana.brandt"), page.id, { name: "x.pdf", data: PDF })).rejects.toThrow(ForbiddenError);
    await expect(addAttachment(h.db, storage, await p(mutter), page.id, { name: "x.pdf", data: PDF })).rejects.toThrow(ForbiddenError);
    await expect(deleteAttachment(h.db, storage, await p(mutter), id)).rejects.toThrow(ForbiddenError);
    // Sichtbarkeit: Eltern ja; Schülerin und Lehrkraft (nicht in der Zielgruppe) nein
    expect((await listAttachments(h.db, await p(mutter), page.id)).map((a) => a.name)).toEqual(["Elternbrief.pdf", "Plan.docx"]);
    expect(await attachmentFile(h.db, await p(mutter), id)).toMatchObject({ name: "Elternbrief.pdf", mime: "application/pdf", size: PDF.length });
    expect(await listAttachments(h.db, await p("u-lea.schaefer"), page.id)).toEqual([]);
    expect(await attachmentFile(h.db, await p("u-lea.schaefer"), id)).toBeNull();
    expect(await attachmentFile(h.db, await p("u-jana.brandt"), id)).toBeNull();
    // Entwurf: für Eltern weg, für Ansprechperson und Pflegende da
    await updatePage(h.db, await p(SEK), page.id, input({ title: "Mit Anhang", contactId: "u-frank.schulte", targetRoles: ["eltern"], status: "entwurf" }));
    expect(await attachmentFile(h.db, await p(mutter), id)).toBeNull();
    expect(await attachmentFile(h.db, frank, id)).not.toBeNull();
    // Löschen: Datensatz und Datei
    await deleteAttachment(h.db, storage, frank, id);
    expect(await files()).toBe(1);
    expect((await listAttachments(h.db, frank, page.id)).map((a) => a.name)).toEqual(["Plan.docx"]);
    // Seite löschen nimmt die übrigen Dateien mit
    await deletePage(h.db, await p(SEK), page.id, storage);
    expect(await files()).toBe(0);
    expect(await h.db.select().from(hilfeAttachments).where(eq(hilfeAttachments.pageId, page.id))).toEqual([]);
  });

  it("Anhänge: höchstens 10 je Seite, falscher Typ legt nichts ab, Namen werden bereinigt, Dateispeicher-Abgleich kennt sie", async () => {
    const sek = await p(SEK);
    const slug = await createPage(h.db, sek, input({ title: "Grenzen" }));
    const page = (await getPage(h.db, sek, slug))!;
    const before = await files();
    await expect(addAttachment(h.db, storage, sek, page.id, { name: "virus.exe", data: bytes("MZ") })).rejects.toThrow(ValidationError);
    expect(await files()).toBe(before);
    for (let i = 0; i < ATTACHMENTS_MAX; i++) await addAttachment(h.db, storage, sek, page.id, { name: `../Datei ${i}?.pdf`, data: PDF });
    await expect(addAttachment(h.db, storage, sek, page.id, { name: "elf.pdf", data: PDF })).rejects.toMatchObject({ fieldErrors: { file: expect.stringMatching(/Höchstens 10/) } });
    const list = await listAttachments(h.db, sek, page.id);
    expect(list).toHaveLength(ATTACHMENTS_MAX);
    expect(list[0]!.name).toBe(".._Datei 0_.pdf");
    // Dateispeicher-Abgleich: referenzierte Dateien bleiben, eine verwaiste geht (nach der Karenzzeit)
    const known = await referencedStorageKeys(h.db);
    for (const f of await storage.list()) expect(known.has(f.key)).toBe(true);
    const orphan = crypto.randomUUID();
    await storage.put(orphan, PDF);
    expect(await sweepOrphanFiles(h.db, storage, new Date(Date.now() + 2 * 3600_000))).toBe(1);
    expect(await files()).toBe(before + ATTACHMENTS_MAX);
  });

  it("Anhänge: Virenscan – Fund und nicht erreichbarer Scanner legen nichts ab, saubere Datei geht", async () => {
    const sek = await p(SEK);
    const page = (await getPage(h.db, sek, await createPage(h.db, sek, input({ title: "Scan" }))))!;
    const clamd = await fakeClamd();
    const before = process.env.SCHULOS_CLAMAV;
    try {
      process.env.SCHULOS_CLAMAV = `127.0.0.1:${clamd.port}`;
      const n = await files();
      await expect(addAttachment(h.db, storage, sek, page.id, { name: "eicar.pdf", data: bytes(`%PDF-1.4\n${EICAR}`) })).rejects.toMatchObject({
        fieldErrors: { file: expect.stringContaining("Schadsoftware") },
      });
      expect(await files()).toBe(n);
      await addAttachment(h.db, storage, sek, page.id, { name: "sauber.pdf", data: PDF });
      expect(await files()).toBe(n + 1);
      process.env.SCHULOS_CLAMAV = "127.0.0.1:1";
      await expect(addAttachment(h.db, storage, sek, page.id, { name: "zwei.pdf", data: PDF })).rejects.toMatchObject({ fieldErrors: { file: expect.stringMatching(/Virenscan nicht erreichbar/) } });
      expect(await files()).toBe(n + 1);
    } finally {
      if (before === undefined) delete process.env.SCHULOS_CLAMAV;
      else process.env.SCHULOS_CLAMAV = before;
      await clamd.close();
    }
  });

  it("Verlauf: Ändern von Titel/Text legt die bisherige Fassung ab, Prüfen und reine Zielgruppenänderung nicht", async () => {
    const sek = await p(SEK);
    const slug = await createPage(h.db, sek, input({ title: "Verlaufsseite", body: "Eins", contactId: "u-frank.schulte" }));
    const page = (await getPage(h.db, sek, slug))!;
    expect(await listRevisions(h.db, sek, page.id)).toEqual([]);
    await updatePage(h.db, sek, page.id, input({ title: "Verlaufsseite", body: "Zwei", contactId: "u-frank.schulte" }));
    await updatePage(h.db, sek, page.id, input({ title: "Verlaufsseite", body: "Zwei", contactId: "u-frank.schulte", targetRoles: ["eltern"] }));
    const frank = await p("u-frank.schulte");
    await updatePage(h.db, frank, page.id, input({ title: "Verlaufsseite neu", body: "Drei", contactId: "u-frank.schulte" }));
    const revs = await listRevisions(h.db, sek, page.id);
    expect(revs.map((r) => [r.title, r.body])).toEqual([
      ["Verlaufsseite", "Zwei"],
      ["Verlaufsseite", "Eins"],
    ]);
    expect(revs[0]!.authorName).toBeTruthy();
    // nur Pflegende sehen und stellen wieder her – auch die Ansprechperson nicht
    await expect(listRevisions(h.db, frank, page.id)).rejects.toThrow(ForbiddenError);
    await expect(restoreRevision(h.db, frank, revs[1]!.id)).rejects.toThrow(ForbiddenError);
    await expect(restoreRevision(h.db, await p("u-jana.brandt"), revs[1]!.id)).rejects.toThrow(ForbiddenError);

    // Wiederherstellen: Titel/Text der Fassung sind aktuell, der Stand davor kommt in den Verlauf, Adresse/Status/Zielgruppen bleiben
    expect(await restoreRevision(h.db, sek, revs[1]!.id, "2031-05-05")).toBe(slug);
    const after = (await getPage(h.db, sek, slug))!;
    expect(after).toMatchObject({ title: "Verlaufsseite", body: "Eins", status: "veroeffentlicht", reviewedOn: "2031-05-05" });
    expect(after.targetRoles).toEqual(["eltern"]);
    const again = await listRevisions(h.db, sek, page.id);
    expect(again.map((r) => r.body)).toEqual(["Drei", "Zwei", "Eins"]);
    // dieselbe Fassung noch einmal wiederherstellen ändert nichts und häuft keine Duplikate an
    await restoreRevision(h.db, sek, revs[1]!.id);
    expect(await listRevisions(h.db, sek, page.id)).toHaveLength(3);
    // gelöschte Fassung
    await expect(restoreRevision(h.db, sek, "gibt-es-nicht")).rejects.toThrow(ValidationError);
  });

  it("Verlauf: nur die letzten 20 Fassungen bleiben (neueste zuerst), Verlauf geht mit der Seite", async () => {
    const sek = await p(SEK);
    const slug = await createPage(h.db, sek, input({ title: "Kappung", body: "v0" }));
    const page = (await getPage(h.db, sek, slug))!;
    expect(REVISIONS_KEEP).toBe(20);
    for (let i = 1; i <= 25; i++) await updatePage(h.db, sek, page.id, input({ title: "Kappung", body: `v${i}` }));
    const revs = await listRevisions(h.db, sek, page.id);
    expect(revs).toHaveLength(20);
    expect(revs[0]!.body).toBe("v24");
    expect(revs.at(-1)!.body).toBe("v5");
    await deletePage(h.db, sek, page.id, storage);
    expect(await h.db.select().from(hilfeRevisions).where(eq(hilfeRevisions.pageId, page.id))).toEqual([]);
  });

  it("Starter-Seiten: Adressen stimmen mit den Titeln, idempotent angelegt, sichtbar für die Zielgruppen, Eigenseiten bleiben Personal", async () => {
    for (const s of STARTER_PAGES) expect(s.slug).toBe(slugify(s.title));
    expect(STARTER_PAGES.length).toBeLessThanOrEqual(8);
    // jede Starter-Seite, auf die die kontextbezogene Hilfe zeigt, gibt es
    const slugs = new Set(STARTER_PAGES.map((s) => s.slug));
    for (const slug of [...Object.values(CONTEXT_PAGES), ...Object.values(FIRST_STEPS)]) expect(slugs.has(slug!)).toBe(true);
    // jeder interne Link in den Texten zeigt auf eine Starter-Seite
    for (const s of STARTER_PAGES) for (const m of s.body.matchAll(/\]\(\/hilfe\/([a-z0-9-]+)\)/g)) expect(slugs.has(m[1]!)).toBe(true);

    const sek = await p(SEK);
    // Demo enthält sie schon; erst entfernen, dann installieren
    expect((await starterStatus(h.db)).missing).toHaveLength(0);
    expect(await installStarterPages(h.db, sek)).toEqual([]);
    for (const s of STARTER_PAGES) await deletePage(h.db, sek, (await getPage(h.db, sek, s.slug))!.id, storage);
    expect((await starterStatus(h.db)).missing).toHaveLength(STARTER_PAGES.length);
    await expect(installStarterPages(h.db, await p("u-jana.brandt"))).rejects.toThrow(ForbiddenError);

    expect(await installStarterPages(h.db, sek, "2031-01-02")).toEqual(STARTER_PAGES.map((s) => s.title));
    expect(await installStarterPages(h.db, sek)).toEqual([]);
    const sections = (await h.db.select().from(hilfeSections)).filter((s) => s.title === STARTER_SECTION);
    expect(sections).toHaveLength(1);
    // zweiter Lauf nach Umbenennung: die Seite bleibt unter ihrer Adresse, nichts wird doppelt
    const krank = (await getPage(h.db, sek, "krankmeldung"))!;
    await updatePage(h.db, sek, krank.id, input({ sectionId: krank.sectionId, title: "Krank melden bei uns", body: "angepasst", targetRoles: ["eltern", "schueler"] }));
    expect(await installStarterPages(h.db, sek)).toEqual([]);
    expect((await getPage(h.db, sek, "krankmeldung"))!.title).toBe("Krank melden bei uns");

    const visible = async (id: string) => [...(await visibleSlugs(h.db, await p(id), [...slugs]))].sort();
    expect(await visible(mutter)).toEqual(
      ["erste-schritte-fuer-eltern", "krankmeldung", "kurswahl", "passwort-vergessen", "zwei-faktor-anmeldung-einrichten"].sort(),
    );
    expect(await visible("u-lea.schaefer")).toEqual(
      ["erste-schritte-fuer-schuelerinnen-und-schueler", "krankmeldung", "kurswahl", "passwort-vergessen", "zwei-faktor-anmeldung-einrichten"].sort(),
    );
    expect(await visible("u-jana.brandt")).toEqual(["erste-schritte-fuer-lehrkraefte-und-personal", "passwort-vergessen", "zwei-faktor-anmeldung-einrichten"].sort());
    // eigene Seiten: Vorgabe Personal – im Formular, hier die Konstante
    expect(STAFF_TARGET_ROLES).not.toContain("eltern");
    expect(STAFF_TARGET_ROLES).not.toContain("schueler");
  });

  it("Kontexthilfe: Modulpfad → Starter-Seite je Rolle; unsichtbare Zuordnung fällt auf das Handbuch zurück", async () => {
    expect(helpHref("/abwesenheiten", CONTEXT_PAGES)).toBe("/hilfe/krankmeldung");
    expect(helpHref("/kurswahl/abc", CONTEXT_PAGES)).toBe("/hilfe/kurswahl");
    expect(helpHref("/konto/email", CONTEXT_PAGES)).toBe("/hilfe/zwei-faktor-anmeldung-einrichten");
    expect(helpHref("/", contextPagesFor("eltern"))).toBe("/hilfe");
    expect(helpHref("/elternbriefe", contextPagesFor("eltern"))).toBe("/hilfe/erste-schritte-fuer-eltern");
    expect(helpHref("/news", contextPagesFor("schueler"))).toBe("/hilfe/erste-schritte-fuer-schuelerinnen-und-schueler");
    expect(helpHref("/stundenplan", contextPagesFor("lehrkraft"))).toBe("/hilfe/erste-schritte-fuer-lehrkraefte-und-personal");
    expect(helpHref("/foren", contextPagesFor("eltern"))).toBe("/hilfe");
    // Sichtbarkeit: eine Lehrkraft sieht „Krankmeldung“ nicht → „?“ führt auf /hilfe (Shell filtert mit visibleSlugs)
    const jana = await p("u-jana.brandt");
    const seen = await visibleSlugs(h.db, jana, Object.values(contextPagesFor("lehrkraft")));
    const pages = Object.fromEntries(Object.entries(contextPagesFor("lehrkraft")).filter(([, s]) => seen.has(s)));
    expect(helpHref("/abwesenheiten", pages)).toBe("/hilfe");
    expect(helpHref("/news", pages)).toBe("/hilfe/erste-schritte-fuer-lehrkraefte-und-personal");
  });

  it("Kontolöschung: Anhänge und Fassungen bleiben, Verweise auf die Person werden geleert; Auskunft nennt Upload und eigene Fassungen", async () => {
    const lk = (await listUsers(h.db, { role: "lehrkraft" })).rows.find((u) => !["u-jana.brandt", "u-frank.schulte"].includes(u.id))!.id;
    const sek = await p(SEK);
    const slug = await createPage(h.db, sek, input({ title: "Seite der Lehrkraft", contactId: lk, targetRoles: STAFF_TARGET_ROLES }));
    const page = (await getPage(h.db, sek, slug))!;
    const lkPerms = await p(lk);
    await addAttachment(h.db, storage, lkPerms, page.id, { name: "Aushang.pdf", data: PDF });
    await updatePage(h.db, lkPerms, page.id, input({ title: "Seite der Lehrkraft", body: "von ihr", contactId: lk }));
    await updatePage(h.db, sek, page.id, input({ title: "Seite der Lehrkraft", body: "von der Verwaltung", contactId: lk, targetRoles: STAFF_TARGET_ROLES }));

    const data = await collectPersonalData(h.db, lk);
    // Anhang: nur die Handlung (Seite, Dateiname), die Datei gehört zur Seite; Fassungen, die die Person geschrieben hat: ganz
    expect(data!.files).toEqual([]);
    expect(data!.sections.find((s) => s.table === "hilfe_attachments")).toMatchObject({ asActor: true, rows: [expect.objectContaining({ name: "Aushang.pdf" })] });
    expect(data!.sections.find((s) => s.table === "hilfe_revisions" && !s.asActor)?.rows.map((r) => r.body)).toEqual(["von ihr"]);

    await deleteAccounts(h.db, [lk]);
    expect(await h.db.select().from(users).where(eq(users.id, lk))).toEqual([]);
    const [att] = await h.db.select().from(hilfeAttachments).where(eq(hilfeAttachments.pageId, page.id));
    expect(att).toMatchObject({ name: "Aushang.pdf", uploadedBy: null });
    const revs = await h.db.select().from(hilfeRevisions).where(eq(hilfeRevisions.pageId, page.id));
    expect(revs.length).toBe(2);
    expect(revs.filter((r) => r.authorId === null).map((r) => r.body)).toEqual(["von ihr"]);
    expect((await h.db.select().from(hilfePages).where(eq(hilfePages.id, page.id)))[0]!.contactId).toBeNull();
  });
});
