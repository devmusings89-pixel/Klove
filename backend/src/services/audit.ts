// HIPAA audit trail. Record consent changes and actions-taken-on-behalf. Never log PHI bodies —
// only who did what, to whom, and a short non-PHI description.

import { prisma } from "../db.js";

export async function audit(
  actorUserId: string,
  action: string,
  subjectUserId?: string,
  detail?: string,
): Promise<void> {
  try {
    await prisma.auditEvent.create({ data: { actorUserId, action, subjectUserId, detail } });
  } catch (err) {
    // Auditing must never break the request path; log and continue.
    console.error("audit write failed:", err);
  }
}
