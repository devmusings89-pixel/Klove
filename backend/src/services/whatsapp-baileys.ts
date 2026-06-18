// Baileys transport: logs in as a real WhatsApp account (the dedicated "Klove" number) over the
// WhatsApp Web multi-device protocol. Free, no 24h proactive window, native media. One long-lived
// socket lives in the server process; auth creds persist to disk so it reconnects without re-pairing.
// First run prints a QR code to scan once with the Klove phone.

import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { handleWhatsAppInbound } from "./whatsapp-inbound.js";
import type { MediaItem } from "./whatsapp-media.js";

const AUTH_DIR = process.env.BAILEYS_AUTH_DIR ?? ".baileys-auth";
const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? "silent" });

let sock: WASocket | null = null;
let ready = false;
let starting = false;

export function isBaileysReady(): boolean {
  return ready;
}

/** Connect (or reconnect) the Baileys socket. Idempotent; safe to call once at boot. */
export async function startBaileys(): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        console.log("\n[whatsapp] Pair the Klove WhatsApp account — scan this QR (WhatsApp ▸ Linked Devices ▸ Link a Device):\n");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "open") {
        ready = true;
        console.log("[whatsapp] Baileys connected ✅");
      }
      if (connection === "close") {
        ready = false;
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.error(`[whatsapp] connection closed (code ${code ?? "?"})${loggedOut ? " — logged out; delete the auth dir and re-pair" : "; reconnecting…"}`);
        starting = false;
        if (!loggedOut) setTimeout(() => void startBaileys().catch((e) => console.error("[whatsapp] reconnect failed", e)), 3000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        try {
          await onMessage(m);
        } catch (err) {
          console.error("[whatsapp] message handling failed", err);
        }
      }
    });
  } finally {
    starting = false;
  }
}

/** Handle one inbound WhatsApp message: extract text + media bytes, route to the shared handler. */
async function onMessage(m: WAMessage): Promise<void> {
  if (m.key?.fromMe || !m.message) return;
  const jid: string = m.key?.remoteJid ?? "";
  if (!jid.endsWith("@s.whatsapp.net")) return; // ignore groups, status, broadcasts
  const from = `+${jid.split("@")[0]}`;

  const msg = m.message;
  const text: string =
    msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.documentMessage?.caption || "";

  const media: MediaItem[] = [];
  const mediaType = msg.imageMessage ? "image" : msg.documentMessage ? "document" : null;
  if (mediaType) {
    const contentType: string = (mediaType === "image" ? msg.imageMessage?.mimetype : msg.documentMessage?.mimetype) ?? "application/octet-stream";
    try {
      const bytes = (await downloadMediaMessage(m, "buffer", {}, { logger, reuploadRequest: sock!.updateMediaMessage })) as Buffer;
      media.push({ bytes, contentType });
    } catch (err) {
      console.error("[whatsapp] media download failed", err);
    }
  }

  await handleWhatsAppInbound(from, text.trim(), media);
}

/** Send a text message via Baileys. Returns false if the socket isn't connected yet. */
export async function sendViaBaileys(toE164: string, body: string): Promise<boolean> {
  if (!sock || !ready) {
    console.warn(`[whatsapp baileys] not connected; dropping message to ${toE164}`);
    return false;
  }
  const jid = `${toE164.replace(/^\+/, "")}@s.whatsapp.net`;
  try {
    await sock.sendMessage(jid, { text: body });
    return true;
  } catch (err) {
    console.error("[whatsapp baileys] send failed", err);
    return false;
  }
}
