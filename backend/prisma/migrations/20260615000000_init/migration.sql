-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "authUserId" TEXT,
    "displayName" TEXT,
    "dob" TIMESTAMP(3),
    "managed" BOOLEAN NOT NULL DEFAULT false,
    "managedByUserId" TEXT,
    "deviceId" TEXT,
    "apnsToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSourceConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "externalAccountId" TEXT,
    "scopes" TEXT,
    "cursor" TEXT,
    "config" TEXT,
    "lastError" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataSourceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT,
    "sourceType" TEXT NOT NULL,
    "storagePath" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "originalName" TEXT,
    "sourceRef" TEXT,
    "sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionJob" (
    "id" TEXT NOT NULL,
    "documentId" TEXT,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resultSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Observation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT,
    "sourceType" TEXT NOT NULL,
    "code" TEXT,
    "display" TEXT NOT NULL,
    "valueNum" DOUBLE PRECISION,
    "valueString" TEXT,
    "unit" TEXT,
    "referenceRange" TEXT,
    "abnormalFlag" TEXT,
    "effectiveAt" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "rawJson" TEXT,
    "reportId" TEXT,

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Condition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT,
    "sourceType" TEXT NOT NULL,
    "code" TEXT,
    "display" TEXT NOT NULL,
    "clinicalStatus" TEXT,
    "onsetDate" TIMESTAMP(3),
    "severity" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "rawJson" TEXT,

    CONSTRAINT "Condition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationStatement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT,
    "sourceType" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "rxNormCode" TEXT,
    "dosage" TEXT,
    "status" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "rawJson" TEXT,

    CONSTRAINT "MedicationStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT,
    "sourceType" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "category" TEXT,
    "issuedAt" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "rawJson" TEXT,

    CONSTRAINT "DiagnosticReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllergyIntolerance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT,
    "sourceType" TEXT NOT NULL,
    "substance" TEXT NOT NULL,
    "reaction" TEXT,
    "severity" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "rawJson" TEXT,

    CONSTRAINT "AllergyIntolerance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "dob" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "relationship" TEXT NOT NULL DEFAULT 'self',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsurancePlan" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "carrier" TEXT,
    "planName" TEXT,
    "memberIdEnc" TEXT,
    "groupIdEnc" TEXT,
    "rxBin" TEXT,
    "rxPcn" TEXT,
    "holderName" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsurancePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT,
    "sourceType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "provider" TEXT,
    "providerPhone" TEXT,
    "providerWebsite" TEXT,
    "providerAddress" TEXT,
    "location" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "confirmation" TEXT,
    "notes" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "rawJson" TEXT,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthAlert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "rank" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "category" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "relatedResourceIds" TEXT,
    "generatedByJobId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "tier" TEXT NOT NULL DEFAULT 'ai',
    "kind" TEXT NOT NULL DEFAULT 'booking',
    "patientInfo" TEXT NOT NULL,
    "maxCalls" INTEGER NOT NULL DEFAULT 3,
    "minutesCap" INTEGER NOT NULL DEFAULT 60,
    "stopWhenBooked" BOOLEAN NOT NULL DEFAULT true,
    "stripePaymentIntentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallTarget" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "officeName" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "website" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "order" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "channel" TEXT,
    "channelHints" TEXT,
    "vapiCallId" TEXT,
    "calledAt" TIMESTAMP(3),
    "offeredSlots" TEXT,
    "chosenSlot" TEXT,
    "missingInfo" TEXT,
    "verificationId" TEXT,
    "verificationContact" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallResult" (
    "id" TEXT NOT NULL,
    "callTargetId" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'single',
    "channel" TEXT,
    "transcript" TEXT,
    "summary" TEXT,
    "structuredData" TEXT,
    "recordingUrl" TEXT,
    "endedReason" TEXT,
    "durationSec" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Household" (
    "id" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HouseholdMembership" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "memberType" TEXT NOT NULL,
    "isOperator" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HouseholdMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentGrant" (
    "id" TEXT NOT NULL,
    "granteeUserId" TEXT NOT NULL,
    "subjectUserId" TEXT NOT NULL,
    "householdId" TEXT,
    "accessLevel" TEXT NOT NULL DEFAULT 'view',
    "categories" TEXT NOT NULL DEFAULT '["all"]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "invitedEmail" TEXT,
    "inviteToken" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "subjectUserId" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "state" TEXT NOT NULL DEFAULT 'needs_you',
    "kind" TEXT NOT NULL DEFAULT 'review',
    "dueAt" TIMESTAMP(3),
    "sourceInsightId" TEXT,
    "conciergeJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "subjectUserId" TEXT NOT NULL,
    "taskId" TEXT,
    "title" TEXT NOT NULL,
    "fireAt" TIMESTAMP(3) NOT NULL,
    "repeatRule" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'push',
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Request" (
    "id" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "subjectUserId" TEXT,
    "householdId" TEXT,
    "text" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ask',
    "responseJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subjectUserId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "subjectUserId" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'out',
    "channel" TEXT NOT NULL DEFAULT 'inapp',
    "title" TEXT,
    "body" TEXT NOT NULL,
    "relatedTaskId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_authUserId_key" ON "User"("authUserId");

-- CreateIndex
CREATE INDEX "DataSourceConnection_userId_idx" ON "DataSourceConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DataSourceConnection_userId_type_externalAccountId_key" ON "DataSourceConnection"("userId", "type", "externalAccountId");

-- CreateIndex
CREATE INDEX "HealthDocument_userId_status_idx" ON "HealthDocument"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HealthDocument_userId_sha256_key" ON "HealthDocument"("userId", "sha256");

-- CreateIndex
CREATE INDEX "ExtractionJob_status_runAfter_idx" ON "ExtractionJob"("status", "runAfter");

-- CreateIndex
CREATE INDEX "Observation_userId_code_idx" ON "Observation"("userId", "code");

-- CreateIndex
CREATE INDEX "Condition_userId_idx" ON "Condition"("userId");

-- CreateIndex
CREATE INDEX "MedicationStatement_userId_idx" ON "MedicationStatement"("userId");

-- CreateIndex
CREATE INDEX "DiagnosticReport_userId_idx" ON "DiagnosticReport"("userId");

-- CreateIndex
CREATE INDEX "AllergyIntolerance_userId_idx" ON "AllergyIntolerance"("userId");

-- CreateIndex
CREATE INDEX "Profile_userId_idx" ON "Profile"("userId");

-- CreateIndex
CREATE INDEX "InsurancePlan_profileId_idx" ON "InsurancePlan"("profileId");

-- CreateIndex
CREATE INDEX "Appointment_userId_startsAt_idx" ON "Appointment"("userId", "startsAt");

-- CreateIndex
CREATE INDEX "HealthAlert_userId_acknowledgedAt_idx" ON "HealthAlert"("userId", "acknowledgedAt");

-- CreateIndex
CREATE INDEX "Session_status_idx" ON "Session"("status");

-- CreateIndex
CREATE INDEX "CallTarget_sessionId_idx" ON "CallTarget"("sessionId");

-- CreateIndex
CREATE INDEX "CallResult_callTargetId_idx" ON "CallResult"("callTargetId");

-- CreateIndex
CREATE UNIQUE INDEX "Household_operatorUserId_key" ON "Household"("operatorUserId");

-- CreateIndex
CREATE INDEX "HouseholdMembership_userId_idx" ON "HouseholdMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "HouseholdMembership_householdId_userId_key" ON "HouseholdMembership"("householdId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentGrant_inviteToken_key" ON "ConsentGrant"("inviteToken");

-- CreateIndex
CREATE INDEX "ConsentGrant_subjectUserId_idx" ON "ConsentGrant"("subjectUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentGrant_granteeUserId_subjectUserId_key" ON "ConsentGrant"("granteeUserId", "subjectUserId");

-- CreateIndex
CREATE INDEX "Task_householdId_state_idx" ON "Task"("householdId", "state");

-- CreateIndex
CREATE INDEX "Task_subjectUserId_idx" ON "Task"("subjectUserId");

-- CreateIndex
CREATE INDEX "Reminder_status_fireAt_idx" ON "Reminder"("status", "fireAt");

-- CreateIndex
CREATE INDEX "Reminder_subjectUserId_idx" ON "Reminder"("subjectUserId");

-- CreateIndex
CREATE INDEX "Request_operatorUserId_idx" ON "Request"("operatorUserId");

-- CreateIndex
CREATE INDEX "AuditEvent_subjectUserId_createdAt_idx" ON "AuditEvent"("subjectUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_householdId_createdAt_idx" ON "Message"("householdId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_subjectUserId_readAt_idx" ON "Message"("subjectUserId", "readAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_managedByUserId_fkey" FOREIGN KEY ("managedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSourceConnection" ADD CONSTRAINT "DataSourceConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthDocument" ADD CONSTRAINT "HealthDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthDocument" ADD CONSTRAINT "HealthDocument_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "DataSourceConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionJob" ADD CONSTRAINT "ExtractionJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "HealthDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "DiagnosticReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Condition" ADD CONSTRAINT "Condition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationStatement" ADD CONSTRAINT "MedicationStatement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticReport" ADD CONSTRAINT "DiagnosticReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllergyIntolerance" ADD CONSTRAINT "AllergyIntolerance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsurancePlan" ADD CONSTRAINT "InsurancePlan_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthAlert" ADD CONSTRAINT "HealthAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallTarget" ADD CONSTRAINT "CallTarget_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallResult" ADD CONSTRAINT "CallResult_callTargetId_fkey" FOREIGN KEY ("callTargetId") REFERENCES "CallTarget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Household" ADD CONSTRAINT "Household_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdMembership" ADD CONSTRAINT "HouseholdMembership_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdMembership" ADD CONSTRAINT "HouseholdMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentGrant" ADD CONSTRAINT "ConsentGrant_granteeUserId_fkey" FOREIGN KEY ("granteeUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentGrant" ADD CONSTRAINT "ConsentGrant_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

