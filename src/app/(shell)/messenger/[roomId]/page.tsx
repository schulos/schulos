import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { eq } from "drizzle-orm";
import { chatRooms } from "@/core/db/schema";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { COUNSELING_NOTICE, directChatBlock, isCounselingPair } from "@/modules/messenger/policy";
import { directPartner, getRoom, listMessages } from "@/modules/messenger/service";
import umfragen from "@/modules/umfragen/manifest";
import { activeQuickPolls, canStartQuickPoll } from "@/modules/umfragen/schnell";
import { QuickPolls } from "../../umfragen/quick-polls";
import { Conversation } from "./conversation";

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { perms, user } = await requireUser();
  const { roomId } = await params;
  const db = await getDb();
  const id = decodeURIComponent(roomId);
  const [room, messages] = await Promise.all([getRoom(db, perms, id), listMessages(db, perms, id)]);
  if (!room || !messages) notFound();
  // Schnellumfragen im Gruppenchat, wenn das Modul an ist
  const [groupRoom] = room.kind === "group" ? await db.select({ groupId: chatRooms.groupId }).from(chatRooms).where(eq(chatRooms.id, id)) : [];
  const groupId = groupRoom?.groupId && isEnabled(umfragen, await loadModuleStates(db)) ? groupRoom.groupId : null;
  const polls = groupId ? await activeQuickPolls(db, perms, groupId) : [];
  const partner = room.kind === "direct" ? await directPartner(db, perms, id) : null;
  const blocked = partner ? await directChatBlock(db, { id: user.id, role: perms.role }, partner) : null;
  const notice = partner && isCounselingPair(perms.role, partner.role) ? COUNSELING_NOTICE : null;
  return (
    <Conversation
      key={room.id}
      me={user.id}
      blocked={blocked}
      notice={notice}
      room={{ id: room.id, kind: room.kind, title: room.title, avatar: room.avatar, memberCount: room.memberCount }}
      initialReads={room.reads.map((r) => ({ userId: r.userId, lastReadAt: r.lastReadAt.toISOString() }))}
      initialMessages={messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() }))}
      polls={
        groupId ? (
          <QuickPolls groupId={groupId} initial={polls} canStart={canStartQuickPoll(perms, groupId)} className="max-h-[40%] overflow-y-auto border-b border-border px-4 py-3" />
        ) : undefined
      }
    />
  );
}
