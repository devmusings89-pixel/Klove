// Transport-neutral inbound WhatsApp handler. Both the Baileys socket listener and the Twilio webhook
// resolve the sender + media bytes, then call this. It owns the shared behavior: identify the user,
// file any attachments as records, run the concierge agent on the text, and send replies back through
// whichever transport is active. Fire-and-forget friendly (never throws into the caller).

import { resolveUserByWhatsapp, handleInboundMessage } from "./agent.js";
import { sendWhatsApp } from "./whatsapp.js";
import { fileMedia, mediaAck, type MediaItem } from "./whatsapp-media.js";

export async function handleWhatsAppInbound(from: string, text: string, media: MediaItem[] = []): Promise<void> {
  try {
    const user = await resolveUserByWhatsapp(from);
    if (!user) {
      // Unknown number: one generic reply, never create a user from inbound (anti-abuse).
      await sendWhatsApp(from, "This number isn't linked to a Klove account yet. Open the Klove app to connect it.");
      return;
    }

    if (media.length) {
      if (!user.whatsappVerified) {
        await sendWhatsApp(from, "Reply YES to connect this number to your Klove account first, then send that over.");
        return;
      }
      const { filed, skipped } = await fileMedia(user.id, media, text);
      await sendWhatsApp(from, mediaAck(filed, skipped));
      // If they sent a caption with an actual request, handle it too.
      if (text) await sendWhatsApp(from, await handleInboundMessage(user, text));
      return;
    }

    if (!text) return;
    await sendWhatsApp(from, await handleInboundMessage(user, text));
  } catch (err) {
    console.error("[whatsapp] inbound handling failed", err);
  }
}
