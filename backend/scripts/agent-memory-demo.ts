// Cross-session memory demo. Session 1: the user states a standing preference. We then wipe the chat
// history (simulating a brand-new conversation days later) but keep the persisted memory, and show
// the agent applying the remembered preference in Session 2. Vapi/Places off (no real calls); LLM on.
//
//   npx tsx --env-file=.env scripts/agent-memory-demo.ts

process.env.VAPI_API_KEY = "";
process.env.VAPI_ASSISTANT_ID = "";
process.env.VAPI_PHONE_NUMBER_ID = "";
process.env.GOOGLE_PLACES_API_KEY = "";

const { prisma } = await import("../src/db.js");
const { ensureHousehold } = await import("../src/services/household.js");
const { handleInboundMessage } = await import("../src/services/agent.js");
const { loadMemory } = await import("../src/services/agent-memory.js");
const { llmAvailable } = await import("../src/services/llm-tool.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SUFFIX = `mem-${process.pid}-${Date.now()}`;
const userIds: string[] = [];

async function seed() {
  const op = await prisma.user.create({
    data: { email: `sam.${SUFFIX}@klove.test`, displayName: "Sam", whatsappPhone: `+1206222${String(Date.now()).slice(-4)}`, whatsappVerified: true },
  });
  userIds.push(op.id);
  const householdId = await ensureHousehold(op.id);
  await prisma.profile.create({ data: { userId: op.id, fullName: "Sam Lee", isPrimary: true, address: "Denver, CO" } });
  return { id: op.id, householdId };
}

async function cleanup() {
  await prisma.agentConversation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.message.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.reminder.deleteMany({ where: { subjectUserId: { in: userIds } } });
  for (let i = 0; i < 4; i++) {
    try {
      await prisma.callResult.deleteMany({ where: { callTarget: { session: { userId: { in: userIds } } } } });
      await prisma.callTarget.deleteMany({ where: { session: { userId: { in: userIds } } } });
      await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      break;
    } catch {
      await sleep(500);
    }
  }
  await prisma.task.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.appointment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.profile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.householdMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.household.deleteMany({ where: { operatorUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const op = await seed();
console.log(`llm=${llmAvailable()}\n`);

try {
  console.log("── Session 1 ──");
  for (const t of ["hey! note for the future — I always prefer morning appointments, and I'm on Aetna insurance"]) {
    const reply = await handleInboundMessage({ id: op.id, whatsappVerified: true }, t);
    console.log(`🧑 ${t}\n🤖 ${reply}\n`);
  }
  // Memory is written fire-and-forget; wait for it to land.
  let mem: string[] = [];
  for (let i = 0; i < 25 && !mem.length; i++) {
    mem = await loadMemory(op.id);
    if (!mem.length) await sleep(400);
  }
  console.log(`🧠 remembered across sessions: ${JSON.stringify(mem)}\n`);

  // Simulate a brand-new conversation days later: clear the chat history, keep the memory.
  await prisma.message.deleteMany({ where: { subjectUserId: op.id, channel: "whatsapp" } });

  console.log("── Session 2 (fresh thread — history cleared, memory kept) ──");
  for (const t of ["can you book me a dermatologist?"]) {
    const reply = await handleInboundMessage({ id: op.id, whatsappVerified: true }, t);
    console.log(`🧑 ${t}\n🤖 ${reply}\n`);
  }
} finally {
  await cleanup();
  await prisma.$disconnect();
}
