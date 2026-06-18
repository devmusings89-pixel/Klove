// E2E auth check against the DEPLOYED backend: (1) probe whether Supabase's Apple provider is
// enabled, (2) drive the full email+password chain (signup → session → backend JWKS verify → 200),
// which exercises the exact verification Apple Sign-In also relies on. Cleans up the throwaway user.
//   npx tsx --env-file=.env scripts/auth-e2e-test.ts
import { prisma } from "../src/db.js";

const SB = process.env.SUPABASE_URL!;
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY!;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BACKEND = "https://agents.klovehealth.com";

// 1) Apple provider probe — send a dummy id_token; the error reveals enabled vs not-enabled.
const ap = await fetch(`${SB}/auth/v1/token?grant_type=id_token`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ provider: "apple", id_token: "dummy.dummy.dummy" }),
});
const apText = await ap.text();
const enabled = !/not enabled|unsupported provider/i.test(apText);
console.log(`\n[1] Apple provider: HTTP ${ap.status} → ${enabled ? "ENABLED ✓ (rejected the dummy token, as expected)" : "NOT ENABLED ✗"}`);
console.log(`    detail: ${apText.slice(0, 180)}`);

// 2) Email+password full chain.
const email = `pwtest-${Date.now()}@example.com`;
const password = `Test-${Math.random().toString(36).slice(2, 10)}A1`;
const su = await fetch(`${SB}/auth/v1/signup`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const suJson = (await su.json()) as { access_token?: string; id?: string; user?: { id?: string } };
const token = suJson.access_token;
console.log(`\n[2] signup (${email}): HTTP ${su.status} → ${token ? "session returned ✓" : "no session"}`);

if (token) {
  const t = await fetch(`${BACKEND}/today`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await t.text();
  console.log(`[3] backend /today with the password session: HTTP ${t.status} → ${t.status === 200 ? "✓ JWKS verified + user resolved" : "✗ " + body.slice(0, 160)}`);
}

// Cleanup: remove the throwaway Klove row + Supabase user.
const sub = suJson.user?.id ?? suJson.id;
await prisma.user.deleteMany({ where: { email } }).catch(() => {});
if (sub) await fetch(`${SB}/auth/v1/admin/users/${sub}`, { method: "DELETE", headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } }).catch(() => {});
console.log(`\ncleaned up throwaway user (${email}).`);
await prisma.$disconnect();
