import { readFileSync } from "node:fs";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import http2 from "node:http2";
import { config, enabled } from "../config.js";
import { prisma } from "../db.js";

/**
 * Notify the patient that action is needed: pick a time (`choice`), provide missing info (`info`),
 * or enter a one-time verification code (`verify`). Phase 1: no-op stub (logs) unless APNs is set.
 */
export async function notifyChoiceNeeded(sessionId: string, kind: "choice" | "info" | "verify" = "choice"): Promise<void> {
  const body =
    kind === "info"
      ? "The office needs more info — tap to provide it."
      : kind === "verify"
        ? "Enter the code the office sent you to finish booking."
        : "Tap to choose a time.";
  if (!enabled.apns()) {
    console.log(`[push mock] ${kind} needed for session ${sessionId}: ${body}`);
    return;
  }
  const session = await prisma.session.findUnique({ where: { id: sessionId }, include: { user: true } });
  if (!session?.user.apnsToken) return;
  await sendApns(session.user.apnsToken, "Klove", body);
}

/** Register/refresh a user's APNs device token. */
export async function registerDeviceToken(userId: string, token: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { apnsToken: token } });
}

/**
 * Best-effort push to a specific user (used by reminders and concierge updates). `force` bypasses
 * the general push preference for safety-critical alerts (e.g. a missed critical-medication dose).
 * `link` is an optional deep-link hint (e.g. "actions"/"today") the app reads on tap to navigate.
 */
export async function sendPushToUser(userId: string, title: string, body: string, force = false, link?: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { apnsToken: true, pushEnabled: true } });
  if (!user?.apnsToken) return;
  if (user.pushEnabled === false && !force) return; // respect the preference unless it's safety-critical
  await sendApns(user.apnsToken, title, body, link);
}

/**
 * Build the APNs JSON payload. A `link` hint is added as a top-level custom key (allowed alongside
 * `aps`) that the iOS app reads on notification tap to deep-link to the relevant tab. Pure so the
 * payload shape is unit-testable without sending anything.
 */
export function buildApnsPayload(title: string, body: string, link?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { aps: { alert: { title, body }, sound: "default" } };
  if (link) payload.link = link;
  return payload;
}

/**
 * Send one APNs notification. Mock mode logs; live mode (APNS_* set) sends over the APNs HTTP/2 API
 * with a JWT provider token. Implemented as best-effort — failures never throw into the caller.
 */
async function sendApns(token: string, title: string, body: string, link?: string): Promise<void> {
  if (!enabled.apns()) {
    console.log(`[push mock] → ${token.slice(0, 8)}… "${title}: ${body}"${link ? ` [link:${link}]` : ""}`);
    return;
  }
  try {
    const jwt = apnsProviderToken();
    const client = http2.connect("https://api.push.apple.com");
    await new Promise<void>((resolve) => {
      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": config.apns.bundleId,
        "apns-push-type": "alert",
        "content-type": "application/json",
      });
      req.on("response", (headers) => {
        const status = headers[":status"];
        if (status !== 200) console.error(`APNs send failed: HTTP ${status}`);
      });
      req.on("error", (err) => {
        console.error("APNs request error:", err);
        resolve();
      });
      req.on("end", () => {
        client.close();
        resolve();
      });
      req.end(JSON.stringify(buildApnsPayload(title, body, link)));
      req.resume();
    });
  } catch (err) {
    console.error("APNs send threw:", err);
  }
}

// Provider JWT (ES256), cached for 50 min per Apple's guidance (tokens are valid ~1h, reuse them).
let cachedJwt: { token: string; exp: number } | null = null;
function apnsProviderToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.exp > now) return cachedJwt.token;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${b64({ alg: "ES256", kid: config.apns.keyId })}.${b64({ iss: config.apns.teamId, iat: now })}`;
  const key = createPrivateKey(readFileSync(config.apns.keyPath));
  const sig = cryptoSign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const token = `${signingInput}.${sig}`;
  cachedJwt = { token, exp: now + 50 * 60 };
  return token;
}
