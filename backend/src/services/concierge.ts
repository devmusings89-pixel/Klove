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
import { sendPushToUser } from "./push.js";
import type { CallStructuredData } from "../types.js";

/** Push to the operator who runs this household (the person managing the booking). */
async function pushToOperator(householdId: string, title: string, body: string): Promise<void> {
  const hh = await prisma.household.findUnique({ where: { id: householdId }, select: { operatorUserId: true } });
  if (hh) await sendPushToUser(hh.operatorUserId, title, body).catch((e) => console.error("operator push failed", e));
}

export interface BookingInput {
  reason: string;
  provider?: string;
  preferredDate?: string; // ISO — an exact slot (e.g. when booking a known appointment from prep)
  preferredTimes?: string; // free text — what the patient prefers (e.g. "weekday mornings, after 3pm")
  phone?: string;
  website?: string;
  email?: string;
}

export interface BookingOutcome {
  status: "confirmed" | "in_progress" | "payment_required";
  taskId: string;
  title: string;
  provider: string | null;
  appointmentId?: string;
  confirmation?: string;
  startsAt?: string;
  priceCents?: number;
}

function confirmationCode(): string {
  return `KLV-${randomBytes(3).toString("hex").toUpperCase()}`;
}

function whenLabel(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Book on a member's behalf. Live when LIVE_BOOKING and contact info is present; else simulated. */
export async function bookAppointment(
  operatorUserId: string,
  subjectUserId: string,
  householdId: string,
  input: BookingInput,
): Promise<BookingOutcome> {
  // Payment gate: when a concierge fee is configured and Stripe is live, require payment before we
  // contact the office. Default (price 0) is operator-authorized + free. The PaymentSheet + confirm
  // loop is the remaining live step (needs a Stripe key + a set price).
  if (config.conciergePriceCents > 0 && enabled.stripe()) {
    return {
      status: "payment_required",
      taskId: "",
      title: input.reason.trim() || "Appointment",
      provider: input.provider?.trim() || null,
      priceCents: config.conciergePriceCents,
    };
  }

  const hasContact = Boolean(input.phone || input.website || input.email);
  // With Google Places + a provider name, the orchestrator can look up the office itself — so an
  // office name alone is enough to book live.
  const canLookup = enabled.googlePlaces() && Boolean(input.provider?.trim());
  if (config.liveBooking && (hasContact || canLookup)) {
    return liveBooking(subjectUserId, householdId, input);
  }
  return simulatedBooking(subjectUserId, householdId, input);
}

/** Create a real booking job and start the orchestrator. Returns immediately (async result). */
async function liveBooking(subjectUserId: string, householdId: string, input: BookingInput): Promise<BookingOutcome> {
  const reason = input.reason.trim() || "Appointment";
  const provider = input.provider?.trim() || null;
  const member = await prisma.user.findUnique({ where: { id: subjectUserId }, select: { displayName: true } });

  // Resolve how to reach the office: explicit contact wins; otherwise look it up by name via Places.
  let phone = input.phone?.trim() || null;
  let website = input.website?.trim() || null;
  const email = input.email?.trim() || null;
  if (!phone && !website && !email && provider && enabled.googlePlaces()) {
    phone = await lookupPhoneNumber(provider);
    if (!phone) website = await lookupWebsite(provider);
  }
  // If there's still no way to reach anyone, confirm a placeholder instead of a dead-end job.
  if (!phone && !website && !email) {
    return simulatedBooking(subjectUserId, householdId, input);
  }

  const session = await prisma.session.create({
    data: {
      userId: subjectUserId,
      tier: "human",
      kind: "booking",
      status: "paid", // skip payment; concierge job is authorized by the operator
      patientInfo: toJson({
        name: member?.displayName ?? "",
        reason,
        // Free-text preference guides the AI on the call; an exact date (from prep) is the window.
        preferredTimes: input.preferredTimes ?? input.preferredDate ?? "",
        acceptableWindow: input.preferredTimes ?? "",
      }),
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
  return { status: "in_progress", taskId: task.id, title: reason, provider };
}

/** Deterministically confirm a booking and surface it across Klove's objects. */
async function simulatedBooking(subjectUserId: string, householdId: string, input: BookingInput): Promise<BookingOutcome> {
  const reason = input.reason.trim() || "Appointment";
  const provider = input.provider?.trim() || null;
  const startsAt = input.preferredDate ? new Date(input.preferredDate) : new Date(Date.now() + 7 * 86_400_000);
  if (Number.isNaN(startsAt.getTime())) startsAt.setTime(Date.now() + 7 * 86_400_000);
  const confirmation = confirmationCode();

  const session = await prisma.session.create({
    data: {
      userId: subjectUserId,
      tier: "human",
      kind: "booking",
      status: "completed",
      patientInfo: toJson({ reason, preferredTimes: input.preferredDate ?? "" }),
      targets: {
        create: {
          officeName: provider ?? reason,
          phoneNumber: input.phone ?? null,
          website: input.website ?? null,
          order: 0,
          status: "booked",
          channel: "messaging",
          chosenSlot: startsAt.toISOString(),
          results: {
            create: {
              phase: "book",
              channel: "messaging",
              summary: `Booked ${reason}${provider ? ` with ${provider}` : ""}.`,
              structuredData: toJson({
                outcome: "booked",
                appointmentBooked: true,
                appointmentDateTime: startsAt.toISOString(),
                confirmation,
                offeredSlots: [],
                missingInfo: [],
                notes: "Booked by Klove concierge (simulated).",
              }),
            },
          },
        },
      },
    },
  });

  const appointment = await prisma.appointment.create({
    data: {
      userId: subjectUserId,
      sourceType: "klove_booking",
      title: reason,
      provider,
      providerPhone: input.phone ?? null,
      providerWebsite: input.website ?? null,
      startsAt,
      status: "scheduled",
      confirmation,
      notes: `Booked by Klove · job ${session.id}${input.preferredTimes ? ` · requested: ${input.preferredTimes}` : ""}`,
    },
  });

  const task = await prisma.task.create({
    data: {
      subjectUserId,
      householdId,
      title: `Booked: ${reason}`,
      detail: `Confirmed for ${whenLabel(startsAt)}${provider ? ` with ${provider}` : ""} · ${confirmation}`,
      state: "handled",
      kind: "book",
      conciergeJobId: session.id,
    },
  });
  await prisma.message.create({
    data: {
      householdId,
      subjectUserId,
      direction: "out",
      channel: "inapp",
      title: "Booked",
      body: `Done — ${reason} is booked for ${whenLabel(startsAt)}${provider ? ` with ${provider}` : ""}. Confirmation ${confirmation}.`,
      relatedTaskId: task.id,
    },
  });

  return {
    status: "confirmed",
    taskId: task.id,
    appointmentId: appointment.id,
    confirmation,
    title: reason,
    provider,
    startsAt: startsAt.toISOString(),
  };
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
    const session = await prisma.session.findUnique({
      where: { id: task.conciergeJobId! },
      include: { targets: { include: { results: { orderBy: { createdAt: "desc" } } } } },
    });
    if (!session || session.targets.length === 0) continue; // not a live booking job

    const booked = session.targets.find((t) => t.status === "booked");
    const choosing = session.targets.find((t) => t.status === "awaiting_choice");
    const terminal = session.status === "completed" || session.status === "failed";
    const reason = task.title.replace(/^Booking:\s*/, "");

    if (booked) {
      const sd = fromJson<CallStructuredData | null>(booked.results[0]?.structuredData ?? null, null);
      const when = sd?.appointmentDateTime ? new Date(sd.appointmentDateTime) : new Date(Date.now() + 3 * 86_400_000);
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
          notes: `Booked by Klove (live) · job ${session.id}`,
        },
      });
      await prisma.task.update({
        where: { id: task.id },
        data: { state: "handled", detail: `Confirmed for ${whenLabel(when)} with ${booked.officeName} · ${confirmation}` },
      });
      await prisma.message.create({
        data: {
          householdId: task.householdId,
          subjectUserId: task.subjectUserId,
          direction: "out",
          channel: "inapp",
          title: "Booked",
          body: `Done — booked for ${whenLabel(when)} with ${booked.officeName}. Confirmation ${confirmation}.`,
          relatedTaskId: task.id,
        },
      });
      await pushToOperator(task.householdId, "Booked ✅", `${reason} is booked for ${whenLabel(when)} with ${booked.officeName}.`);
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
      await pushToOperator(task.householdId, "Choose a time", `${choosing.officeName} offered ${slots.length} alternate times for ${reason} — tap to pick.`);
    } else if (terminal) {
      // Job finished without a booking (no answer, needs info, etc.) — surface it back to the operator.
      await prisma.task.update({
        where: { id: task.id },
        data: { state: "needs_you", detail: "Klove couldn't complete this booking automatically — tap to review." },
      });
      await pushToOperator(task.householdId, "Action needed", `Klove couldn't finish booking ${reason} — tap to review.`);
    }
  }
}
