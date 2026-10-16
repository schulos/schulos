/**
 * Better-Auth-Fehler erkennen. Bewusst KEIN `instanceof APIError`: Next bündelt Server Actions
 * in einer eigenen Webpack-Schicht, dort existiert die Klasse ein zweites Mal und instanceof
 * schlägt fehl (im E2E-Test gefunden – falsches Passwort führte zu einem 500er).
 */
export interface AuthApiError {
  name: "APIError";
  status: string;
  statusCode?: number;
  message: string;
}

export function isAuthApiError(err: unknown): err is AuthApiError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "APIError" &&
    typeof (err as { status?: unknown }).status === "string"
  );
}
