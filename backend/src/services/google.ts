// Thin Google OAuth + Gmail REST client (fetch-based, no SDK). Used by the gmail source.
// Scopes: gmail.readonly. Tokens are exchanged in the OAuth callback and refreshed on demand.

import { config } from "../config.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds
}

/** Exchange an authorization code for access + refresh tokens. */
export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`google token exchange ${res.status}: ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

/** Trade a refresh token for a fresh access token. */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`google token refresh ${res.status}: ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

async function gmailGet<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`gmail ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}
export function getGmailProfile(accessToken: string): Promise<GmailProfile> {
  return gmailGet<GmailProfile>(accessToken, "/profile");
}

interface MessageList {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
}
/** List message ids matching a Gmail search query (newest first), capped by `max`. */
export async function listMessageIds(accessToken: string, q: string, max = 25): Promise<string[]> {
  const list = await gmailGet<MessageList>(accessToken, `/messages?q=${encodeURIComponent(q)}&maxResults=${max}`);
  return (list.messages ?? []).map((m) => m.id);
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  internalDate?: string; // epoch ms as string
  payload?: GmailPart;
}
export function getMessage(accessToken: string, id: string): Promise<GmailMessage> {
  return gmailGet<GmailMessage>(accessToken, `/messages/${id}?format=full`);
}

/** Download an attachment body and return raw bytes. */
export async function getAttachment(accessToken: string, messageId: string, attachmentId: string): Promise<Buffer> {
  const att = await gmailGet<{ data?: string }>(accessToken, `/messages/${messageId}/attachments/${attachmentId}`);
  return Buffer.from(att.data ?? "", "base64url");
}

/** Decode a base64url Gmail body part to a UTF-8 string. */
export function decodeBody(data?: string): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

/** Read a header value (case-insensitive) from a part. */
export function header(part: GmailMessage["payload"], name: string): string | undefined {
  return part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}
