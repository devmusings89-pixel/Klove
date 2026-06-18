-- WhatsApp concierge agent: additive User fields + AgentConversation state table.

-- AlterTable: User WhatsApp channel fields (all nullable or defaulted — safe on existing rows).
ALTER TABLE "User" ADD COLUMN "whatsappPhone" TEXT;
ALTER TABLE "User" ADD COLUMN "whatsappVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "whatsappEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "lastWhatsappInboundAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "lastProactiveAt" TIMESTAMP(3);

-- Unique index on the WhatsApp number (one user per number).
CREATE UNIQUE INDEX "User_whatsappPhone_key" ON "User"("whatsappPhone");

-- CreateTable: AgentConversation (transient per-user agent state).
CREATE TABLE "AgentConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "pendingAction" TEXT,
    "pendingExpiresAt" TIMESTAMP(3),
    "lastTurnAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentConversation_userId_key" ON "AgentConversation"("userId");
