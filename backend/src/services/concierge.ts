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
import { notifyOnChannel } from "./notify.js";
import { decryptToken } from "./crypto.js";
import { resolveProvider, upsertProvider, classifySpecialty, listProviders } from "./providers.js";
import type { CallStructuredData } from "../types.js";

/** The channel a booking was initiated from — confirmations/updates route back to it. */
export type OriginChannel = "app" | "whatsapp";

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
  const savedMemberId = plan?.memberIdEnc ? decryptToken(plan.memberIdEnc) : "";
  // Prefer details the agent gathered in chat for THIS booking over what's on file.
  const memberId = input.memberId?.trim() || savedMemberId;
  return {
    name: (input.patientName?.trim() || member?.displayName || memberProfile?.fullName || "the patient").trim(),
    dob: input.dob?.trim() || memberProfile?.dob || (member?.dob ? member.dob.toISOString().slice(0, 10) : ""),
    reason,
    insurance: input.insurance?.trim() || [plan?.carrier, plan?.planName].filter(Boolean).join(" "),
    additionalInfo: memberId ? `Insurance member ID: ${memberId}` : "",
    preferredTimes: input.preferredTimes ?? input.preferredDate ?? "",
    acceptableWindow: input.preferredTimes ?? "",
    patientPhone: memberProfile?.phone || opProfile?.phone || "",
  };
}

/** Notify the operator who runs this household, routed to the channel the booking came from.
 * `link` deep-links the push to the right tab on tap ("actions" for needs-you, "today" for booked). */
async function pushToOperator(
  householdId: string,
  title: string,
  body: string,
  link?: string,
  originChannel?: string | null,
): Promise<void> {
  const hh = await prisma.household.findUnique({ where: { id: householdId }, select: { operatorUserId: true } });
  if (hh) await notifyOnChannel(hh.operatorUserId, originChannel ?? null, { title, body, link }).catch((e) => console.error("operator notify failed", e));
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
  // Details the agent gathered in chat for THIS booking (override what's on file). Let the concierge
  // call go in fully prepared so the office doesn't turn us away for missing info.
  patientName?: string;
  dob?: string; // ISO yyyy-mm-dd
  insurance?: string; // carrier (+ plan) as free text, e.g. "Aetna PPO"
  memberId?: string; // insurance member/subscriber ID
  specialty?: string; // normalized specialty (e.g. "dentist"), to scope provider resolution + capture
  // Channel this booking was initiated from. Confirmations and needs-you prompts route back to it.
  originChannel?: OriginChannel;
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
  // A provider name is enough to look the office up — first in the household's known-provider
  // directory, then (if unknown) via Google Places. liveBooking falls back to couldNotBook if nothing
  // reachable turns up, so a bare reason with no provider still surfaces a needs-you task.
  const canResolve = hasContact || Boolean(input.provider?.trim());
  if (config.liveBooking && canResolve) {
    return liveBooking(operatorUserId, subjectUserId, householdId, input);
  }
  return couldNotBook(subjectUserId, householdId, input);
}

