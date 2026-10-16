// Notenbuch (P5-20): Verschlüsselung des Offline-Caches (IndexedDB) mit WebCrypto – läuft im Browser und (für Tests) in Node.
//
// Verfahren („Schlüssel nicht im Klartext im Browser“, PHASE5-NOTENBUCH §0 F5-15):
//   · Beim Einschalten erzeugt der Browser 32 zufällige Bytes (**Geräteanteil**) und importiert sie sofort als **nicht
//     exportierbaren** HKDF-Schlüssel (`importDeviceShare`). Nur dieses CryptoKey-Objekt wird in IndexedDB abgelegt – die
//     rohen Bytes werden verworfen; `exportKey` lehnt der Browser ab.
//   · Der Server erzeugt je Gerät 32 zufällige Bytes (**Server-Anteil**, `notenbuch_offline_devices`) und liefert sie nur an eine
//     angemeldete, zweifaktor-geprüfte, nicht gesperrte Notenbuch-Sitzung derselben Person, nur solange das Gerät berechtigt
//     ist. Der Anteil wird im Browser nie gespeichert (nur im Arbeitsspeicher der Seite).
//   · Der **Cache-Schlüssel** (AES-GCM 256, nicht exportierbar) entsteht per HKDF aus Geräteanteil (Basis) + Server-Anteil
//     (Info) + Gerätekennung (Salt) – wer nur die Platte hat, kann den Cache nicht lesen; wer nur den Server-Anteil hat, auch
//     nicht. Löscht der Server die Zeile (Abmelden, Sitzungsablauf, Rechteentzug, Frist), ist der Cache endgültig unlesbar.
//   · Jeder Eintrag: eigener 96-Bit-Zufalls-IV, zusätzlich authentifizierte Daten = Fach des Eintrags (Gerät, Buch, Art), damit
//     ein Eintrag nicht in ein anderes Fach verschoben werden kann.

export const CACHE_INFO = "schulos-notenbuch-offline-v1";
export const SHARE_BYTES = 32;

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n));
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Zufälliger Schlüsselanteil als Base64 (Server wie Browser). */
export function newShare(): string {
  return toBase64(randomBytes(SHARE_BYTES));
}

/** Rohe Bytes des Geräteanteils als **nicht exportierbaren** HKDF-Basisschlüssel importieren (die Bytes danach verwerfen). */
export async function importDeviceShare(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return subtle().importKey("raw", raw, "HKDF", false, ["deriveKey"]);
}

/** Cache-Schlüssel aus Geräteanteil, Server-Anteil und Gerätekennung ableiten – nicht exportierbar, nur im Arbeitsspeicher. */
export async function deriveCacheKey(deviceShare: CryptoKey, serverShare: string, deviceId: string): Promise<CryptoKey> {
  if (!/^[A-Za-z0-9+/=]{40,}$/.test(serverShare)) throw new Error("Server-Anteil ungültig");
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(deviceId), info: enc.encode(`${CACHE_INFO}:${serverShare}`) },
    deviceShare,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  data: Uint8Array<ArrayBuffer>;
}

/** JSON-Wert verschlüsseln; `slot` = Fach des Eintrags (z. B. `${deviceId}:${bookId}:queue`), bindet den Eintrag an sein Fach. */
export async function seal(key: CryptoKey, slot: string, value: unknown): Promise<Sealed> {
  const iv = randomBytes(12);
  const data = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(slot) }, key, enc.encode(JSON.stringify(value)));
  return { iv, data: new Uint8Array(data) };
}

/** Entschlüsseln; wirft bei falschem Schlüssel, fremdem Fach oder manipulierten Daten. */
export async function open<T>(key: CryptoKey, slot: string, sealed: Sealed): Promise<T> {
  const plain = await subtle().decrypt({ name: "AES-GCM", iv: sealed.iv, additionalData: enc.encode(slot) }, key, sealed.data);
  return JSON.parse(dec.decode(plain)) as T;
}
