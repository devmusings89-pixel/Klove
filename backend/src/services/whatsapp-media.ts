// Inbound WhatsApp media → health records, transport-neutral. The transport (Baileys decrypt, or a
// Twilio authed-URL download) produces raw bytes; fileMedia hands each item to the same ingestion
// pipeline as a manual upload (store → HealthDocument → vision_ocr extraction). So a photo of a lab
// report, an insurance card, or a PDF becomes a filed, searchable record automatically.

import { ensureUploadConnection } from "../sources/upload.js";
import { ingestArtifact } from "./ingestion.js";

// Vision/OCR only handles images + PDF (mirrors ALLOWED_UPLOAD_MIMES in routes/uploads.ts).
const ALLOWED = new Set(["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "application/pdf"]);
const MAX_BYTES = 20 * 1024 * 1024;

export interface MediaItem {
  bytes: Buffer;
  contentType: string;
}
export interface MediaIngestResult {
  filed: number;
  skipped: number;
}

function extFor(contentType: string): string {
  if (contentType === "application/pdf") return "pdf";
  const sub = (contentType.split("/")[1] ?? "bin").split(";")[0];
  return sub === "jpeg" ? "jpg" : sub;
}

/** File already-downloaded media bytes as HealthDocuments. Unsupported/oversized items are skipped. */
export async function fileMedia(userId: string, items: MediaItem[], caption?: string): Promise<MediaIngestResult> {
  const connectionId = await ensureUploadConnection(userId);
  const slug = caption?.trim() ? caption.trim().slice(0, 40).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") : "";
  let filed = 0;
  let skipped = 0;
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    const ct = (m.contentType || "").split(";")[0].trim();
    if (!ALLOWED.has(ct) || !m.bytes?.byteLength || m.bytes.byteLength > MAX_BYTES) {
      skipped++;
      continue;
    }
    try {
      await ingestArtifact(
        userId,
        "upload",
        { bytes: m.bytes, mimeType: ct, originalName: `whatsapp-${slug || "document"}-${i + 1}.${extFor(ct)}`, receivedAt: new Date().toISOString() },
        connectionId,
      );
      filed++;
    } catch (err) {
      console.error("whatsapp media ingest failed", err);
      skipped++;
    }
  }
  return { filed, skipped };
}

/** Download Twilio authed media URLs to bytes (Twilio transport only). */
export async function downloadTwilioMedia(
  items: { url: string; contentType: string }[],
  fetcher: (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }> = fetch as never,
): Promise<MediaItem[]> {
  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const tok = process.env.TWILIO_AUTH_TOKEN ?? "";
  const headers = sid && tok ? { authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString("base64")}` } : undefined;
  const out: MediaItem[] = [];
  for (const it of items) {
    try {
      const res = await fetcher(it.url, headers ? { headers } : undefined);
      if (!res.ok) continue;
      out.push({ bytes: Buffer.from(await res.arrayBuffer()), contentType: it.contentType });
    } catch (err) {
      console.error("twilio media download failed", err);
    }
  }
  return out;
}

/** A short, human acknowledgment for filed/skipped media. */
export function mediaAck(filed: number, skipped: number): string {
  if (filed > 0 && skipped === 0) {
    return filed === 1
      ? "Got it 📎 — filed to your records, and I'll pull out the details."
      : `Got them 📎 — filed ${filed} to your records and I'll pull out the details.`;
  }
  if (filed > 0 && skipped > 0) {
    return `Filed ${filed} 📎 — I couldn't read ${skipped} of them. For those, a clear photo (JPG/PNG) or a PDF works best.`;
  }
  return "Hmm, I couldn't read that file. Could you send a clear photo (JPG/PNG) or a PDF?";
}
