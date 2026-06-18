// Smoke test: open the Baileys socket and confirm it connects far enough to emit a pairing QR.
// Uses a throwaway auth dir so the real Klove pairing isn't affected. Exits after a short window.
//   BAILEYS_AUTH_DIR=.baileys-probe npx tsx --env-file=.env scripts/baileys-probe.ts
import { startBaileys, isBaileysReady } from "../src/services/whatsapp-baileys.js";

await startBaileys();
console.log("[probe] socket started; waiting ~15s for QR / connection…");
setTimeout(() => {
  console.log(`[probe] done. ready=${isBaileysReady()}`);
  process.exit(0);
}, 15000);
