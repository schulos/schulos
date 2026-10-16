// Gerätezertifikat ausstellen (P4-40b): Schlüssel + CSR hier, Signatur durch die Schul-CA (step-ca), Eintrag in die
// Freigabeliste, Export als .p12 und .mobileconfig. Der private Schlüssel und das Export-Passwort verlassen diese Funktion
// nur im Ergebnis (einmaliger Download in der Verwaltung) – gespeichert wird beides nicht.
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import type { Db } from "@/core/db/client";
import type { ExternalZone } from "@/core/external-access";
import { pemBlocks } from "./der";
import { createCsr, createMobileconfig, createPkcs12, exportPassword, newDeviceKey } from "./pkcs12";
import { DeviceCertError, registerDeviceCert, staffUserByUsername } from "./service";
import { signCsr, type StepCaConfig, type Transport } from "./step-ca";

export const VALIDITY_DAYS = { min: 30, max: 730, default: 365 } as const;

export interface IssuedDeviceCert {
  id: string;
  commonName: string;
  fingerprint: string;
  notAfter: Date;
  password: string;
  p12: Buffer;
  mobileconfig: Buffer;
}

/** Fingerabdruck wie Caddy ihn liefert: SHA-256 über DER, Hex klein ohne Doppelpunkte */
export function fingerprintOf(cert: X509Certificate): string {
  return createHash("sha256").update(cert.raw).digest("hex");
}

export async function issueDeviceCert(
  db: Db,
  actorId: string,
  zone: ExternalZone,
  input: { label: string; days: number; username?: string; organization: string },
  ca: StepCaConfig,
  transport?: Transport,
  now = new Date(),
): Promise<IssuedDeviceCert> {
  if (zone !== "intern") throw new DeviceCertError("Gerätezertifikate lassen sich nur im Schulnetz ausstellen.");
  const label = input.label.trim();
  if (label.length < 2 || label.length > 80 || /[\u0000-\u001f\u007f<>]/.test(label)) throw new DeviceCertError("Bitte eine Gerätebezeichnung mit 2–80 Zeichen angeben.");
  if (!Number.isInteger(input.days) || input.days < VALIDITY_DAYS.min || input.days > VALIDITY_DAYS.max)
    throw new DeviceCertError(`Laufzeit ${VALIDITY_DAYS.min}–${VALIDITY_DAYS.max} Tage.`);
  const user = input.username?.trim() ? await staffUserByUsername(db, input.username) : null;

  // Name im Zertifikat ohne Personenbezug – die Bezeichnung steht nur in SchulOS
  const commonName = `geraet-${randomBytes(6).toString("hex")}`;
  const key = await newDeviceKey();
  const notAfter = new Date(now.getTime() + input.days * 86_400_000);
  const signed = await signCsr(ca, createCsr(key, commonName), commonName, notAfter, transport);

  const cert = new X509Certificate(signed.certPem);
  // Antwort der CA nicht blind übernehmen: unser Schlüssel, unser Name, Client-Zertifikat
  if (!cert.checkPrivateKey(key.privateKey)) throw new DeviceCertError("Schul-CA hat ein Zertifikat zu einem fremden Schlüssel geliefert.");
  if (!cert.subject.split("\n").includes(`CN=${commonName}`)) throw new DeviceCertError("Schul-CA hat einen anderen Namen eingetragen.");
  if (cert.ca) throw new DeviceCertError("Schul-CA hat ein CA-Zertifikat geliefert.");
  const chainDer = signed.chainPem.flatMap((p) => pemBlocks(p, "CERTIFICATE"));

  const fingerprint = fingerprintOf(cert);
  const notBefore = new Date(cert.validFrom);
  const validTo = new Date(cert.validTo);
  const id = await registerDeviceCert(db, actorId, { label, commonName, fingerprint, serial: cert.serialNumber.toLowerCase(), notBefore, notAfter: validTo, userId: user?.id ?? null });

  const password = exportPassword();
  const p12 = createPkcs12({ privateKey: key.privateKey, certDer: cert.raw, chainDer, password, friendlyName: `SchulOS ${label}` });
  const mobileconfig = createMobileconfig({ p12, password, commonName, label, organization: input.organization });
  return { id, commonName, fingerprint, notAfter: validTo, password, p12, mobileconfig };
}
