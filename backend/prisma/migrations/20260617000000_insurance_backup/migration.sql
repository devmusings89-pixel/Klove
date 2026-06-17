-- Add the "backup" (secondary) payer designation to insurance cards.
ALTER TABLE "InsurancePlan" ADD COLUMN "isSecondary" BOOLEAN NOT NULL DEFAULT false;