/** Create a real booking job and start the orchestrator. Returns immediately (async result). */
async function liveBooking(operatorUserId: string, subjectUserId: string, householdId: string, input: BookingInput): Promise<BookingOutcome> {
  const reason = input.reason.trim() || "Appointment";
  const provider = input.provider?.trim() || null;

  // Resolve how to reach the office: explicit contact wins; otherwise resolve by name from the
  // household's known-provider directory first, then Google Places. Keyed on the provider NAME — we
  // never silently contact an office the operator hasn't chosen.
  let phone = input.phone?.trim() || null;
  let website = input.website?.trim() || null;
  const email = input.email?.trim() || null;
  let resolvedAddress: string | null = null;
  if (!phone && !website && !email && provider) {
    const known = await resolveProvider({ householdId, subjectUserId, providerHint: provider, specialty: input.specialty, reason });
    if (known.provider) {
      phone = known.provider.phone ?? null;
      website = known.provider.website ?? null;
      resolvedAddress = known.provider.address ?? null;
    } else if (known.fromPlaces) {
      phone = known.fromPlaces.phone ?? null;
      website = known.fromPlaces.website ?? null;
      resolvedAddress = known.fromPlaces.address ?? null;
    } else if (enabled.googlePlaces()) {
      phone = await lookupPhoneNumber(provider);
      if (!phone) website = await lookupWebsite(provider);
    }
  }
  // If there's still no way to reach anyone, don't fabricate a booking — surface a task to finish it.
  if (!phone && !website && !email) {
    return couldNotBook(subjectUserId, householdId, input);
  }
  void resolvedAddress; // captured into the directory on a successful booking (see reconcile)

  // Full patient details (name, DOB, insurance) so the AI can introduce the patient on the call.
  const patient = await buildPatientInfo(subjectUserId, operatorUserId, input, reason);

  // Reuse this office's preferred booking method if we've learned one from a past successful booking,
  // so the router tries it first (web/voice/messaging) before falling back.
  const preferredChannel = provider
    ? (await prisma.provider.findFirst({
        where: { householdId, name: { equals: provider, mode: "insensitive" } },
        select: { preferredBookingMethod: true },
      }))?.preferredBookingMethod ?? null
    : null;

  const session = await prisma.session.create({
    data: {
      userId: subjectUserId,
      tier: "ai", // Klove books autonomously — there is no human-concierge tier
      kind: "booking",
      status: "paid", // skip payment; concierge job is authorized by the operator
      originChannel: input.originChannel ?? null,
      patientInfo: toJson(patient),
      targets: {
        create: {
          officeName: provider ?? reason,
          phoneNumber: phone,
          website,
          channelHints: email ? toJson({ email }) : null,
          preferredChannel,
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
      originChannel: input.originChannel ?? null,
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
      originChannel: input.originChannel ?? null,
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

export interface ResolvedProviderLite {
  id?: string;
  name: string;
  phone?: string | null;
  website?: string | null;
  address?: string | null;
  specialty?: string | null;
  source: string; // directory | places | explicit | manual | booking | appointment
}

export interface BookingPlan {
  // ready = a reachable provider is resolved and the operator can confirm; needs_provider = none
  // resolved, the operator must pick from `candidates` or add a new one before confirming.
  status: "ready" | "needs_provider";
  reason: string;
  provider: ResolvedProviderLite | null;
  // Known-provider directory entries for this member (+ shared) to show in the picker.
  candidates: ResolvedProviderLite[];
  // Soft-missing details surfaced in the recap (non-blocking): insurance, DOB, preferred time.
  missing: string[];
  patientName: string;
  insuranceLabel: string;
  preferredTimes: string;
  // Human-readable line the operator confirms before any calls are placed.
  recap: string;
}

/**
 * Prepare a booking for confirmation — NO calls are placed. Resolves the provider from the household's
 * known-provider directory (then Google Places), pulls the patient's details, and returns a recap the
 * operator confirms. The in-app flow renders this, then calls bookAppointment on confirm. When nothing
 * reachable resolves, returns status "needs_provider" with directory candidates to pick from or add.
 */
/**
 * Stop + close out a member's in-flight booking(s) — the agent's "cancel/abandon/close it out" action.
 * Fails the underlying session so the scheduler stops re-dialing, cancels any non-booked targets, and
 * marks the tracking task handled so the chat AND the Actions tab reflect the same (closed) state.
 * Returns how many were closed + the latest title, so the agent can confirm honestly (never claim a
 * cancel that didn't happen). Bookings already confirmed (booked) are left alone.
 */
export async function cancelActiveBooking(
  subjectUserId: string,
  householdId: string,
): Promise<{ cancelled: number; title: string | null }> {
  const tasks = await prisma.task.findMany({
    where: { subjectUserId, householdId, kind: { in: ["book", "choose_time"] }, state: { in: ["waiting", "needs_you"] } },
    orderBy: { createdAt: "desc" },
  });
  for (const t of tasks) {
    if (t.conciergeJobId) {
      await prisma.session.update({ where: { id: t.conciergeJobId }, data: { status: "failed" } }).catch(() => {});
      await prisma.callTarget.updateMany({
        where: { sessionId: t.conciergeJobId, status: { notIn: ["booked", "transferred"] } },
        data: { status: "failed", nextAttemptAt: null },
      });
    }
    await prisma.task.update({
      where: { id: t.id },
      data: { state: "handled", kind: "book", detail: "Cancelled — you asked Klove to stop.", title: t.title.replace(/^(Booking|Pick a time): /, "Cancelled: ") },
    });
  }
  return { cancelled: tasks.length, title: tasks[0]?.title ?? null };
}

export async function prepareBooking(
  operatorUserId: string,
  subjectUserId: string,
  householdId: string,
  input: BookingInput,
): Promise<BookingPlan> {
  const reason = input.reason.trim() || "Appointment";
  const namedProvider = input.provider?.trim() || null;
  const patient = await buildPatientInfo(subjectUserId, operatorUserId, input, reason);

  let provider: ResolvedProviderLite | null = null;
  const explicitPhone = input.phone?.trim() || null;
  const explicitWebsite = input.website?.trim() || null;
  if (explicitPhone || explicitWebsite) {
    provider = { name: namedProvider || "the office", phone: explicitPhone, website: explicitWebsite, source: "explicit" };
  } else {
    const r = await resolveProvider({ householdId, subjectUserId, providerHint: namedProvider ?? undefined, specialty: input.specialty, reason });
    if (r.provider) {
      provider = { id: r.provider.id, name: r.provider.name, phone: r.provider.phone, website: r.provider.website, address: r.provider.address, specialty: r.provider.specialty, source: "directory" };
    } else if (r.fromPlaces) {
      provider = { name: r.fromPlaces.displayName, phone: r.fromPlaces.phone, website: r.fromPlaces.website, address: r.fromPlaces.address, source: "places" };
    }
  }

  const reachable = Boolean(provider && (provider.phone || provider.website));
  const candidates = (await listProviders(householdId, { subjectUserId })).map((p) => ({
    id: p.id, name: p.name, phone: p.phone, website: p.website, address: p.address, specialty: p.specialty, source: p.source,
  }));

  const missing: string[] = [];
  if (!patient.insurance) missing.push("insurance");
  if (!patient.dob) missing.push("date of birth");
  if (!patient.preferredTimes) missing.push("a preferred time");

  const providerLabel = provider && provider.name !== "the office" ? ` with ${provider.name}` : "";
  const recap = reachable
    ? `Book ${reason} for ${patient.name}${providerLabel}${patient.preferredTimes ? `, ${patient.preferredTimes}` : ""}${patient.insurance ? ` · ${patient.insurance}` : ""}.`
    : `Pick a provider to book ${reason} for ${patient.name}.`;

  return {
    status: reachable ? "ready" : "needs_provider",
    reason,
    provider: reachable ? provider : null,
    candidates,
    missing,
    patientName: patient.name,
    insuranceLabel: patient.insurance,
    preferredTimes: patient.preferredTimes,
    recap,
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
   try {
    const session = await prisma.session.findUnique({
      where: { id: task.conciergeJobId! },
      include: { targets: { include: { results: { orderBy: { createdAt: "desc" } } } } },
    });
    // A waiting booking task whose session has nothing to call will never progress on its own (the old
    // route-to-concierge dead-end created exactly this: a draft session with no targets). Don't leave
    // it stuck on "waiting" forever — surface it back to the operator with a clear next step. This also
    // self-heals any such tasks already in the DB.
    if (!session || session.targets.length === 0) {
      const why = task.title.replace(/^(Booking|Book):\s*/, "");
      await prisma.task.update({
        where: { id: task.id },
        data: {
          state: "needs_you",
          kind: "book",
          conciergeJobId: null,
          detail: "Klove couldn't reach an office to book this automatically. Add a phone or website, or pick a provider, to continue.",
        },
      });
      await pushToOperator(task.householdId, "Action needed", `Klove couldn't start booking ${why} — tap to finish it.`, "actions", task.originChannel);
      continue;
    }

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
      // Capture the office into the household's known-provider directory so the next booking can reuse
      // it directly (this is how the directory "stores all past providers").
      await upsertProvider({
        householdId: task.householdId,
        subjectUserId: task.subjectUserId,
        name: booked.officeName,
        phone: booked.phoneNumber,
        website: booked.website,
        specialty: classifySpecialty(reason),
        source: "booking",
        // Remember the channel that actually booked, so next time we try it first.
        preferredBookingMethod: booked.channel ?? undefined,
        usedAt: new Date(),
      }).catch((e) => console.error("provider capture failed", e));
      await pushToOperator(task.householdId, "Booked ✅", `${reason} is booked for ${whenText} with ${booked.officeName}.`, "today", task.originChannel);
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
      await pushToOperator(task.householdId, "Choose a time", `${choosing.officeName} offered ${slots.length} alternate times for ${reason} — tap to pick.`, "actions", task.originChannel);
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
      await pushToOperator(task.householdId, "Verification needed", `Enter the code ${awaitingVerification.officeName} sent to finish booking ${reason}.`, "actions", task.originChannel);
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
      await pushToOperator(task.householdId, "Info needed", `${awaitingInfo.officeName} needs more details to book ${reason} — tap to provide them.`, "actions", task.originChannel);
    } else if (terminal) {
      // Job finished without a booking (no answer, needs info, etc.) — surface it back to the operator.
      await prisma.task.update({
        where: { id: task.id },
        data: { state: "needs_you", detail: "Klove couldn't complete this booking automatically — tap to review." },
      });
      await pushToOperator(task.householdId, "Action needed", `Klove couldn't finish booking ${reason} — tap to review.`, "actions", task.originChannel);
    }
   } catch (err) {
      // Isolate per-job failures so one malformed/orphaned booking can't block all the others.
      console.error("reconcile failed for task", task.id, err);
   }
  }
}
