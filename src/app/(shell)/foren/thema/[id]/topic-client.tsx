"use client";

import { Bell, BellOff, Pencil } from "lucide-react";
import { useState, useTransition } from "react";
import { editPostAction, setSubscriptionAction } from "@/modules/foren/actions";
import { Button } from "@schulos/ui/button";
import { PostForm } from "../../post-forms";

export function SubscribeToggle({ topicId, subscribed }: { topicId: string; subscribed: boolean }) {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" disabled={pending} onClick={() => start(() => setSubscriptionAction(topicId, !subscribed))}>
      {subscribed ? <BellOff aria-hidden /> : <Bell aria-hidden />}
      {subscribed ? "Abo beenden" : "Abonnieren"}
    </Button>
  );
}

export function EditPost({ topicId, postId, body }: { topicId: string; postId: string; body: string }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <Button size="sm" variant="ghost" className="self-start" onClick={() => setOpen(true)}>
        <Pencil aria-hidden /> Bearbeiten
      </Button>
    );
  return <PostForm action={editPostAction.bind(null, topicId, postId)} label="Beitrag bearbeiten" submitLabel="Speichern" initial={body} onDone={() => setOpen(false)} />;
}
