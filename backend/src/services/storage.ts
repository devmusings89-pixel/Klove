// Object storage for raw health documents. Supabase Storage (private bucket) when configured;
// a local-filesystem fallback under ./.uploads in mock mode so the pipeline runs without keys.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config, enabled } from "../config.js";

const MOCK_DIR = join(process.cwd(), ".uploads");

/** Lazily create a Supabase client (only when configured) without a static import elsewhere. */
async function client() {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * Store raw bytes at `objectKey` (e.g. "user/<id>/<docId>/<filename>").
 * Returns the storage path to persist on HealthDocument.storagePath.
 */
export async function putObject(objectKey: string, bytes: Buffer, contentType: string): Promise<string> {
  if (!enabled.supabase()) {
    const path = join(MOCK_DIR, objectKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return path;
  }
  const supabase = await client();
  const { error } = await supabase.storage
    .from(config.supabase.storageBucket)
    .upload(objectKey, bytes, { contentType, upsert: true });
  if (error) throw new Error(`Supabase storage upload failed: ${error.message}`);
  return objectKey;
}

/** Read raw bytes back (used by the extraction worker to feed Claude vision). */
export async function getObject(storagePath: string): Promise<Buffer> {
  if (!enabled.supabase()) {
    return readFile(storagePath);
  }
  const supabase = await client();
  const { data, error } = await supabase.storage.from(config.supabase.storageBucket).download(storagePath);
  if (error || !data) throw new Error(`Supabase storage download failed: ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}

/** Delete a stored object (best-effort; used for cleanup). */
export async function removeObject(storagePath: string): Promise<void> {
  if (!enabled.supabase()) {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(storagePath);
    } catch {
      /* already gone */
    }
    return;
  }
  const supabase = await client();
  await supabase.storage.from(config.supabase.storageBucket).remove([storagePath]).catch(() => undefined);
}

/** Mint a short-lived signed URL for the client to view a document (Supabase only). */
export async function signedUrl(storagePath: string, expiresInSec = 300): Promise<string | null> {
  if (!enabled.supabase()) return null; // mock files aren't web-served
  const supabase = await client();
  const { data, error } = await supabase.storage
    .from(config.supabase.storageBucket)
    .createSignedUrl(storagePath, expiresInSec);
  if (error) throw new Error(`Supabase signed URL failed: ${error.message}`);
  return data.signedUrl;
}
