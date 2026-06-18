// Concierge booking (Klove). Turns a booking request into an appointment on the member's behalf.
//
// Two modes:
//  - SIMULATED (default): deterministically confirms a booking. Safe; never contacts anyone.
//  - LIVE (LIVE_BOOKING=true): creates a real booking Session + CallTarget and runs the orchestrator
//    (Vapi voice / web / email). The result arrives asynchronously; reconcileConciergeJobs() turns a
//    completed job into a confirmed Appointment + handled Task + inbox confirmation.

import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { config, enabled } from "../config.js";
import { toJson, fromJson } from "./json.js";
import { placeNextCall } from "./orchestrator.js";
import { lookupPhoneNumber, lookupWebsite } from "./lookup.js";
import { notifyUser } from "./notify.js";
import { decryptToken } from "./crypto.js";
import type { CallStructuredData } from "../types.js";

/**
 * Assemble the patient details the AI needs to introduce on the call (name, DOB, insurance), pulled
 * from the member's saved profile — falling back to the operator's profile for insurance/phone, since
 * a managed member (e.g. a child) is often on the operator's plan.
 */
async function buildPatientInfo(
  subjectUserId: string,
  operatorUserId: string,
  input: BookingInput,
  reason: string,
): Promise<Record<string, string>> {
  const member = await prisma.user.findUnique({ where: { id: subjectUserId }, select: { displayName: true, dob: true } });
  const memberProfile = await prisma.profile.findFirst({
    where: { userId: subjectUserId },
    orderBy: { isPrimary: "desc" },
    include: { insurance: { orderBy: [{ isPrimary: "desc" }, { isSecondary: "desc" }, { createdAt: "asc" }] } },
  });
  const opProfile =
    operatorUserId !== subjectUserId
      ? await prisma.profile.findFirst({ where: { userId: operatorUserId }, orderBy: { isPrimary: "desc" }, include: { insurance: { orderBy: [{ isPrimary: "desc" }, { isSecondary: "desc" }, { createdAt: "asc" }] } } })
      : null;
  // Prefer the explicitly-linked card; else the member's primary; else the operator's primary.
  const allPlans = [...(memberProfile?.insurance ?? []), ...(opProfile?.insurance ?? [])];
  const chosen = input.insurancePlanId ? allPlans.find((p) => p.id === input.insurancePlanId) : undefined;
  const plan = chosen ?? memberProfile?.insurance?.[0] ?? opProfile?.insurance?.[0];
  const memberId = plan?.memberIdEnc ? decryptToken(plan.memberIdEnc) : "";
  return {
    name: (member?.displayName || memberProfile?.fullName || "the patient").trim(),
    dob: memberProfile?.dob || (member?.dob ? member.dob.toISOString().slice(0, 10) : ""),
    reason,
    insurance: [plan?.carrier, plan?.planName].filter(Boolean).join(" "),
    additionalInfo: memberId ? `Insurance member ID: ${memberId}` : "",
    preferredTimes: input.preferredTimes ?? input.preferredDate ?? "",
    acceptableWindow: input.preferredTimes ?? "",
    patientPhone: memberProfile?.phone || opProfile?.phone || "",
  };
}

/** Notify the operator who runs this household (push + WhatsApp via the channel-aware dispatcher).
 * `link` deep-links the push to the right tab on tap ("actions" for needs-you, "today" for booked). */
async function pushToOperator(householdId: string, title: string, body: string, link?: string): Promise<void> {
  const hh = await prisma.household.findUnique({ where: { id: householdId }, select: { operatorUserId: true } });
  if (hh) await notifyUser(hh.operatorUserId, { title, body, link }).catch((e) => console.error("operator notify failed", e));
}

export interface BookingInput {
  reason: string;
  provider?: string;
  preferredDate?: string; // ISO — an exact slot (e.g. when booking a known appointment from prep)
  preferredTimes?: string; // free text — what the patient prefers (e.g. "weekday mornings, after 3pm")
  phone?: string;
  website?: string;
  email?: string;
  // Which saved insurance card (from the member's wallet, or the operator's) to use for THIS booking.
  // Lets the operator book Dad's visit on his Medicare, not her family plan. Falls back to the
  // member's primary card, then the operator's primary card.
  insurancePlanId?: string;
}

