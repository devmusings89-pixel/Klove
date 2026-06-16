/**
 * Verifies the warm-transfer outcome (#): a Vapi end-of-call report with
 * endedReason="assistant-forwarded-call" maps the office to status "transferred", stops further
 * calls, and completes the session. Run: npx tsx --env-file=.env scripts/transfer-flow.test.ts
 */
import assert from "node:assert";
import { prisma } from "../src/db.js";
import { recordCallResult } from "../src/services/orchestrator.js";
import { toJson } from "../src/services/json.js";

async function main() {
  const user = await prisma.user.upsert({ where: { email: "xfer-test@example.com" }, create: { email: "xfer-test@example.com" }, update: {} });
  const callId = "test-xfer-" + Math.floor(Number(process.hrtime.bigint() % 1000000n));
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      status: "in_progress",
      patientInfo: toJson({ name: "Prakash Ahuja", dob: "1984-09-28", reason: "dental cleaning", patientPhone: "+16175436389" }),
      maxCalls: 3, minutesCap: 30, stopWhenBooked: false, // even with stopWhenBooked off, a transfer must stop further calls
      targets: {
        create: [
          { officeName: "Office A", phoneNumber: "+12063518641", channel: "voice", status: "calling", vapiCallId: callId, order: 0 },
          { officeName: "Office B", phoneNumber: "+15551230000", status: "pending", order: 1 },
        ],
      },
    },
    include: { targets: { orderBy: { order: "asc" } } },
  });

  // Simulate the webhook for a successful warm transfer.
  await recordCallResult({
    vapiCallId: callId,
    transcript: "AI: ... Let me connect you with the patient.\nAI: Transferring a customer",
    summary: "Office required insurance ID; agent warm-transferred the office to the patient.",
    endedReason: "assistant-forwarded-call",
    durationSec: 46,
  });

  const a = await prisma.callTarget.findFirst({ where: { sessionId: session.id, order: 0 } });
  const b = await prisma.callTarget.findFirst({ where: { sessionId: session.id, order: 1 } });
  const s = await prisma.session.findUnique({ where: { id: session.id } });
  assert.equal(a?.status, "transferred", "Office A should be marked transferred");
  assert.equal(b?.status, "pending", "Office B must NOT be called after a transfer");
  assert.equal(s?.status, "completed", "session completes after a warm transfer");

  await prisma.callResult.deleteMany({ where: { callTarget: { sessionId: session.id } } });
  await prisma.callTarget.deleteMany({ where: { sessionId: session.id } });
  await prisma.session.delete({ where: { id: session.id } });
  console.log("✅ warm transfer: forwarded-call → office 'transferred' → no further calls → session completed");
}

main().then(() => process.exit(0)).catch((e) => { console.error("❌", e); process.exit(1); });
