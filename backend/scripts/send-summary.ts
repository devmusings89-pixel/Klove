/**
 * Re-send the summary email for an existing session (useful for testing email without
 * placing a new call). Reuses the same sendSummaryEmail used by the orchestrator.
 *
 * Run:  npm run send-summary -- <sessionId>
 */
import { sendSummaryEmail } from "../src/services/email.js";

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("Usage: npm run send-summary -- <sessionId>");
  process.exit(1);
}

await sendSummaryEmail(sessionId);
console.log(`Summary email triggered for session ${sessionId}.`);
process.exit(0);
