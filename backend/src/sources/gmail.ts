import type { DataSource, RawArtifact } from "./types.js";
import { config, enabled } from "../config.js";
import { prisma } from "../db.js";
import { encryptToken, decryptToken } from "../services/crypto.js";
import {
  refreshAccessToken,
  listMessageIds,
  getMessage,
  getAttachment,
  decodeBody,
  header,
  type GmailMessage,
  type GmailPart,
} from "../services/google.js";

// Search for likely health mail; the LLM classifier is the real gate. `after:` makes it incremental.
const HEALTH_QUERY =
  "(from:(labcorp OR quest OR mychart OR kaiser OR epic OR athenahealth) OR " +
  "subject:(lab OR results OR appointment OR visit OR prescription OR referral)) ";
const MAX_PER_SYNC = 25;
const FIRST_SYNC_LOOKBACK_DAYS = 90;

/**
 * Gmail source (real). connect() returns a consent URL; /webhooks/gmail/oauth stores tokens.
 * sync() refreshes the access token as needed, searches for health mail since the last cursor,
 * and turns each message body + attachment into a RawArtifact. Polled by runIngestionTick.
 */
export const gmailSource: DataSource = {
  type: "gmail",

  async connect(userId) {
    if (!enabled.gmail()) throw new Error("gmail_not_configured");
    const state = Buffer.from(JSON.stringify({ userId, type: "gmail" })).toString("base64url");
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: config.google.redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent", // force a refresh_token even on re-consent
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      state,
    });
    await prisma.dataSourceConnection.upsert({
      where: { userId_type_externalAccountId: { userId, type: "gmail", externalAccountId: "" } },
      create: { userId, type: "gmail", status: "pending", externalAccountId: "" },
      update: { status: "pending" },
    });
    return { redirectUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
  },

  async sync(connection): Promise<RawArtifact[]> {
    if (!enabled.gmail() || !connection.accessTokenEnc) return [];

    const accessToken = await freshAccessToken(connection);
    const cursor = JSON.parse(connection.cursor ?? "{}") as { after?: number };
    const after = cursor.after ?? Math.floor((Date.now() - FIRST_SYNC_LOOKBACK_DAYS * 86_400_000) / 1000);
    const q = `${HEALTH_QUERY} after:${after}`;

    const ids = await listMessageIds(accessToken, q, MAX_PER_SYNC);
    const artifacts: RawArtifact[] = [];
    for (const id of ids) {
      const msg = await getMessage(accessToken, id);
      const { subject, bodyText, attachments } = parseMessageParts(msg);
      const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : undefined;
      if (bodyText.trim()) {
        artifacts.push({
          sourceRef: `gmail:${id}:body`,
          mimeType: "text/plain",
          text: `Subject: ${subject ?? ""}\n\n${bodyText}`,
          originalName: subject ?? "email",
          receivedAt,
        });
      }
      for (const att of attachments) {
        const bytes = await getAttachment(accessToken, id, att.attachmentId);
        if (!bytes.length) continue;
        artifacts.push({
          sourceRef: `gmail:${id}:${att.filename}`,
          mimeType: att.mimeType,
          bytes,
          originalName: att.filename,
          receivedAt,
        });
      }
    }

    await prisma.dataSourceConnection.update({
      where: { id: connection.id },
      data: { cursor: JSON.stringify({ after: Math.floor(Date.now() / 1000) }) },
    });
    return artifacts;
  },

  /**
   * Gmail Pub/Sub push: the notification only carries { emailAddress, historyId }. We use it as a
   * signal to pull — find the connection for that mailbox and run the normal health-mail sync.
   */
  async handleWebhook(payload): Promise<{ userId: string; artifacts: RawArtifact[] }> {
    const data = (payload as { message?: { data?: string } })?.message?.data;
    if (!data) return { userId: "", artifacts: [] };
    let emailAddress = "";
    try {
      emailAddress = (JSON.parse(Buffer.from(data, "base64").toString("utf8")) as { emailAddress?: string }).emailAddress ?? "";
    } catch {
      return { userId: "", artifacts: [] };
    }
    const conn = await prisma.dataSourceConnection.findFirst({
      where: { type: "gmail", externalAccountId: emailAddress, status: "connected" },
    });
    if (!conn) return { userId: "", artifacts: [] };
    const artifacts = await gmailSource.sync(conn);
    return { userId: conn.userId, artifacts };
  },
};

/** Return a valid access token, refreshing (and persisting) it if expired. */
async function freshAccessToken(connection: {
  id: string;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
}): Promise<string> {
  const expired = !connection.tokenExpiresAt || connection.tokenExpiresAt.getTime() - 60_000 < Date.now();
  if (!expired) return decryptToken(connection.accessTokenEnc!);
  if (!connection.refreshTokenEnc) throw new Error("gmail_no_refresh_token");

  const refreshed = await refreshAccessToken(decryptToken(connection.refreshTokenEnc));
  await prisma.dataSourceConnection.update({
    where: { id: connection.id },
    data: {
      accessTokenEnc: encryptToken(refreshed.access_token),
      tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
    },
  });
  return refreshed.access_token;
}

export interface ParsedMessage {
  subject?: string;
  bodyText: string;
  attachments: { filename: string; mimeType: string; attachmentId: string }[];
}

/** Walk a Gmail message payload tree → subject, plain-text body, and attachment refs. Pure (testable). */
export function parseMessageParts(msg: GmailMessage): ParsedMessage {
  const subject = header(msg.payload, "Subject");
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: ParsedMessage["attachments"] = [];

  const walk = (part?: GmailPart) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        attachmentId: part.body.attachmentId,
      });
    } else if (part.mimeType === "text/plain" && part.body?.data) {
      plain.push(decodeBody(part.body.data));
    } else if (part.mimeType === "text/html" && part.body?.data) {
      html.push(decodeBody(part.body.data));
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(msg.payload);

  // Prefer plain text; fall back to HTML with tags stripped.
  const bodyText = plain.length ? plain.join("\n") : html.join("\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return { subject, bodyText, attachments };
}
