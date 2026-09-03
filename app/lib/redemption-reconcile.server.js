import db from "../db.server";
import { adminGraphql } from "./admin-graphql.server";
import { syncCampaigns } from "./campaign-sync.server";
import {
  findCampaignState,
  toDay,
  upsertCampaignState,
} from "./combined-discount.server";
import { updateCustomerState } from "./customer-state.server";

const ORDERS_QUERY = `#graphql
  query CombinedDiscountRedeemedOrders($query: String!, $cursor: String) {
    orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        createdAt
        cancelledAt
        customer {
          id
        }
      }
    }
  }`;

/**
 * Rebuilds the redemption ledger from Shopify's own order history.
 *
 * The ledger is fed by the `orders/create` webhook, and a webhook that never
 * lands is invisible: Shopify stops redelivering after about four hours, and
 * from then on the order simply is not counted. Nothing errors — the cap just
 * quietly enforces a higher number than the merchant configured.
 *
 * Shopify's order list is the authority, so this recomputes the ledger from it
 * and republishes every affected customer's metafield. Safe to run repeatedly.
 *
 * Cancelled orders are removed rather than kept, which also gives back the
 * allowance the plain webhook path never returns.
 */
export async function reconcileRedemptions({ admin, shop, campaignKey = null }) {
  const startedAt = Date.now();

  const campaigns = await syncCampaigns(
    admin,
    shop,
    await db.discountCampaign.findMany({
      where: { shop, archived: false, ...(campaignKey ? { campaignKey } : {}) },
    }),
  );

  const report = [];

  for (const campaign of campaigns) {
    if (!campaign.code) {
      // Automatic discounts carry no code, so Shopify's order search cannot
      // isolate them; the webhook remains their only source.
      report.push({ campaignKey: campaign.campaignKey, skipped: "no code to search by" });
      continue;
    }

    // --- what Shopify says --------------------------------------------------
    const live = new Map();
    let cursor = null;
    do {
      const json = await adminGraphql(admin, ORDERS_QUERY, {
        query: `discount_code:${campaign.code}`,
        cursor,
      });
      if (json?.errors?.length) {
        throw new Error(json.errors.map((e) => e.message).join("; "));
      }
      const conn = json?.data?.orders;
      for (const o of conn?.nodes ?? []) {
        if (!o?.customer?.id) continue;
        live.set(o.id, {
          customerId: o.customer.id,
          orderedAt: o.createdAt,
          cancelled: Boolean(o.cancelledAt),
        });
      }
      cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);

    // --- what the ledger says -----------------------------------------------
    const rows = await db.discountRedemption.findMany({
      where: { shop, campaignKey: campaign.campaignKey },
    });
    const known = new Map(rows.map((r) => [r.orderId, r]));

    const missing = [...live.entries()].filter(([id, o]) => !known.has(id) && !o.cancelled);
    const stale = [...live.entries()].filter(([id, o]) => known.has(id) && o.cancelled);
    const orphaned = rows.filter((r) => !live.has(r.orderId));

    const touched = new Set();

    for (const [orderId, o] of missing) {
      await db.discountRedemption.create({
        data: {
          shop,
          campaignKey: campaign.campaignKey,
          customerId: o.customerId,
          orderId,
          orderedAt: new Date(o.orderedAt),
        },
      });
      touched.add(o.customerId);
    }

    for (const [orderId] of stale) {
      const row = known.get(orderId);
      await db.discountRedemption.delete({ where: { id: row.id } });
      touched.add(row.customerId);
    }

    for (const row of orphaned) {
      await db.discountRedemption.delete({ where: { id: row.id } });
      touched.add(row.customerId);
    }

    // --- republish the read model the function actually consumes -------------
    let republished = 0;
    for (const customerId of touched) {
      const uses = await db.discountRedemption.count({
        where: { shop, campaignKey: campaign.campaignKey, customerId },
      });
      const earliest = await db.discountRedemption.findFirst({
        where: { shop, campaignKey: campaign.campaignKey, customerId },
        orderBy: { orderedAt: "asc" },
      });
      try {
        await updateCustomerState(admin, customerId, (current) => {
          const existing = findCampaignState(current, campaign.campaignKey);
          return upsertCampaignState({ ...(current ?? {}) }, campaign.campaignKey, {
            // Never invent a qualifying date: keep whatever the backfill or the
            // webhook established, falling back to this customer's first
            // redemption only if nothing is on record.
            qualifiedAt:
              existing?.qualifiedAt ?? toDay(earliest?.orderedAt ?? null) ?? null,
            uses,
          });
        });
        republished += 1;
      } catch (error) {
        report.push({
          campaignKey: campaign.campaignKey,
          customerId,
          error: error.message,
        });
      }
    }

    report.push({
      campaignKey: campaign.campaignKey,
      code: campaign.code,
      ordersInShopify: live.size,
      added: missing.length,
      removedCancelled: stale.length,
      removedOrphaned: orphaned.length,
      customersRepublished: republished,
    });
  }

  return { shop, elapsedMs: Date.now() - startedAt, campaigns: report };
}
