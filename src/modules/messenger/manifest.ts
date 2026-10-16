import { defineModule } from "@/core/modules/types";
import { MESSENGER_SETTINGS } from "./settings";

export default defineModule({
  id: "messenger",
  name: "Messenger",
  description: "Direktnachrichten und Gruppenchats in Echtzeit",
  icon: "MessageSquare",
  section: "kommunikation",
  mobile: 4,
  order: 10,
  groupFeatures: { "messenger.raum": "Gruppenchat" },
  nav: [{ href: "/messenger", label: "Messenger" }],
  settings: MESSENGER_SETTINGS,
  retention: [
    {
      table: "chat_rooms",
      scope: "Direktchat",
      purpose: "Direktnachrichten zwischen zwei Personen",
      categories: ["Beteiligte", "Zeitpunkt der letzten Nachricht"],
      class: "LK-1J",
      start: "last_message_at",
      fallback: "created_at",
      where: "kind = 'direct'",
      period: "messenger.keep_days",
    },
    {
      table: "chat_rooms",
      scope: "Direktchat mit der Schulsozialarbeit",
      purpose: "Terminabsprache zwischen Schüler:innen bzw. Eltern und der Schulsozialarbeit (Rolle Beratung)",
      categories: ["Beteiligte", "Nachrichten (über den Raum)", "Zeitpunkt der letzten Nachricht"],
      class: "LK-90",
      period: "messenger.counseling_keep_days",
      start: "last_message_at",
      fallback: "created_at",
      // GATE-031 (C-05): nur die Paarung Beratung ↔ Schüler:in/Eltern – Chats der Beratung mit Kolleg:innen folgen der allgemeinen Frist
      where:
        "kind = 'direct' and id in (select m.room_id from chat_members m join users u on u.id = m.user_id where u.role = 'beratung') and id in (select m.room_id from chat_members m join users u on u.id = m.user_id where u.role in ('schueler', 'eltern'))",
      note: "Vorschlag, mit der/dem DSB zu klären (DSB-FRAGEN §8): 90 Tage nach der letzten Nachricht (Moduleinstellung 30/60/90 Tage), Nachrichten werden mit dem Raum gelöscht",
    },
    { table: "chat_rooms", scope: "Gruppenchat", purpose: "Chat einer Gruppe", categories: ["Gruppe"], follows: "groups" },
    { table: "chat_members", purpose: "Beteiligte an Direktchats", categories: ["Mitgliedschaft"], follows: "chat_rooms" },
    { table: "chat_reads", purpose: "Lesestatus", categories: ["Gelesen bis"], class: "LK-KONTO", start: "user_id" },
    {
      table: "chat_messages",
      purpose: "Schulkommunikation",
      categories: ["Nachrichteninhalt", "Absender:in", "Zeitpunkt"],
      class: "LK-1J",
      start: "created_at",
      period: "messenger.keep_days",
    },
  ],
  processing: {
    title: "Messenger",
    purpose: "Schulische Kommunikation über Direkt- und Gruppenchats",
    subjects: ["Schüler:innen", "Eltern", "Lehrkräfte", "Verwaltungspersonal"],
    recipients: ["Teilnehmende des jeweiligen Chats"],
    note: "Schüler:innen können nur mit Personen chatten, die sie auch im Adressbuch sehen (Lehrkräfte, Verwaltung, Mitglieder ihrer Gruppen); Direktchats unter Schüler:innen regelt die Schule als Moduleinstellung (aus / nur eigene Klasse – Vorgabe – / gemeinsame Gruppen); Chats von Schüler:innen und Eltern mit der Schulsozialarbeit (Rolle Beratung) nur, wenn die Schule sie freischaltet (Vorgabe aus), nur zur Terminabsprache und 90 Tage nach der letzten Nachricht gelöscht; Nachrichten sind keine Akte und werden nach einem Jahr gelöscht (die Schule kann auf 90 bzw. 180 Tage verkürzen).",
  },
});
