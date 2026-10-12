/**
 * Klaviyo request bodies, built from ledger facts.
 *
 * Pure on purpose: everything that decides *what* Klaviyo sees lives here and
 * is unit-tested; the transport and the worker only decide *when*.
 */

export const REDEEMED_METRIC = "Redeemed Combined Discount";

/** What a discount is called in property names: its code, else its title. */
export function campaignLabel(campaign) {
  return String(
    campaign?.code || campaign?.title || campaign?.campaignKey || "",
  ).trim();
}

function iso(value) {
  if (!value) return null;
  return new Date(value).toISOString().replace(".000Z", "Z");
}

/**
 * Per-discount profile properties. The names match the 2026-10-12 bulk import
 * so segments built on them keep working.
 *
 * `usage` is { uses, firstUsedAt, lastUsedAt }. Every key is always sent:
 * Klaviyo clears a property set to null, which is exactly right for a limit
 * that was removed or a customer whose only use was cancelled.
 */
export function campaignProperties(campaign, usage) {
  const label = campaignLabel(campaign);
  const uses = usage?.uses ?? 0;
  const limit = campaign?.maxOrdersPerCustomer ?? null;
  return {
    [`${label} Uses`]: uses,
    [`${label} Limit`]: limit,
    [`${label} Uses Left`]: limit == null ? null : Math.max(limit - uses, 0),
    [`${label} First Used`]: uses > 0 ? iso(usage.firstUsedAt) : null,
    [`${label} Last Used`]: uses > 0 ? iso(usage.lastUsedAt) : null,
  };
}

/** POST /api/profile-import body. Identified by email only — never touches consent. */
export function profileImportBody({ email, shopifyCustomerId, campaigns }) {
  const properties = { "Shopify Customer ID": String(shopifyCustomerId) };
  for (const { campaign, usage } of campaigns) {
    Object.assign(properties, campaignProperties(campaign, usage));
  }
  return { data: { type: "profile", attributes: { email, properties } } };
}

/** POST /api/lists/{id}/relationships/profiles body. */
export function listMembershipBody(profileIds) {
  return { data: profileIds.map((id) => ({ type: "profile", id })) };
}

/**
 * POST /api/events body for one redemption.
 *
 * `unique_id` is derived from the order and campaign, so Klaviyo drops any
 * replay of the same redemption (it dedupes on profile + metric + unique_id).
 */
export function redemptionEventBody({ email, campaign, order, usesAtOrder }) {
  const limit = campaign?.maxOrdersPerCustomer ?? null;
  const label = campaignLabel(campaign);
  return {
    data: {
      type: "event",
      attributes: {
        metric: {
          data: { type: "metric", attributes: { name: REDEEMED_METRIC } },
        },
        profile: { data: { type: "profile", attributes: { email } } },
        unique_id: `${order.orderId}:${campaign.campaignKey}`,
        time: iso(order.orderedAt),
        properties: {
          Code: label,
          "Discount Title": campaign?.title ?? label,
          "Order ID": String(order.orderId).split("/").pop(),
          Uses: usesAtOrder,
          Limit: limit,
          "Uses Left": limit == null ? null : Math.max(limit - usesAtOrder, 0),
          "Limit Reached": limit != null && usesAtOrder >= limit,
        },
      },
    },
  };
}
