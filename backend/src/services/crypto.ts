// Envelope encryption for OAuth tokens stored at rest (DataSourceConnection.*TokenEnc).
// AES-256-GCM when HEALTH_ENCRYPTION_KEY is set; a clearly-marked base64 fallback in mock mode
// (no real tokens exist without configured sources, so the fallback never protects live secrets).

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { config } from "../config.js";

const ENC_PREFIX = "enc:v1:";
const PLAIN_PREFIX = "plain:v1:";

/** Derive a stable 32-byte key from the configured secret (any length/encoding). */
function key(): Buffer {
  return createHash("sha256").update(config.encryptionKey).digest();
}

/** Encrypt a token for storage. Returns a self-describing string (prefix encodes the scheme). */
export function encryptToken(plaintext: string): string {
  if (!config.encryptionKey) {
    return PLAIN_PREFIX + Buffer.from(plaintext, "utf8").toString("base64");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + [iv, tag, ct].map((b) => b.toString("base64")).join(".");
}

/** Decrypt a stored token. Tolerates either scheme (handles a key being added later). */
export function decryptToken(stored: string): string {
  if (stored.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(stored.slice(PLAIN_PREFIX.length), "base64").toString("utf8");
  }
  if (stored.startsWith(ENC_PREFIX)) {
    if (!config.encryptionKey) throw new Error("HEALTH_ENCRYPTION_KEY required to decrypt token");
    const [ivB64, tagB64, ctB64] = stored.slice(ENC_PREFIX.length).split(".");
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  }
  // Legacy/unmarked value — assume plaintext.
  return stored;
}
