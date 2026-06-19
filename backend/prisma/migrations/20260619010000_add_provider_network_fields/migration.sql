-- AlterTable
ALTER TABLE "Provider" ADD COLUMN     "npi" TEXT;
ALTER TABLE "Provider" ADD COLUMN     "acceptedCarriers" TEXT[] DEFAULT ARRAY[]::TEXT[];
