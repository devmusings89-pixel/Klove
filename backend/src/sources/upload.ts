import type { DataSource } from "./types.js";
import { prisma } from "../db.js";

/**
 * Manual upload "source". Unlike the others it isn't polled — artifacts arrive directly via
 * POST /uploads and are handed to the ingestion pipeline by that route. This connector exists
 * so uploads share the same DataSourceConnection provenance model as every other source.
 */
export const uploadSource: DataSource = {
  type: "upload",

  async connect(userId) {
    const existing = await prisma.dataSourceConnection.findFirst({
      where: { userId, type: "upload" },
    });
    if (existing) return { connectionId: existing.id };
    const conn = await prisma.dataSourceConnection.create({
      data: { userId, type: "upload", status: "connected" },
    });
    return { connectionId: conn.id };
  },

  // Uploads are push-only; nothing to poll.
  async sync() {
    return [];
  },
};

/** Ensure an upload connection exists for a user and return its id (used by the upload route). */
export async function ensureUploadConnection(userId: string): Promise<string> {
  const { connectionId } = await uploadSource.connect(userId, {});
  return connectionId!;
}
