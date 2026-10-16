import { MessageSquare } from "lucide-react";

export default function MessengerIndex() {
  return (
    <section className="hidden flex-col items-center justify-center gap-2 rounded-card border border-dashed border-border-strong text-center text-muted lg:flex">
      <MessageSquare className="size-10" aria-hidden strokeWidth={1.5} />
      <p className="font-medium text-ink">Wähle einen Chat</p>
      <p className="text-sm">oder starte mit „Neu“ eine Unterhaltung.</p>
    </section>
  );
}
