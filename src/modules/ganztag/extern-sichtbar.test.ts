// GT-16 (Projektleitung 04.11.2026): Externe Ganztags-Leitungen (befristetes Konto, `users.expires_on`) lesen weder Adressbuch noch
// Messenger – deshalb stehen sie auch nicht im Adressbuch, in der Messenger-Empfängerwahl und in anderen Personen-/Empfängerauswahlen
// außerhalb des Ganztags (Ansprechpersonen im Handbuch, Raumverantwortliche, Umfrage- und News-Zielgruppen). Serverseitig: ein
// Direktchat mit einem externen Konto wird abgelehnt, auch in einem schon bestehenden Chat geht nichts mehr an sie. Im Ganztag
// (Angebote, Leitung) bleiben sie sichtbar.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { chatMembers, chatRooms, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { internalAccount, isExternalAccount, loadPermissions, withoutExternalAccounts } from "@/core/permissions";
import { addDays, toBerlinDate } from "@/core/time";
import { getGroupProfile, getPersonProfile, searchPeople, visiblePeople } from "@/modules/adressbuch/service";
import { contactCandidates } from "@/modules/hilfe/service";
import { directPartnerBlock, EXTERNAL_PARTNER_BLOCK, openDirectRoom, sendMessage } from "@/modules/messenger/service";
import { resolveAudience as newsAudience } from "@/modules/news/service";
import { createSurvey, resolveAudience as surveyAudience } from "@/modules/umfragen/service";
import { addResponsible, responsibleCandidates } from "@/modules/verwaltung/raumverantwortliche";
import { ValidationError } from "@/modules/verwaltung/users";
import { createExternalLeader } from "./extern";
import { getOffer, listOffers, setListFeature } from "./service";

const ADMIN = "u-admin";
const SEKRETARIAT = "u-sabine.kowalski";
const LEHRKRAFT = "u-jana.brandt";
const HAUSMEISTER = "u-klaus.berger";
const SCHUELERIN = "u-lea.schaefer";
const CHOR = "g-ag-schulchor";

