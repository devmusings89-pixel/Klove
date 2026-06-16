import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { DataSource, RawArtifact } from "./types.js";
import { prisma } from "../db.js";
import { encryptToken, decryptToken } from "../services/crypto.js";

/**
 * Generic IMAP source — the email path that works today (no Google verification gate).
 * Credentials (an app password) are stored encrypted; a UID is the cursor. Poll-based, driven by
 * runIngestionTick. Each matching message yields a text-body artifact plus one per attachment;
 * the extraction pipeline's classifier drops anything that isn't actually health-related.
 */

const MAX_PER_SYNC = 25; // bound volume per poll
const FIRST_SYNC_LOOKBACK_DAYS = 30;

// Cheap pre-filter so we don't ingest the whole inbox; the LLM classifier is the real gate.
const HEALTH_HINTS = [
  "lab", "result", "test result", "labcorp", "quest", "mychart", "epic", "kaiser",
  "appointment", "visit", "clinic", "doctor", "physician", "prescription", "pharmacy",
  "radiology", "imaging", "referral", "diagnos", "patient",
];

interface ImapConfig {
  host: string;
  username: string;
  port?: number;
}

export const imapSource: DataSource = {
  type: "imap",

  async connect(userId, params) {
    // Known-provider presets so the client only needs an email + app-specific password.
    const PRESETS: Record<string, string> = {
      icloud: "imap.mail.me.com",
      yahoo: "imap.mail.yahoo.com",
      fastmail: "imap.fastmail.com",
    };
    const provider = params.provider ? String(params.provider) : "";
    const host = String(params.host ?? PRESETS[provider] ?? "");
    const username = String(params.username ?? "");
    const password = String(params.password ?? "");
    const port = params.port ? Number(params.port) : 993;
    if (!host || !username || !password) throw new Error("imap_missing_credentials");
    const conn = await prisma.dataSourceConnection.upsert({
      where: { userId_type_externalAccountId: { userId, type: "imap", externalAccountId: username } },
      create: {
        userId,
        type: "imap",
        status: "connected",
        externalAccountId: username,
        accessTokenEnc: encryptToken(password),
        config: JSON.stringify({ host, username, port } satisfies ImapConfig),
      },
      update: {
        status: "connected",
        accessTokenEnc: encryptToken(password),
        config: JSON.stringify({ host, username, port } satisfies ImapConfig),
      },
    });
    return { connectionId: conn.id };
  },

  async sync(connection): Promise<RawArtifact[]> {
    const cfg = JSON.parse(connection.config ?? "{}") as ImapConfig;
    if (!cfg.host || !cfg.username || !connection.accessTokenEnc) return [];
    const password = decryptToken(connection.accessTokenEnc);
    const lastUid = (JSON.parse(connection.cursor ?? "{}") as { uid?: number }).uid ?? 0;

    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port ?? 993,
      secure: true,
      auth: { user: cfg.username, pass: password },
      logger: false,
    });

    const artifacts: RawArtifact[] = [];
    let maxUid = lastUid;

    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        // Incremental by UID after the first sync; otherwise look back a bounded window.
        const query = lastUid
          ? { uid: `${lastUid + 1}:*` }
          : { since: new Date(Date.now() - FIRST_SYNC_LOOKBACK_DAYS * 86_400_000) };
        const uids = (await client.search(query, { uid: true })) || [];
        const recent = uids.slice(-MAX_PER_SYNC);

        for await (const msg of client.fetch(recent, { uid: true, source: true }, { uid: true })) {
          if (msg.uid > maxUid) maxUid = msg.uid;
          if (!msg.source) continue;
          const parsed = await simpleParser(msg.source);

          const hay = `${parsed.subject ?? ""} ${addressText(parsed.from)}`.toLowerCase();
          const looksHealth = HEALTH_HINTS.some((h) => hay.includes(h));
          const hasAttachments = parsed.attachments.length > 0;
          if (!looksHealth && !hasAttachments) continue; // skip obvious non-health, no attachments

          const receivedAt = parsed.date?.toISOString();
          const bodyText = parsed.text?.trim();
          if (bodyText) {
            artifacts.push({
              sourceRef: `imap:${connection.id}:${msg.uid}:body`,
              mimeType: "text/plain",
              text: `Subject: ${parsed.subject ?? ""}\nFrom: ${addressText(parsed.from)}\n\n${bodyText}`,
              originalName: parsed.subject ?? "email",
              receivedAt,
            });
          }
          for (const att of parsed.attachments) {
            if (!att.content?.length) continue;
            artifacts.push({
              sourceRef: `imap:${connection.id}:${msg.uid}:${att.filename ?? att.checksum}`,
              mimeType: att.contentType || "application/octet-stream",
              bytes: att.content,
              originalName: att.filename ?? "attachment",
              receivedAt,
            });
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }

    if (maxUid > lastUid) {
      await prisma.dataSourceConnection.update({
        where: { id: connection.id },
        data: { cursor: JSON.stringify({ uid: maxUid }) },
      });
    }
    return artifacts;
  },
};

function addressText(addr: unknown): string {
  if (addr && typeof addr === "object" && "text" in addr) return String((addr as { text: string }).text);
  return "";
}
