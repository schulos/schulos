import { getDb } from "@/core/db/client";
import { apiUser, sessionStillValid } from "@/core/auth/session";
import { unreadCount } from "@/core/notifications";
import { liveStream } from "@/core/notifications/stream";

export const dynamic = "force-dynamic";

/** Server-Sent Events: schickt dem angemeldeten Benutzer alle Live-Ereignisse (Gong, Chat). */
export async function GET(req: Request) {
  const me = await apiUser(req);
  if (me instanceof Response) return me;
  const userId = me.userId;
  const stream = liveStream({
    userId,
    unread: await unreadCount(await getDb(), userId),
    // SEC-04: Sitzung bei jedem Ping neu prüfen (gesperrt, Passwort/2FA zurückgesetzt, abgemeldet → Strom endet)
    stillValid: () => sessionStillValid(req, userId),
    signal: req.signal,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
