-- AlterTable
ALTER TABLE "DiscountCampaign" ADD COLUMN     "backfilledAt" TIMESTAMP(3),
ADD COLUMN     "backfilledCutoff" TEXT;
