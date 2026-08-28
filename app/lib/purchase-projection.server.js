import db from "../db.server";
import {
  earlierDay,
  findCampaignState,
  parseIdList,
  toDay,
  upsertCampaignState,
} from "./combined-discount.server";
import { updateCustomerState } from "./customer-state.server";

const gid = (type, id) =>
  String(id).startsWith("gid://") ? String(id) : `gid://shopify/${type}/${id}`;

/**
 * Flattens an `orders/create` REST webhook payload into the few facts the
 * projection needs. Everything comes from the payload itself, so a burst of
 * orders costs no extra Admin API reads.
 */
export function normalizeOrderPayload(payload) {
  const customerId = payload?.customer?.id ? gid("Customer", payload.customer.id) : null;
  const orderedAt = payload?.processed_at || payload?.created_at || null;

  const productIds = new Set();
  const variantIds = new Set();
  for (const line of payload?.line_items ?? []) {
    if (line?.product_id) productIds.add(gid("Product", line.product_id));
    if (line?.variant_id) variantIds.add(gid("ProductVariant", line.variant_id));
  }

  const codes = new Set();
  const titles = new Set();
  for (const application of payload?.discount_applications ?? []) {
    if (application?.code) codes.add(String(application.code).toLowerCase());
    if (application?.title) titles.add(String(application.title).toLowerCase());
  }
  // Order-level discount_codes is populated for code discounts even when
  // discount_applications is trimmed down.
  for (const entry of payload?.discount_codes ?? []) {
    if (entry?.code) codes.add(String(entry.code).toLowerCase());
  }

  return {
    orderId: payload?.admin_graphql_api_id || (payload?.id ? gid("Order", payload.id) : null),
    customerId,
    orderedAt,
    orderedDay: toDay(orderedAt),
    productIds,
    variantIds,
    codes,
    titles,
  };
}

/** True when the order contains at least one of the campaign's qualifying items. */
export function orderQualifies(campaign, order) {
  const products = parseIdList(campaign.qualifyingProductIds);
  const variants = parseIdList(campaign.qualifyingVariantIds);
  if (!products.length && !variants.length) {
    // No qualifying list configured: any purchase qualifies.
    return true;
  }
  return (
    variants.some((id) => order.variantIds.has(id)) ||
    products.some((id) => order.productIds.has(id))
  );
}

/** True when this order actually redeemed the campaign's discount. */
export function orderRedeems(campaign, order) {
  if (campaign.code && order.codes.has(campaign.code.toLowerCase())) return true;
  // Automatic app discounts surface on the order under their title.
  return Boolean(campaign.title) && order.titles.has(campaign.title.toLowerCase());
}

/**
 * Records one order and republishes the affected customer's state metafield.
 *
 * The Prisma tables are the source of truth — the redemption ledger is unique
 * on (shop, campaign, order), which makes webhook replays idempotent — and the
 * metafield is the read model the Function consumes.
 */
export async function projectOrder({ admin, shop, payload }) {
  const order = normalizeOrderPayload(payload);
  if (!order.customerId || !order.orderId || !order.orderedDay) {
    return { skipped: "order is not attributable to a customer" };
  }

  const campaigns = await db.discountCampaign.findMany({
    where: { shop, archived: false },
  });

  // --- facts -------------------------------------------------------------
  const existingFact = await db.customerPurchaseFact.findUnique({
    where: { shop_customerId: { shop, customerId: order.customerId } },
  });

  const firstPurchaseDay = earlierDay(
    toDay(existingFact?.firstPurchaseAt ?? null),
    order.orderedDay,
  );

  let qualifiedAt = {};
  try {
    qualifiedAt = JSON.parse(existingFact?.qualifiedAt ?? "{}") || {};
  } catch {
    qualifiedAt = {};
  }
  for (const campaign of campaigns) {
    if (orderQualifies(campaign, order)) {
      qualifiedAt[campaign.campaignKey] = earlierDay(
        toDay(qualifiedAt[campaign.campaignKey]),
        order.orderedDay,
      );
    }
  }

  await db.customerPurchaseFact.upsert({
    where: { shop_customerId: { shop, customerId: order.customerId } },
    create: {
      shop,
      customerId: order.customerId,
      firstPurchaseAt: new Date(`${firstPurchaseDay}T00:00:00.000Z`),
      qualifiedAt: JSON.stringify(qualifiedAt),
    },
    update: {
      firstPurchaseAt: new Date(`${firstPurchaseDay}T00:00:00.000Z`),
      qualifiedAt: JSON.stringify(qualifiedAt),
    },
  });

  // --- redemption ledger -------------------------------------------------
  const redeemed = campaigns.filter((campaign) => orderRedeems(campaign, order));
  for (const campaign of redeemed) {
    await db.discountRedemption.upsert({
      where: {
        shop_campaignKey_orderId: {
          shop,
          campaignKey: campaign.campaignKey,
          orderId: order.orderId,
        },
      },
      create: {
        shop,
        campaignKey: campaign.campaignKey,
        customerId: order.customerId,
        orderId: order.orderId,
        orderedAt: new Date(order.orderedAt),
      },
      update: {},
    });
  }

  // --- read model --------------------------------------------------------
  const touched = new Set([
    ...redeemed.map((c) => c.campaignKey),
    ...Object.keys(qualifiedAt),
  ]);

  const uses = {};
  for (const campaignKey of touched) {
    uses[campaignKey] = await db.discountRedemption.count({
      where: { shop, campaignKey, customerId: order.customerId },
    });
  }

  await updateCustomerState(admin, order.customerId, (current) => {
    let next = { ...(current ?? {}), firstPurchaseAt: firstPurchaseDay };
    for (const campaignKey of touched) {
      const existing = findCampaignState(next, campaignKey);
      next = upsertCampaignState(next, campaignKey, {
        qualifiedAt: qualifiedAt[campaignKey] ?? existing?.qualifiedAt ?? null,
        uses: uses[campaignKey] ?? existing?.uses ?? 0,
      });
    }
    return next;
  });

  return {
    customerId: order.customerId,
    firstPurchaseAt: firstPurchaseDay,
    redeemed: redeemed.map((c) => c.campaignKey),
    uses,
  };
}
