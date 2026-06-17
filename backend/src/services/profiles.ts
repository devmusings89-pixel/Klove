// Shared profile + insurance-wallet logic, used by both the operator's own "My Info" (/profile)
// and the per-member routes (/members/:id/profile, /members/:id/insurance).
//
// Insurance is a COLLECTION (a wallet): one operator holds many cards — the family plan, a spouse's
// employer plan, an aging parent's Medicare + supplement. Each member (self/child/parent/adult) has
// their own Profile with its own insurance[] so a booking can carry the right card per person.
// Member/group IDs are envelope-encrypted at rest (crypto.ts).

import { prisma } from "../db.js";
import { encryptToken, decryptToken } from "./crypto.js";

export interface ProfileInput {
  fullName?: string;
  dob?: string;
  phone?: string;
  email?: string;
  address?: string;
  relationship?: string;
}

export interface InsuranceInput {
  carrier?: string;
  planName?: string;
  memberId?: string;
  groupId?: string;
  rxBin?: string;
  rxPcn?: string;
  holderName?: string;
  isPrimary?: boolean;
  isSecondary?: boolean;
}

export function primaryProfile(userId: string) {
  return prisma.profile.findFirst({
    where: { userId },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    include: { insurance: { orderBy: [{ isPrimary: "desc" }, { isSecondary: "desc" }, { createdAt: "asc" }] } },
  });
}

/** Ensure a profile row exists for a user (creating a minimal one if needed). */
export async function ensureProfile(userId: string, relationship = "self") {
  const existing = await primaryProfile(userId);
  if (existing) return existing;
  return prisma.profile.create({
    data: { userId, fullName: "", relationship, isPrimary: true },
    include: { insurance: { orderBy: [{ isPrimary: "desc" }, { isSecondary: "desc" }, { createdAt: "asc" }] } },
  });
}

export async function upsertProfile(userId: string, input: ProfileInput, relationship?: string) {
  const existing = await primaryProfile(userId);
  const data = {
    fullName: input.fullName ?? existing?.fullName ?? "",
    dob: input.dob,
    phone: input.phone,
    email: input.email,
    address: input.address,
    relationship: relationship ?? input.relationship ?? existing?.relationship ?? "self",
    isPrimary: true,
  };
  return existing
    ? prisma.profile.update({ where: { id: existing.id }, data, include: { insurance: true } })
    : prisma.profile.create({ data: { ...data, userId }, include: { insurance: true } });
}

function encodeInsurance(i: InsuranceInput) {
  return {
    carrier: i.carrier ?? null,
    planName: i.planName ?? null,
    memberIdEnc: i.memberId ? encryptToken(i.memberId) : null,
    groupIdEnc: i.groupId ? encryptToken(i.groupId) : null,
    rxBin: i.rxBin ?? null,
    rxPcn: i.rxPcn ?? null,
    holderName: i.holderName ?? null,
  };
}

/**
 * Add a card to a user's wallet. First card becomes primary; an explicit isPrimary/isSecondary
 * re-points the single primary/backup slot. A card is at most one of primary or backup.
 */
export async function addInsurance(userId: string, input: InsuranceInput) {
  const profile = await ensureProfile(userId);
  const count = await prisma.insurancePlan.count({ where: { profileId: profile.id } });
  const makePrimary = input.isPrimary ?? count === 0;
  const makeSecondary = !makePrimary && (input.isSecondary ?? false);
  if (makePrimary) {
    await prisma.insurancePlan.updateMany({ where: { profileId: profile.id }, data: { isPrimary: false } });
  }
  if (makeSecondary) {
    await prisma.insurancePlan.updateMany({ where: { profileId: profile.id }, data: { isSecondary: false } });
  }
  await prisma.insurancePlan.create({
    data: { ...encodeInsurance(input), isPrimary: makePrimary, isSecondary: makeSecondary, profileId: profile.id },
  });
  return listInsurance(userId);
}

/** Update one card by id (must belong to this user's profile). */
export async function updateInsurance(userId: string, planId: string, input: InsuranceInput) {
  const profile = await primaryProfile(userId);
  if (!profile) return null;
  const plan = profile.insurance.find((p) => p.id === planId);
  if (!plan) return null;
  // Primary wins if both are set; a card is at most one of primary/backup. Flags are only touched
  // when explicitly provided: `true` promotes (re-pointing the single slot), `false` demotes,
  // `undefined` leaves the role as-is (so a plain field edit never disturbs the wallet's roles).
  const makePrimary = input.isPrimary === true;
  const makeSecondary = !makePrimary && input.isSecondary === true;
  if (makePrimary) {
    await prisma.insurancePlan.updateMany({ where: { profileId: profile.id }, data: { isPrimary: false } });
  }
  if (makeSecondary) {
    await prisma.insurancePlan.updateMany({ where: { profileId: profile.id }, data: { isSecondary: false } });
  }
  const roleData: { isPrimary?: boolean; isSecondary?: boolean } = {};
  if (makePrimary) { roleData.isPrimary = true; roleData.isSecondary = false; }
  else if (makeSecondary) { roleData.isSecondary = true; roleData.isPrimary = false; }
  else {
    if (input.isPrimary === false) roleData.isPrimary = false;
    if (input.isSecondary === false) roleData.isSecondary = false;
  }
  await prisma.insurancePlan.update({
    where: { id: planId },
    data: { ...encodeInsurance(input), ...roleData },
  });
  return listInsurance(userId);
}

export async function deleteInsurance(userId: string, planId: string) {
  const profile = await primaryProfile(userId);
  if (!profile) return null;
  const plan = profile.insurance.find((p) => p.id === planId);
  if (!plan) return null;
  await prisma.insurancePlan.delete({ where: { id: planId } });
  return listInsurance(userId);
}

/** All cards for a user, decrypted, primary first. */
export async function listInsurance(userId: string) {
  const profile = await primaryProfile(userId);
  if (!profile) return [];
  return profile.insurance.map(serializeCard);
}

export function serializeCard(plan: {
  id: string; carrier: string | null; planName: string | null; memberIdEnc: string | null;
  groupIdEnc: string | null; rxBin: string | null; rxPcn: string | null; holderName: string | null;
  isPrimary: boolean; isSecondary?: boolean;
}) {
  return {
    id: plan.id,
    carrier: plan.carrier,
    planName: plan.planName,
    memberId: plan.memberIdEnc ? decryptToken(plan.memberIdEnc) : null,
    groupId: plan.groupIdEnc ? decryptToken(plan.groupIdEnc) : null,
    rxBin: plan.rxBin,
    rxPcn: plan.rxPcn,
    holderName: plan.holderName,
    isPrimary: plan.isPrimary,
    isSecondary: plan.isSecondary ?? false,
  };
}

/** Serialize a profile with its full insurance wallet (array). */
export async function serializeProfile(userId: string) {
  const p = await primaryProfile(userId);
  if (!p) return null;
  const plans = p.insurance.map(serializeCard);
  return {
    id: p.id,
    fullName: p.fullName,
    dob: p.dob,
    phone: p.phone,
    email: p.email,
    address: p.address,
    relationship: p.relationship,
    // Back-compat: `insurance` = the primary card; `insurancePlans` = the full wallet.
    insurance: plans[0] ?? null,
    insurancePlans: plans,
  };
}
