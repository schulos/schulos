// ZERTIFIKATE.md Teil A (Hinweis beim Aufruf per IP/Fremdname): über https://<IP> bzw. einen anderen Namen landet man nach der
// Zertifikatswarnung (Name passt nicht, INST-10) bei SchulOS – die Anmeldeseite sagt dann, unter welcher Adresse es richtig ist
// (Zertifikat, Passkeys, Cookies). Über http:// zeigt schon Caddy eine Hinweisseite (compose.yaml, „adresshinweis“).

/** Hostname ohne Port, klein; null bei unlesbarer Angabe */
function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Aufruf unter einem anderen Namen als der eingerichteten Adresse (`BETTER_AUTH_URL`)? Dann der aufgerufene Name und die
 * Anmeldeseite unter der richtigen Adresse, sonst null (auch ohne eingerichtete Adresse, etwa in der Entwicklung). Der Port
 * zählt nicht – hinter Caddy unterscheiden sich innerer und öffentlicher Port.
 */
export function foreignHost(host: string | null | undefined, baseUrl: string | undefined): { host: string; origin: string; loginUrl: string } | null {
  if (!host || !baseUrl) return null;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  const called = hostnameOf(host);
  if (!called || called === base.hostname.toLowerCase()) return null;
  return { host, origin: base.origin, loginUrl: `${base.origin}/login` };
}
