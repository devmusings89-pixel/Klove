// END-TO-END live test: simulate the user texting the concierge, have it place a REAL Vapi call to a
// real number, and watch the result flow back (via the ngrok webhook → running dev server → DB) into
// a final "booked" message. Uses the real .env (Vapi live, LIVE_BOOKING on).
//
//   npx tsx --env-file=.env scripts/agent-e2e-call.ts
//
// ⚠️ This RINGS a real phone (the OFFICE number below). Answer and play the office receptionist.

import { prisma } from "../src/db.js";
import { ensureHousehold } from "../src/services/household.js";
import { handleInboundMessage } from "../src/services/agent.js";
import { fromJson } from "../src/services/json.js";

const OFFICE = "206-351-8641"; // the number Klove will actually call (you, playing the office)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SUFFIX = `e2e-${process.pid}-${Date.now()}`;
const userIds: string[] = [];

async function seed() {
  const op = await prisma.user.create({
    data: { email: `you.${SUFFIX}@klove.test`, displayName: "Alex Rivera", whatsappPhone: `+1206900${String(Date.now()).slice(-4)}`, whatsappVerified: true, dob: new Date("1984-07-22") },
  });
  userIds.push(op.id);
  const householdId = await ensureHousehold(op.id);
  await prisma.profile.create({ data: { userId: op.id, fullName: "Alex Rivera", dob: "1984-07-22", isPrimary: true, address: "Seattle, WA" } });
  return { id: op.id, householdId };
}

async function say(opId: string, text: string) {
  console.log(`\n🧑 ${text}`);
  const reply = await handleInboundMessage({ id: opId, whatsappVerified: true }, text);
  console.log(`🤖 ${reply}`);
  return reply;
}

async function cleanup() {
  await prisma.agentConversation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.message.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.reminder.deleteMany({ where: { subjectUserId: { in: userIds } } });
  for (let i = 0; i < 5; i++) {
    try {
      await prisma.callResult.deleteMany({ where: { callTarget: { session: { userId: { in: userIds } } } } });
      await prisma.callTarget.deleteMany({ where: { session: { userId: { in: userIds } } } });
      await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      break;
    } catch {
      await sleep(600);
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

const DRY = process.env.DRY_RUN === "1";

try {
  console.log(`════════ Booking conversation (simulated user texts)${DRY ? " — DRY RUN, no call" : ""} ════════`);
  const setup = [
    "hey! can you book me a dermatology appointment for next week?",
    `the office is Cedar Dermatology — their number is ${OFFICE}`,
    "my insurance is Aetna, member ID W7741822",
  ];
  for (const t of setup) await say(op.id, t);
  if (DRY) {
    const convo = await prisma.agentConversation.findUnique({ where: { userId: op.id }, select: { pendingAction: true } });
    console.log(`\n⟨pending action: ${convo?.pendingAction ?? "none"}⟩`);
    console.log("DRY RUN — stopping before 'yes'/the call.");
  } else {
  await say(op.id, "yes");

  const task = await prisma.task.findFirst({
    where: { subjectUserId: op.id, kind: { in: ["book", "choose_time", "verify_code", "provide_info"] } },
    orderBy: { createdAt: "desc" },
  });
  const sessionId = task?.conciergeJobId ?? null;
  console.log(`\n📞 Placing a REAL call to ${OFFICE} … answer your phone and play the office. (session ${sessionId ?? "?"})`);

  let lastStatus = "";
  let printedResult = false;
  let done = false;
  for (let i = 0; i < 100 && !done; i++) {
    await sleep(5000);
    if (!sessionId) break;
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { targets: { include: { results: { orderBy: { createdAt: "desc" } } } } },
    });
    const t = session?.targets[0];
    if (t && t.status !== lastStatus) {
      console.log(`   • call status: ${t.status}${t.vapiCallId ? ` (vapi ${t.vapiCallId.slice(0, 8)}…)` : ""}`);
      lastStatus = t.status;
    }
    const res = t?.results?.[0];
    if (res && !printedResult && (res.transcript || res.summary || res.structuredData)) {
      if (res.summary) console.log(`\n📝 Call summary: ${res.summary}`);
      const sd = fromJson<Record<string, unknown> | null>(res.structuredData ?? null, null);
      if (sd) console.log(`📊 Structured outcome: ${JSON.stringify(sd)}`);
      if (res.transcript) console.log(`\n🗒️  Transcript:\n${res.transcript}\n`);
      printedResult = true;
    }
    const cur = task ? await prisma.task.findUnique({ where: { id: task.id } }) : null;
    if (cur && cur.state !== "waiting") {
      const msg = await prisma.message.findFirst({ where: { subjectUserId: op.id, direction: "out" }, orderBy: { createdAt: "desc" } });
      console.log(`\n🤖 (agent follow-up) ${msg?.title ? `${msg.title}: ` : ""}${msg?.body ?? "(none)"}`);
      const appt = await prisma.appointment.findFirst({ where: { userId: op.id }, orderBy: { recordedAt: "desc" } });
      if (appt) console.log(`📅 Appointment: ${appt.title}${appt.provider ? ` w/ ${appt.provider}` : ""}${appt.startsAt ? ` @ ${appt.startsAt.toISOString()}` : ""}${appt.confirmation ? ` · conf ${appt.confirmation}` : ""} · verified=${appt.verified}`);
      console.log(`\n✅ Final task state: ${cur.state} (${cur.kind}) — "${cur.title}"`);
      done = true;
    }
  }
  if (!done) console.log("\n⏲️  Timed out waiting for the call to complete.");
  }
} finally {
  console.log("\n(cleaning up test data…)");
  await cleanup();
  await prisma.$disconnect();
}
