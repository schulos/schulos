// Schuldaten pflegen: Name, Schulnummer, Farbe, Bundesland, Schulform, Oberstufe, G8/G9.
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { appSettings } from "@/core/db/schema";
import { formInfo, isSchoolForm, isStateCode, type SchoolForm, type StateCode } from "@/core/school/catalog";
import { readSchoolSettings } from "@/core/settings";
import { ValidationError } from "./users";

export interface SchoolInput {
  name: string;
  number: string;
  color: string;
  state: string;
  form: string;
  oberstufe: boolean;
  abitur: string;
}

export async function saveSchoolSettings(db: Db, actorId: string, input: SchoolInput): Promise<void> {
  const fe: Record<string, string> = {};
  const name = input.name.trim();
  if (!name) fe.name = "Name der Schule angeben";
  if (name.length > 120) fe.name = "Name bitte kürzer fassen";
  if (input.number && !/^[0-9A-Za-z-]{3,12}$/.test(input.number.trim())) fe.number = "Schulnummer prüfen (3–12 Zeichen)";
  if (!/^#[0-9a-f]{6}$/i.test(input.color)) fe.color = "Farbe als #RRGGBB angeben";
  if (!isStateCode(input.state)) fe.state = "Bundesland wählen";
  if (!isSchoolForm(input.form)) fe.form = "Schulform wählen";
  if (input.abitur !== "g8" && input.abitur !== "g9") fe.abitur = "G8 oder G9 wählen";
  if (Object.keys(fe).length) throw new ValidationError(fe);

  const form = input.form as SchoolForm;
  const oberstufe = formInfo(form).oberstufe === "immer" ? true : formInfo(form).oberstufe === "nie" ? false : input.oberstufe;
  const before = await readSchoolSettings(db);
  const values: Record<string, unknown> = {
    "school.name": name,
    "school.number": input.number.trim(),
    "school.color": input.color.toUpperCase(),
    "school.state": input.state as StateCode,
    "school.form": form,
    "school.oberstufe": oberstufe,
    "school.abitur": input.abitur,
  };
  for (const [key, value] of Object.entries(values)) {
    await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  }
  await audit(db, actorId, "verwaltung.school.update", null, {
    state: input.state,
    form,
    profileChanged: before.profile.state !== input.state || before.profile.form !== form || before.profile.oberstufe !== oberstufe || before.profile.abitur !== input.abitur,
  });
}