describe("Ganztag GT-16: externe Leitungen nicht im Adressbuch und in Empfängerauswahlen", () => {
  let h: DbHandle;
  let ext = "";
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    await setListFeature(h.db, await p(SEKRETARIAT), CHOR, true);
    const r = await createExternalLeader(h.db, await p(SEKRETARIAT), {
      firstName: "Extern",
      lastName: "Chorleitung",
      provider: "Musikverein am Ort",
      groupId: CHOR,
      expiresOn: addDays(toBerlinDate(new Date()), 30),
      confidentiality: true,
    });
    ext = r.userId;
    await h.db.update(users).set({ mustChangePassword: false, twoFactorEnabled: true }).where(eq(users.id, ext));
  }, 60_000);
  afterAll(async () => h?.close());

  it("zentrale Hilfen: internalAccount, withoutExternalAccounts, isExternalAccount", async () => {
    expect(await isExternalAccount(h.db, ext)).toBe(true);
    expect(await isExternalAccount(h.db, LEHRKRAFT)).toBe(false);
    expect(await withoutExternalAccounts(h.db, [LEHRKRAFT, ext, HAUSMEISTER])).toEqual([LEHRKRAFT, HAUSMEISTER]);
    expect(await withoutExternalAccounts(h.db, [])).toEqual([]);
    const internal = await h.db.select({ id: users.id }).from(users).where(internalAccount());
    expect(internal.map((u) => u.id)).toContain(LEHRKRAFT);
    expect(internal.map((u) => u.id)).not.toContain(ext);
  });

  it("Adressbuch: weder Suche noch Profil noch Gruppenprofil zeigen die externe Leitung – für Lehrkraft, Personal, Admin", async () => {
    for (const viewer of [LEHRKRAFT, HAUSMEISTER, ADMIN, SEKRETARIAT]) {
      const perms = await p(viewer);
      expect((await searchPeople(h.db, perms, "Chorleitung", 30)).map((x) => x.id), viewer).not.toContain(ext);
      expect(await getPersonProfile(h.db, perms, ext), viewer).toBeNull();
    }
    const group = await getGroupProfile(h.db, await p(LEHRKRAFT), CHOR);
    expect(group).not.toBeNull();
    expect(group!.members.map((m) => m.id)).not.toContain(ext);
    expect(group!.members.length).toBeGreaterThan(0);
    // Gegenprobe: interne Personen bleiben sichtbar, die externe Leitung sieht sich selbst (Profilbild)
    expect((await searchPeople(h.db, await p(LEHRKRAFT), "Berger")).map((x) => x.id)).toContain(HAUSMEISTER);
    const self = await h.db.select({ id: users.id }).from(users).where(await visiblePeople(h.db, await p(ext)));
    expect(self.map((u) => u.id)).toContain(ext);
  });

  it("Messenger: kein Direktchat mit externen Konten – auch nicht per ID; bestehender Chat nimmt nichts mehr an", async () => {
    const teacher = await p(LEHRKRAFT);
    await expect(openDirectRoom(h.db, teacher, ext)).rejects.toBeInstanceOf(ValidationError);
    await expect(openDirectRoom(h.db, await p(HAUSMEISTER), ext)).rejects.toBeInstanceOf(ValidationError);
    // ein Chat aus der Zeit vor GT-16
    const [room] = await h.db
      .insert(chatRooms)
      .values({ kind: "direct", directKey: [LEHRKRAFT, ext].sort().join("|") })
      .returning({ id: chatRooms.id });
    await h.db.insert(chatMembers).values([
      { roomId: room!.id, userId: LEHRKRAFT },
      { roomId: room!.id, userId: ext },
    ]);
    expect(await directPartnerBlock(h.db, teacher, room!.id)).toBe(EXTERNAL_PARTNER_BLOCK);
    await expect(sendMessage(h.db, teacher, room!.id, "Hallo")).rejects.toThrow(ValidationError);
    await expect(openDirectRoom(h.db, teacher, ext)).rejects.toBeInstanceOf(ValidationError);
    // Gegenprobe: zwischen internen Konten geht es weiter
    const ok = await openDirectRoom(h.db, teacher, HAUSMEISTER);
    await expect(sendMessage(h.db, teacher, ok, "Hallo")).resolves.toMatchObject({ body: "Hallo" });
  });

  it("weitere Auswahlen: Ansprechpersonen im Handbuch, Raumverantwortliche", async () => {
    expect((await contactCandidates(h.db)).map((c) => c.id)).not.toContain(ext);
    expect((await contactCandidates(h.db)).map((c) => c.id)).toContain(HAUSMEISTER);
    expect((await responsibleCandidates(h.db)).people.map((c) => c.id)).not.toContain(ext);
    await expect(addResponsible(h.db, await p(ADMIN), "NW1", { target: `u:${ext}` })).rejects.toBeInstanceOf(ValidationError);
  });

  it("Zielgruppen: News und Umfragen an „Personal“ bzw. an die AG ohne externe Leitung („x von y“ unverfälscht)", async () => {
    const news = await newsAudience(h.db, { targetRoles: ["personal"], targetGroupIds: [CHOR] });
    expect(news).not.toContain(ext);
    expect(news).toContain(HAUSMEISTER);
    expect(await newsAudience(h.db, {})).not.toContain(ext);
    const now = new Date();
    const survey = await createSurvey(
      h.db,
      await p(LEHRKRAFT),
      {
        title: "GT-16 Umfrage",
        description: "",
        anonymous: true,
        opensAt: now,
        closesAt: new Date(now.getTime() + 7 * 86_400_000),
        targets: { roles: ["personal"], groups: [{ groupId: CHOR, parents: false }] },
        questions: [{ kind: "single", text: "Passt der Termin?", options: ["Ja", "Nein"], required: true }],
      },
      now,
    );
    const audience = await surveyAudience(h.db, survey);
    expect(audience).not.toContain(ext);
    expect(audience).toContain(HAUSMEISTER);
  });

  it("Ganztag bleibt: Angebot und Leitung zeigen die externe Leitung, sie selbst sieht ihr Angebot", async () => {
    const offer = await getOffer(h.db, await p(SEKRETARIAT), CHOR);
    expect(offer?.leaders).toContain("Extern Chorleitung");
    expect((await listOffers(h.db, await p(SEKRETARIAT))).find((o) => o.id === CHOR)?.leaders).toContain("Extern Chorleitung");
    expect((await listOffers(h.db, await p(ext))).map((o) => o.id)).toEqual([CHOR]);
    // Schüler:innen sahen Personal ohnehin nicht – bleibt so
    expect((await searchPeople(h.db, await p(SCHUELERIN), "Chorleitung")).map((x) => x.id)).not.toContain(ext);
  });
});
