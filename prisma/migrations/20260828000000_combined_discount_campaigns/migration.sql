-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "DiscountCampaign" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "campaignKey" TEXT NOT NULL,
    "discountId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "code" TEXT,
    "qualifyingProductIds" TEXT NOT NULL DEFAULT '[]',
    "qualifyingVariantIds" TEXT NOT NULL DEFAULT '[]',
    "maxOrdersPerCustomer" INTEGER,
    "purchasedBefore" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountRedemption" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "campaignKey" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscountRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPurchaseFact" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "firstPurchaseAt" TIMESTAMP(3),
    "qualifiedAt" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerPurchaseFact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscountCampaign_shop_archived_idx" ON "DiscountCampaign"("shop", "archived");

-- CreateIndex
CREATE INDEX "DiscountCampaign_shop_title_idx" ON "DiscountCampaign"("shop", "title");

-- CreateIndex
CREATE INDEX "DiscountCampaign_shop_code_idx" ON "DiscountCampaign"("shop", "code");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountCampaign_shop_campaignKey_key" ON "DiscountCampaign"("shop", "campaignKey");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountCampaign_shop_discountId_key" ON "DiscountCampaign"("shop", "discountId");

-- CreateIndex
CREATE INDEX "DiscountRedemption_shop_campaignKey_customerId_idx" ON "DiscountRedemption"("shop", "campaignKey", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountRedemption_shop_campaignKey_orderId_key" ON "DiscountRedemption"("shop", "campaignKey", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPurchaseFact_shop_customerId_key" ON "CustomerPurchaseFact"("shop", "customerId");

