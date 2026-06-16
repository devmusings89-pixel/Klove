import { z } from "zod";

// ---- Request validation (POST /sessions) ----

export const PatientInfoSchema = z.object({
  name: z.string().min(1),
  dob: z.string().min(1), // ISO date string
  reason: z.string().min(1),
  insurance: z.string().optional().default(""),
  preferredTimes: z.string().optional().default(""),
  // Free-text window the AI may auto-book within (e.g. "any weekday morning in the next 2 weeks").
  acceptableWindow: z.string().optional().default(""),
  // Free-form extra details the office may ask for (member ID, referral, pharmacy, etc.).
  additionalInfo: z.string().optional().default(""),
  // Patient's own phone — warm-transfer / re-call target when the agent is stumped. Also where
  // online schedulers send the booking verification code.
  patientPhone: z.string().optional().default(""),
  // Patient's email — required by many online booking forms; also a verification-code destination.
  patientEmail: z.string().optional().default(""),
  // "new" or "existing" patient at this office — branches the booking funnel.
  patientStatus: z.string().optional().default(""),
});
export type PatientInfo = z.infer<typeof PatientInfoSchema>;

export const CallTargetInputSchema = z.object({
  officeName: z.string().min(1),
  phoneNumber: z.string().optional(), // optional => looked up (voice channel)
  website: z.string().optional(), // online booking URL (web channel); looked up if absent
  email: z.string().optional(), // office email (email/messaging fallback channel)
  timezone: z.string().default("America/New_York"),
});

export const CreateSessionSchema = z.object({
  email: z.string().email(),
  deviceId: z.string().optional(),
  patientInfo: PatientInfoSchema,
  targets: z.array(CallTargetInputSchema).min(1).max(3),
  stopWhenBooked: z.boolean().optional().default(true),
});
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;

// ---- Choose a slot (POST /sessions/:id/choose) ----

export const ChooseSlotSchema = z.object({
  targetId: z.string().min(1),
  slot: z.string().min(1),
});
export type ChooseSlotInput = z.infer<typeof ChooseSlotSchema>;

// ---- Provide missing info (POST /sessions/:id/provide-info) ----

export const ProvideInfoSchema = z.object({
  targetId: z.string().min(1),
  answers: z.string().min(1), // free-form; the agent reads it on the re-call
});
export type ProvideInfoInput = z.infer<typeof ProvideInfoSchema>;

// ---- Submit a verification code (POST /sessions/:id/verify) ----

export const VerifyCodeSchema = z.object({
  targetId: z.string().min(1),
  code: z.string().min(3).max(12), // the one-time code the scheduler texted/emailed the patient
});
export type VerifyCodeInput = z.infer<typeof VerifyCodeSchema>;

// ---- Structured data returned by the Vapi assistant ----

export type CallOutcome =
  | "booked"
  | "options_collected"
  | "info_needed"
  | "transferred" // voice channel: the agent warm-transferred (patched) the office to the patient, who took over live
  | "verification_needed" // web channel: the scheduler needs a one-time code the patient must read from email/SMS
  | "request_sent" // email channel: a booking request was emailed to the office (office will follow up)
  | "no_availability"
  | "no_human"
  | "failed";

export interface CallStructuredData {
  outcome: CallOutcome;
  appointmentBooked: boolean;
  appointmentDateTime: string;
  confirmation: string;
  offeredSlots: string[];
  missingInfo: string[];
  notes: string;
}
