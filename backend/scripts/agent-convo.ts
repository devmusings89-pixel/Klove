// Back-and-forth conversation harness for the WhatsApp concierge agent. Runs a scripted multi-turn
// dialogue through handleInboundMessage with the LIVE LLM, exercising: history carryover, the
// confirm-before-execute gate, topic switches, propose→cancel, and briefing — all in one thread.
//
// We disable Vapi + Google Places up front (so no real calls/lookups fire; office search falls back
// to a simulated placeholder) while keeping the LLM on. LIVE_BOOKING stays as configured, so a
// confirmed booking kicks off the (mock) orchestrator and replies "on it".
//
//   npx tsx --env-file=.env scripts/agent-convo.ts

// IMPORTANT: mutate env BEFORE importing anything that reads config at module load.
process.env.VAPI_API_KEY = "";
process.env.VAPI_ASSISTANT_ID = "";
process.env.VAPI_PHONE_NUMBER_ID = "";
process.env.GOOGLE_PLACES_API_KEY = "";

const { prisma } = await import("../src/db.js");
const { ensureHousehold } = await import("../src/services/household.js");
const { handleInboundMessage } = await import("../src/services/agent.js");
const { llmAvailable } = await import("../src/services/llm-tool.js");
const { enabled, config } = await import("../src/config.js");

const SUFFIX = `convo-${process.pid}-${Date.now()}`;
const userIds: string[] = [];

async function seed() {
  const op = await prisma.user.create({
    data: { email: `jordan.${SUFFIX}@klove.test`, displayName: "Jordan", whatsappPhone: `+1206111${String(Date.now()).slice(-4)}`, whatsappVerified: true, dob: new Date("1971-09-03") },
  });
  userIds.push(op.id);
  const householdId = await ensureHousehold(op.id);
  await prisma.profile.create({ data: { userId: op.id, fullName: "Jordan Park", isPrimary: true, address: "Austin, TX" } });
  await prisma.condition.createMany({
    data: [
      { userId: op.id, sourceType: "seed", display: "Type 2 diabetes mellitus", clinicalStatus: "active" },
      { userId: op.id, sourceType: "seed", display: "Hyperlipidemia", clinicalStatus: "active" },
    ],
  });
  await prisma.medicationStatement.create({ data: { userId: op.id, sourceType: "seed", display: "Metformin 1000mg", status: "active", dosage: "1000mg twice daily" } });
  await prisma.observation.createMany({
    data: [
      { userId: op.id, sourceType: "seed", display: "Hemoglobin A1c", valueNum: 7.1, unit: "%", abnormalFlag: "H", effectiveAt: new Date("2026-05-10") },
      { userId: op.id, sourceType: "seed", display: "Hemoglobin A1c", valueNum: 7.9, unit: "%", abnormalFlag: "H", effectiveAt: new Date("2025-11-10") },
      { userId: op.id, sourceType: "seed", display: "LDL Cholesterol", valueNum: 132, unit: "mg/dL", abnormalFlag: "H", effectiveAt: new Date("2026-05-10") },
    ],
  });
  await prisma.appointment.create({ data: { userId: op.id, sourceType: "seed", title: "Endocrinology follow-up", provider: "Dr. Patel", status: "scheduled", verified: true, startsAt: new Date(Date.now() + 6 * 86_400_000) } });
  return { id: op.id, householdId };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  await prisma.agentConversation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.message.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.reminder.deleteMany({ where: { subjectUserId: { in: userIds } } });
  // The running dev server's reconcile tick can write a fresh CallResult mid-cleanup — retry the
  // session teardown so a race doesn't orphan rows in the shared DB.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await prisma.callResult.deleteMany({ where: { callTarget: { session: { userId: { in: userIds } } } } });
      await prisma.callTarget.deleteMany({ where: { session: { userId: { in: userIds } } } });
      await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(500);
    }
  }
  await prisma.task.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.appointment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.observation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.condition.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.medicationStatement.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.profile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.household.deleteMany({ where: { operatorUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

// A thread that stresses the "smart human" upgrades: follow-ups with NO routing keywords (turns 4 & 6
// would misroute under a context-free classifier), a natural confirmation ("yeah do it"), and
// proactive grounded answers.
const TURNS = [
  "hey, what's on my radar this week?", // briefing
  "anything in my labs I should flag?", // healthqa — should surface highs + offer to act
  "is the a1c getting better?", // healthqa — trend (history: "that")
  "ok let's get me in with an endocrinologist", // booking — NO "book" keyword → needs context-aware routing
  "yeah do it", // natural confirmation → execute
  "what should I bring up with them?", // prep — "them" = the endo; NO "ask/prep" keyword
];

const op = await seed();
console.log(`llm=${llmAvailable()} vapi=${enabled.vapi()} places=${enabled.googlePlaces()} liveBooking=${config.liveBooking}\n`);

try {
  for (const t of TURNS) {
    let reply = "";
    try {
      reply = await handleInboundMessage({ id: op.id, whatsappVerified: true }, t);
    } catch (err) {
      reply = `ERROR: ${(err as Error).message}`;
    }
    const convo = await prisma.agentConversation.findUnique({ where: { userId: op.id }, select: { pendingAction: true } });
    console.log(`🧑 ${t}`);
    console.log(`🤖 ${reply}`);
    console.log(`   ⟨pending: ${convo?.pendingAction ? "YES" : "—"}⟩\n`);
  }
} finally {
  await cleanup();
  await prisma.$disconnect();
}