export interface BookingOutcome {
  // in_progress = a live booking job is running (office being contacted); needs_info = Klove couldn't
  // reach an office and created a task to finish it. No provisional/fabricated appointment is created.
  status: "in_progress" | "needs_info";
  taskId: string;
  title: string;
  provider: string | null;
  appointmentId?: string;
  confirmation?: string;
  startsAt?: string;
  // The booking session, so the client can show live progress + the transcript right away.
  sessionId?: string;
  // true once a live booking job is placed; false when Klove couldn't reach an office (needs_info).
  verified: boolean;
  // Echoed so the confirm screen shows WHO this was booked for and WHICH coverage was attached.
  patientName?: string;
  insurance?: string;
}

function confirmationCode(): string {
  return `KLV-${randomBytes(3).toString("hex").toUpperCase()}`;
}

function whenLabel(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Book on a member's behalf. Klove books LIVE (Vapi voice / web / email) when LIVE_BOOKING is on and
 * it can reach the office (explicit contact, or a Places lookup by name). It NEVER fabricates a
 * provisional/unverified appointment — if it can't reach an office it returns a "needs_info" outcome
 * and surfaces a task so the operator can finish it.
 */
export async function bookAppointment(
  operatorUserId: string,
  subjectUserId: string,
  householdId: string,
  input: BookingInput,
): Promise<BookingOutcome> {
  // Booking is free and operator-authorized — Klove contacts the office right away.
  const hasContact = Boolean(input.phone || input.website || input.email);
  // With Google Places + a provider name, the orchestrator can look up the office itself — so an
  // office name alone is enough to book live.
  const canLookup = enabled.googlePlaces() && Boolean(input.provider?.trim());
  if (config.liveBooking && (hasContact || canLookup)) {
    return liveBooking(operatorUserId, subjectUserId, householdId, input);
  }
  return couldNotBook(subjectUserId, householdId, input);
}

/** Create a real booking job and start the orchestrator. Returns immediately (async result). */
async function liveBooking(operatorUserId: string, subjectUserId: string, householdId: string, input: BookingInput): Promise<BookingOutcome> {
  const reason = input.reason.trim() || "Appointment";
  const provider = input.provider?.trim() || null;

  // Resolve how to reach the office: explicit contact wins; otherwise look it up by name via Places.
  let phone = input.phone?.trim() || null;
  let website = input.website?.trim() || null;
  const email = input.email?.trim() || null;
  if (!phone && !website && !email && provider && enabled.googlePlaces()) {
    phone = await lookupPhoneNumber(provider);
    if (!phone) website = await lookupWebsite(provider);
  }
  // If there's still no way to reach anyone, don't fabricate a booking — surface a task to finish it.
  if (!phone && !website && !email) {
    return couldNotBook(subjectUserId, householdId, input);
  }

  // Full patient details (name, DOB, insurance) so the AI can introduce the patient on the call.
  const patient = await buildPatientInfo(subjectUserId, operatorUserId, input, reason);

  const session = await prisma.session.create({
    data: {
      userId: subjectUserId,
      tier: "human",
      kind: "booking",
      status: "paid", // skip payment; concierge job is authorized by the operator
      patientInfo: toJson(patient),
      targets: {
        create: {
          officeName: provider ?? reason,
          phoneNumber: phone,
          website,
          channelHints: email ? toJson({ email }) : null,
          order: 0,
          status: "pending",
        },
      },
    },
  });

  const task = await prisma.task.create({
    data: {
      subjectUserId,
      householdId,
      title: `Booking: ${reason}`,
      detail: `Klove is reaching out${provider ? ` to ${provider}` : ""} to schedule this.`,
      state: "waiting",
      kind: "book",
      conciergeJobId: session.id,
    },
  });

  void placeNextCall(session.id); // fire-and-forget; reconcileConciergeJobs finalizes it
  return { status: "in_progress", taskId: task.id, title: reason, provider, sessionId: session.id, verified: true, patientName: patient.name, insurance: patient.insurance };
}

/**
 * Klove couldn't place this booking automatically (no reachable office, or live booking off). We do
 * NOT fabricate an appointment — instead we surface a needs-you task so the operator can finish it
 * (add a phone/website, or pick a provider). No provisional/unverified appointment is ever created.
 */
async function couldNotBook(subjectUserId: string, householdId: string, input: BookingInput): Promise<BookingOutcome> {
  const reason = input.reason.trim() || "Appointment";
  const provider = input.provider?.trim() || null;
  const providerLabel = provider ? ` with ${provider}` : "";

  const task = await prisma.task.create({
    data: {
      subjectUserId,
      householdId,
      title: `Book: ${reason}`,
      detail: `Klove couldn't reach an office to book this automatically${providerLabel}. Add a phone or website, or pick a provider, to continue.`,
      state: "needs_you",
      kind: "book",
    },
  });
  await prisma.message.create({
    data: {
      householdId,
      subjectUserId,
      direction: "out",
      channel: "inapp",
      title: "Couldn't book",
      body: `Klove couldn't reach an office to book ${reason}${providerLabel}. Tap to add contact details or choose a provider.`,
      relatedTaskId: task.id,
    },
  });

  return { status: "needs_info", taskId: task.id, title: reason, provider, verified: false };
}

/**
 * Turn finished live booking jobs into confirmed appointments. Runs on the scheduler tick.
 * Only touches `waiting` book-tasks whose Session has targets (the live booking flow), so it's
 * idempotent — once a task is moved to handled/needs_you it won't be reprocessed.
 */
export async function reconcileConciergeJobs(): Promise<void> {
  const waiting = await prisma.task.findMany({
    where: { state: "waiting", kind: "book", conciergeJobId: { not: null } },
  });

  for (const task of waiting) {
   try {
    const session = await prisma.session.findUnique({
      where: { id: task.conciergeJobId! },
      include: { targets: { include: { results: { orderBy: { createdAt: "desc" } } } } },
    });
    if (!session || session.targets.length === 0) continue; // not a live booking job

    const booked = session.targets.find((t) => t.status === "booked");
    const choosing = session.targets.find((t) => t.status === "awaiting_choice");
    // A live job can stall waiting on the operator: the office required info we didn't have, or an
    // online scheduler sent a one-time code that must be entered. These aren't terminal, but the
    // operator's task would otherwise sit silently in `waiting` — so we surface a needs_you prompt.
    const awaitingVerification = session.targets.find((t) => t.status === "awaiting_verification");
    const awaitingInfo = session.targets.find((t) => t.status === "awaiting_info");
    const terminal = session.status === "completed" || session.status === "failed";
    const reason = task.title.replace(/^Booking:\s*/, "");

    if (booked) {
      const sd = fromJson<CallStructuredData | null>(booked.results[0]?.structuredData ?? null, null);
      // Prefer a real parsed date; if the AI returned natural language ("tomorrow, 2 PM") we keep
      // startsAt empty (so we never show a fabricated precise time) and display the AI's own wording.
      const parsed = sd?.appointmentDateTime ? new Date(sd.appointmentDateTime) : null;
      const when = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
      const whenText = when ? whenLabel(when) : sd?.appointmentDateTime?.trim() || "a time the office confirmed";
      const confirmation = sd?.confirmation || confirmationCode();
      await prisma.appointment.create({
        data: {
          userId: task.subjectUserId,
          sourceType: "klove_booking",
          title: task.title.replace(/^Booking:\s*/, ""),
          provider: booked.officeName,
          providerPhone: booked.phoneNumber,
          providerWebsite: booked.website,
          startsAt: when,
          status: "scheduled",
          confirmation,
          notes: `Booked by Klove (live) · job ${session.id}${when ? "" : ` · time: ${whenText}`}`,
        },
      });
      await prisma.task.update({
        where: { id: task.id },
        data: {
          state: "handled",
          detail: `Confirmed with ${booked.officeName}.`,
          bookingJson: toJson({ when: when ? when.toISOString() : null, whenText, provider: booked.officeName, confirmation, verified: true }),
        },
      });
      await prisma.message.create({
        data: {
          householdId: task.householdId,
          subjectUserId: task.subjectUserId,
          direction: "out",
          channel: "inapp",
          title: "Booked",
          body: `Done — booked for ${whenText} with ${booked.officeName}. Confirmation ${confirmation}.`,
          relatedTaskId: task.id,
        },
      });
      await pushToOperator(task.householdId, "Booked ✅", `${reason} is booked for ${whenText} with ${booked.officeName}.`, "today");
    } else if (choosing) {
      // The requested time wasn't available — the office offered alternates. Ask the operator to pick.
      const slots = fromJson<string[]>(choosing.offeredSlots, []);
      await prisma.task.update({
        where: { id: task.id },
        data: {
          state: "needs_you",
          kind: "choose_time",
          title: `Pick a time: ${reason}`,
          detail: `${choosing.officeName} couldn't do your requested time. Tap to choose from the times they offered.`,
          options: toJson(slots),
        },
      });
      await prisma.message.create({
        data: {
          householdId: task.householdId,
          subjectUserId: task.subjectUserId,
          direction: "out",
          channel: "inapp",
          title: "Choose a time",
          body: `${choosing.officeName} offered ${slots.length} alternate time${slots.length === 1 ? "" : "s"} for ${reason}. Tap to pick one.`,
          relatedTaskId: task.id,
        },
      });
      await pushToOperator(task.householdId, "Choose a time", `${choosing.officeName} offered ${slots.length} alternate times for ${reason} — tap to pick.`, "actions");
    } else if (awaitingVerification) {
      // An online scheduler sent a one-time code; the operator must enter it to finish booking.
      await prisma.task.update({
        where: { id: task.id },
        data: {
          state: "needs_you",
          kind: "verify_code",
          title: `Enter code: ${reason}`,
          detail: `${awaitingVerification.officeName} sent a one-time code${awaitingVerification.verificationContact ? ` to ${awaitingVerification.verificationContact}` : ""}. Tap to enter it so Klove can confirm.`,
        },
      });
      await prisma.message.create({
        data: {
          householdId: task.householdId,
          subjectUserId: task.subjectUserId,
          direction: "out",
          channel: "inapp",
          title: "Verification needed",
          body: `${awaitingVerification.officeName} sent a one-time code to finish booking ${reason}. Tap to enter it.`,
          relatedTaskId: task.id,
        },
      });
      await pushToOperator(task.householdId, "Verification needed", `Enter the code ${awaitingVerification.officeName} sent to finish booking ${reason}.`, "actions");
    } else if (awaitingInfo) {
      // The office required information we didn't have; the operator must supply it.
      const missing = fromJson<string[]>(awaitingInfo.missingInfo, []);
      const missingLabel = missing.length ? ` (${missing.join(", ")})` : "";
      await prisma.task.update({
        where: { id: task.id },
        data: {
          state: "needs_you",
          kind: "provide_info",
          title: `More info needed: ${reason}`,
          detail: `${awaitingInfo.officeName} needs more details${missingLabel} before it can book. Tap to provide them.`,
        },
      });
      await prisma.message.create({
        data: {
          householdId: task.householdId,
          subjectUserId: task.subjectUserId,
          direction: "out",
          channel: "inapp",
          title: "Info needed",
          body: `${awaitingInfo.officeName} needs more details${missingLabel} to book ${reason}. Tap to provide them.`,
          relatedTaskId: task.id,
        },
      });
      await pushToOperator(task.householdId, "Info needed", `${awaitingInfo.officeName} needs more details to book ${reason} — tap to provide them.`, "actions");
    } else if (terminal) {
      // Job finished without a booking (no answer, needs info, etc.) — surface it back to the operator.
      await prisma.task.update({
        where: { id: task.id },
        data: { state: "needs_you", detail: "Klove couldn't complete this booking automatically — tap to review." },
      });
      await pushToOperator(task.householdId, "Action needed", `Klove couldn't finish booking ${reason} — tap to review.`, "actions");
    }
   } catch (err) {
      // Isolate per-job failures so one malformed/orphaned booking can't block all the others.
      console.error("reconcile failed for task", task.id, err);
   }
  }
}
