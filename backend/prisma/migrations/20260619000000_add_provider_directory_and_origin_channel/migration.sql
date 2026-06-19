-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "originChannel" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "originChannel" TEXT;

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "subjectUserId" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "website" TEXT,
    "address" TEXT,
    "specialty" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Provider_householdId_idx" ON "Provider"("householdId");

-- CreateIndex
CREATE INDEX "Provider_subjectUserId_idx" ON "Provider"("subjectUserId");

-- AddForeignKey
ALTER TABLE "Provider" ADD CONSTRAINT "Provider_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Provider" ADD CONSTRAINT "Provider_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

