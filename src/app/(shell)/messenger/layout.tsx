import type { Metadata } from "next";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { listRooms } from "@/modules/messenger/service";
import { RoomList } from "./room-list";

export const metadata: Metadata = { title: "Messenger" };

export default async function MessengerLayout({ children }: { children: React.ReactNode }) {
  const { perms, user } = await requireUser();
  await requireModulePage("messenger");
  const rooms = await listRooms(await getDb(), perms);
  // A11Y-01b: Raumliste und Chat bilden den Hauptinhalt (die Seiten selbst haben kein eigenes <main>)
  return (
    <main className="grid h-[calc(100dvh-10rem)] min-h-[420px] gap-4 lg:h-[calc(100dvh-7.5rem)] lg:grid-cols-[320px_minmax(0,1fr)]">
      <RoomList
        // neuer Raum (z. B. Direktchat) → Liste mit Serverdaten neu aufbauen
        key={rooms.map((r) => r.id).join("|")}
        me={user.id}
        initial={rooms.map((r) => ({ ...r, lastMessage: r.lastMessage ? { ...r.lastMessage, createdAt: r.lastMessage.createdAt.toISOString() } : null }))}
      />
      {children}
    </main>
  );
}
