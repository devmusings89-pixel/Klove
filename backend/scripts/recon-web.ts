/** Read-only recon of a booking website. Usage: npm run recon-web -- <url> */
import { reconWebsite } from "../src/channels/web.js";

const url = process.argv[2];
const patientStatus = process.argv[3] ?? "new"; // "new" | "existing"
if (!url) {
  console.error("Usage: npm run recon-web -- <url> [new|existing]");
  process.exit(1);
}

const r = await reconWebsite(url, patientStatus);
console.log("\n=== RECON RESULT ===");
console.log("outcome:", r.outcome);
console.log("summary:", r.summary);
console.log("available (offeredSlots):", JSON.stringify(r.offeredSlots ?? []));
console.log("required fields (missingInfo):", JSON.stringify(r.missingInfo ?? []));
console.log("\n=== action transcript ===\n" + (r.transcript ?? ""));
process.exit(0);
