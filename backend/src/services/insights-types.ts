// Shared shape for a drafted health insight before it's persisted as a HealthAlert. Produced by the
// deterministic layers (range checks, guidelines, med-safety, trends) and the LLM synthesis pass.

export interface DraftAlert {
  severity: "info" | "watch" | "urgent";
  category?: string; // trend | screening | vaccine | med_safety | med_therapy | monitoring
  title: string;
  detail: string;
  relatedResourceIds: string[];
  // Structured, actionable follow-up (everything is "discuss with your provider" framed).
  followUpType?: string; // book_visit | retest | refill | referral | vaccine
  recommendedSpecialty?: string; // e.g. "endocrinology", "primary care"
  daysToAction?: number; // suggested urgency window
  guideline?: string; // citation, e.g. "USPSTF Grade A", "ADA 2024"
}
