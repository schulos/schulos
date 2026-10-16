// P4-72: Virenscan vor dem Speichern eines Uploads (Dateien, Aufgaben, Gebäude-Fotos, Prüfprotokolle) – Fund oder nicht
// erreichbarer Scanner werden zur Feldmeldung des jeweiligen Formulars. Ohne SCHULOS_CLAMAV passiert nichts.
import { assertNoVirus, VirusScanError } from "@/core/files/virus-scan";
import { ValidationError } from "@/modules/verwaltung/users";

export async function scanUpload(
  data: Uint8Array,
  name: string,
  field: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  try {
    await assertNoVirus(data, name, env);
  } catch (err) {
    if (err instanceof VirusScanError)
      throw new ValidationError({ [field]: err.message });
    throw err;
  }
}
