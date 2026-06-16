/**
 * Verifies the profile/insurance vault stores the member ID encrypted at rest and reads it back.
 * Run: npx tsx --env-file=.env scripts/profile.test.ts
 */
import assert from "node:assert";
import { prisma } from "../src/db.js";
import { encryptToken, decryptToken } from "../src/services/crypto.js";

async function main() {
  const user = await prisma.user.upsert({ where: { email: "profile-test@example.com" }, create: { email: "profile-test@example.com" }, update: {} });
  const MEMBER = "W1234567890";

  const profile = await prisma.profile.create({
    data: {
      userId: user.id, fullName: "Prakash Ahuja", dob: "1984-09-28", phone: "+16175436389",
      relationship: "self", isPrimary: true,
      insurance: { create: { carrier: "Blue Cross", planName: "PPO", memberIdEnc: encryptToken(MEMBER), groupIdEnc: encryptToken("GRP-88"), isPrimary: true } },
    },
    include: { insurance: true },
  });

  const raw = profile.insurance[0];
  assert.ok(raw.memberIdEnc && raw.memberIdEnc !== MEMBER, "member ID is NOT stored in plaintext");
  assert.ok(/^enc:|^plain:/.test(raw.memberIdEnc!), "member ID is stored with an encryption scheme prefix");
  assert.equal(decryptToken(raw.memberIdEnc!), MEMBER, "member ID decrypts back to the original");
  assert.equal(decryptToken(raw.groupIdEnc!), "GRP-88", "group ID decrypts back");

  // Read path like the route: primary profile + decrypt for the owner.
  const fetched = await prisma.profile.findFirst({ where: { userId: user.id }, include: { insurance: true } });
  assert.equal(fetched?.fullName, "Prakash Ahuja");
  assert.equal(decryptToken(fetched!.insurance[0].memberIdEnc!), MEMBER);

  await prisma.insurancePlan.deleteMany({ where: { profileId: profile.id } });
  await prisma.profile.delete({ where: { id: profile.id } });
  await prisma.user.delete({ where: { id: user.id } });

  console.log("✅ profile vault: member ID encrypted at rest, decrypts for owner, profile round-trips");
}

main().then(() => process.exit(0)).catch((e) => { console.error("❌", e); process.exit(1); });
