// Deterministic seed for the E2E QA agent (qa/). Builds ONE fixed household — operator + three members
// (a minor, an aging parent, a consenting adult) — with profiles, insurance wallets, saved providers,
// conditions, lab trends, past + upcoming appointments, an in-flight booking, and a spread of tasks
// (needs_you / waiting / handled). The point is that EVERY screen the agent visits is populated, so the
// designer's-eye + "does Klove do the work" review judges real layouts, not empty states.
//
// Idempotent: it deletes the existing E2E household (by the operator's fixed email) and recreates it, so
// reruns are safe. Mock mode only — no external calls. Run: `npm run seed:e2e` (see package.json) or
// `tsx --env-file=.env scripts/seed-e2e.ts`. The app then logs in as OPERATOR_EMAIL via KLOVE_TEST_EMAIL.

import { prisma } from "../src/db.js";
import { ensureHousehold } from "../src/services/household.js";
import { upsertProfile, addInsurance } from "../src/services/profiles.js";
import { upsertProvider } from "../src/services/providers.js";
import { toJson } from "../src/services/json.js";

const OPERATOR_EMAIL = "operator@klove.e2e";
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const ahead = (days: number) => new Date(Date.now() + days * DAY);

/** Remove the existing E2E household and every row hanging off the operator + its managed members. */
async function cleanup(): Promise<void> {
  const operator = await prisma.user.findUnique({ where: { email: OPERATOR_EMAIL }, select: { id: true } });
  if (!operator) return;
  const household = await prisma.household.findUnique({ where: { operatorUserId: operator.id }, select: { id: true } });
  const memberIds = new Set<string>([operator.id]);
  if (household) {
    const memberships = await prisma.householdMembership.findMany({ where: { householdId: household.id }, select: { userId: true } });
    for (const m of memberships) memberIds.add(m.userId);
  }
  const ids = [...memberIds];
  // Order matters: children before parents to satisfy FK constraints.
  await prisma.callResult.deleteMany({ where: { callTarget: { session: { userId: { in: ids } } } } });
  await prisma.callTarget.deleteMany({ where: { session: { userId: { in: ids } } } });
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.appointment.deleteMany({ where: { userId: { in: ids } } });
  await prisma.reminder.deleteMany({ where: { subjectUserId: { in: ids } } });
  await prisma.message.deleteMany({ where: { subjectUserId: { in: ids } } });
  await prisma.task.deleteMany({ where: { subjectUserId: { in: ids } } });
  await prisma.observation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.condition.deleteMany({ where: { userId: { in: ids } } });
  await prisma.healthAlert.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await prisma.provider.deleteMany({ where: { household: { operatorUserId: operator.id } } }).catch(() => {});
  await prisma.consentGrant.deleteMany({ where: { OR: [{ granteeUserId: { in: ids } }, { subjectUserId: { in: ids } }] } });
  await prisma.insurancePlan.deleteMany({ where: { profile: { userId: { in: ids } } } }).catch(() => {});
  await prisma.profile.deleteMany({ where: { userId: { in: ids } } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: ids } } });
  if (household) await prisma.household.delete({ where: { id: household.id } }).catch(() => {});
  // Managed members are login-less Users we own; delete them with the operator.
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

/** Create a managed (login-less) household member with an active operate grant — mirrors POST /members. */
async function createManagedMember(
  operatorUserId: string,
  householdId: string,
  displayName: string,
  relationship: string,
  memberType: string,
  consent: "active" | "pending" = "active",
): Promise<string> {
  const member = await prisma.user.create({ data: { displayName, managed: true, managedByUserId: operatorUserId } });
  await prisma.householdMembership.create({ data: { householdId, userId: member.id, relationship, memberType } });
  await prisma.consentGrant.create({
    data: {
      granteeUserId: operatorUserId,
      subjectUserId: member.id,
      householdId,
      accessLevel: "operate",
      categories: JSON.stringify(["all"]),
      status: consent,
    },
  });
  return member.id;
}

async function seed(): Promise<void> {
  await cleanup();

  // ---- Operator (self) ----
  const operator = await prisma.user.create({ data: { email: OPERATOR_EMAIL } });
  const householdId = await ensureHousehold(operator.id, "The Carter Family");
  await upsertProfile(operator.id, {
    fullName: "Alyssa Carter",
    dob: "1986-03-14",
    phone: "+12065551234",
    email: OPERATOR_EMAIL,
    address: "1100 Bellevue Way NE, Bellevue, WA 98004",
  }, "self");
  await addInsurance(operator.id, { carrier: "Aetna", planName: "Aetna PPO", memberId: "W123456789", groupId: "GRP-558", isPrimary: true });

  // ---- Members ----
  const childId = await createManagedMember(operator.id, householdId, "Theo Carter", "child", "minor");
  await upsertProfile(childId, { fullName: "Theo Carter", dob: "2016-09-02" }, "child");
  await addInsurance(childId, { carrier: "Aetna", planName: "Aetna PPO (family)", memberId: "W123456790", groupId: "GRP-558", isPrimary: true });

  const parentId = await createManagedMember(operator.id, householdId, "Margaret Carter", "parent", "aging_parent");
  await upsertProfile(parentId, { fullName: "Margaret Carter", dob: "1952-11-20", phone: "+12065559876" }, "parent");
  await addInsurance(parentId, { carrier: "Medicare", planName: "Medicare Part B", memberId: "1EG4-TE5-MK72", isPrimary: true });
  await addInsurance(parentId, { carrier: "AARP", planName: "Medigap Plan G", memberId: "AARP-44182", isSecondary: true });

  // Consenting adult — left PENDING so the invite/consent flow is testable in its real, not-yet-shared state.
  await createManagedMember(operator.id, householdId, "Jordan Carter", "spouse", "consenting_adult", "pending");

  // ---- Saved provider directory (so "your providers" isn't empty in the booking picker) ----
  await upsertProvider({ householdId, subjectUserId: operator.id, name: "Glow Dermatology", phone: "+12065551212", website: "https://glowderm.example", address: "500 108th Ave NE, Bellevue, WA", specialty: "dermatologist", source: "search", acceptedCarriers: ["aetna"], usedAt: ago(40) });
  await upsertProvider({ householdId, subjectUserId: parentId, name: "Overlake Cardiology", phone: "+14256885000", address: "1035 116th Ave NE, Bellevue, WA 98004", specialty: "cardiologist", source: "appointment", usedAt: ago(20) });

  // ---- Clinical context: a condition + an A1c trend for the operator, so Records/Today have substance ----
  await prisma.condition.create({ data: { userId: operator.id, sourceType: "seed", display: "Type 2 diabetes mellitus", clinicalStatus: "active" } });
  for (const [v, d, flag] of [[7.4, ago(180), "H"], [6.9, ago(90), "H"], [6.3, ago(10), null]] as [number, Date, string | null][]) {
    await prisma.observation.create({ data: { userId: operator.id, sourceType: "seed", display: "Hemoglobin A1c", valueNum: v, unit: "%", effectiveAt: d, abnormalFlag: flag ?? undefined } });
  }
  await prisma.observation.create({ data: { userId: parentId, sourceType: "seed", display: "Blood pressure (systolic)", valueNum: 148, unit: "mmHg", effectiveAt: ago(15), abnormalFlag: "H" } });

  // ---- Appointments: one upcoming (drives Today + reminders + prep) and one past (timeline) ----
  await prisma.appointment.create({ data: { userId: operator.id, sourceType: "seed", title: "Dermatology follow-up", provider: "Glow Dermatology", status: "scheduled", startsAt: ahead(5) } });
  await prisma.appointment.create({ data: { userId: parentId, sourceType: "seed", title: "Cardiology check-up", provider: "Overlake Cardiology", status: "scheduled", startsAt: ahead(12) } });
  await prisma.appointment.create({ data: { userId: operator.id, sourceType: "seed", title: "Annual physical", provider: "Bellevue Primary Care", status: "completed", startsAt: ago(95) } });

  // ---- Tasks spanning all three Today/Actions buckets ----
  // An in-flight booking for the cross-flow agent scenario (E4: "which office am I booking with?").
  // Intentionally NOT linked to a Session via conciergeJobId: the global reconcileConciergeJobs() sweep
  // (concierge.ts) grabs every waiting+book+conciergeJobId task across ALL households, so a seeded one
  // would mutate on any backend-test run that calls reconcile (the QA seed and the test suite share the
  // dev DB). loadBookingActivity() reads the office from bookingJson.provider, so E4 still works and this
  // task stays inert to the sweep.
  await prisma.task.create({
    data: {
      subjectUserId: operator.id, householdId, title: "Booking: Botox for migraines",
      detail: "Klove is contacting Overlake Neurology.", state: "waiting", kind: "book", originChannel: "app",
      bookingJson: toJson({ when: null, whenText: null, provider: "Overlake Neurology", confirmation: null, verified: false }),
    },
  });
  await prisma.task.create({ data: { subjectUserId: operator.id, householdId, title: "A1c due — schedule a recheck", detail: "Last A1c was 3 months ago.", state: "needs_you", kind: "review" } });
  await prisma.task.create({ data: { subjectUserId: childId, householdId, title: "Theo's well-child visit is overdue", state: "needs_you", kind: "book" } });
  await prisma.task.create({
    data: {
      subjectUserId: operator.id, householdId, title: "Dermatology visit", detail: "Confirmed with Glow Dermatology.", state: "handled", kind: "book",
      bookingJson: toJson({ when: ahead(5).toISOString(), whenText: "next Tuesday at 9:00 AM", provider: "Glow Dermatology", confirmation: "GD-4471", verified: true }),
    },
  });

  const counts = {
    members: await prisma.householdMembership.count({ where: { householdId } }),
    insurance: await prisma.insurancePlan.count({ where: { profile: { userId: { in: [operator.id, childId, parentId] } } } }),
    appointments: await prisma.appointment.count({ where: { userId: { in: [operator.id, parentId] } } }),
    tasks: await prisma.task.count({ where: { householdId } }),
  };
  console.log("✅ Seeded E2E household 'The Carter Family'");
  console.log(`   operator: ${OPERATOR_EMAIL}  (launch the app with KLOVE_TEST_EMAIL=${OPERATOR_EMAIL})`);
  console.log(`   ${counts.members} members · ${counts.insurance} insurance cards · ${counts.appointments} appointments · ${counts.tasks} tasks`);
}

seed()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("seed-e2e failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
