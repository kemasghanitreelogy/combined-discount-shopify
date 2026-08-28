import db from "../db.server";
import {
  CUSTOMER_STATE_KEY,
  CUSTOMER_STATE_NAMESPACE,
  earlierDay,
  findCampaignState,
  parseIdList,
  serializeCustomerState,
  toDay,
  upsertCampaignState,
} from "./combined-discount.server";

/** Shopify caps `metafieldsSet` at 25 metafields per call. */
const METAFIELD_BATCH = 25;
/** `customerSegmentMembers` allows up to 1000 per page. */
const SEGMENT_PAGE = 250;

const SEGMENT_QUERY = `#graphql
  query CombinedDiscountSegment(
    $query: String!
    $first: Int!
    $cursor: String
    $namespace: String!
    $key: String!
  ) {
    customerSegmentMembers(first: $first, after: $cursor, query: $query) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          state: metafield(namespace: $namespace, key: $key) {
            jsonValue
            compareDigest
          }
        }
      }
    }
  }`;

const WRITE_BATCH = `#graphql
  mutation CombinedDiscountBackfillWrite($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }`;

const numericId = (gid) => String(gid).split("/").pop();

/** The day before the cutoff — see `projectedQualifiedDay`. */
export function dayBefore(isoDay) {
  const date = new Date(`${isoDay}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Builds the ShopifyQL segment that defines "already purchased before the
 * cutoff".
 *
 * Segments are computed by Shopify over the customer's whole history, which is
 * the entire point: the Admin API only returns the last 60 days of orders
 * without `read_all_orders`, so walking orders misses almost everyone this gate
 * is meant to target.
 *
 * NOTE: `products_purchased` matches at PRODUCT level — Shopify exposes no
 * variant-level segment filter. Historical qualification is therefore
 * product-wide even when the merchant picked specific variants. Orders arriving
 * from now on are matched exactly by the webhook.
 */
export function buildSegmentQuery(cutoff, productIds) {
  const parts = [`first_order_date < ${cutoff}`];
  const ids = (productIds ?? []).map(numericId).filter(Boolean);
  if (ids.length) {
    parts.push(
      `(${ids.map((id) => `products_purchased(id: ${id}) = true`).join(" OR ")})`,
    );
  }
  return parts.join(" AND ");
}

/**
 * Projects "this customer qualifies for this campaign" into each member's
 * customer metafield, which is the only thing the Function can read.
 *
 * Segment membership is a boolean, not a date, so the projected `qualifiedAt`
 * is the day before the cutoff — the latest value that still satisfies the
 * Function's `qualifiedAt < purchasedBefore` test. Because of that the
 * projection is only valid for the cutoff it was built from; the cutoff used is
 * recorded on the campaign so the UI can tell the merchant to re-run. Changing
 * the cutoff in either direction fails closed until they do.
 */
export async function backfillPurchaseHistory({
  admin,
  shop,
  cursor = null,
  campaignKey = null,
  budgetMs = 20000,
}) {
  const startedAt = Date.now();

  const campaigns = await db.discountCampaign.findMany({
    where: {
      shop,
      archived: false,
      purchasedBefore: { not: null },
      ...(campaignKey ? { campaignKey } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  if (!campaigns.length) {
    return {
      customersScanned: 0,
      customersUpdated: 0,
      totalCount: 0,
      done: true,
      nextCursor: null,
      campaignKey: null,
      elapsedMs: 0,
      errors: [],
      note: "No saved discount has a purchase-history cutoff yet. Save the discount first, then rebuild.",
    };
  }

  // One campaign per pass; the caller resumes into the next one.
  const campaign = campaigns[0];
  const cutoff = campaign.purchasedBefore;
  const segmentQuery = buildSegmentQuery(cutoff, parseIdList(campaign.qualifyingProductIds));
  const qualifiedDay = dayBefore(cutoff);

  let customersScanned = 0;
  let customersUpdated = 0;
  let totalCount = 0;
  const errors = [];
  let hasMore = true;

  while (hasMore) {
    const response = await admin.graphql(SEGMENT_QUERY, {
      variables: {
        query: segmentQuery,
        first: SEGMENT_PAGE,
        cursor,
        namespace: CUSTOMER_STATE_NAMESPACE,
        key: CUSTOMER_STATE_KEY,
      },
    });
    const json = await response.json();
    if (json?.errors?.length) {
      throw new Error(
        `${json.errors.map((e) => e.message).join("; ")} (segment: ${segmentQuery})`,
      );
    }

    const connection = json?.data?.customerSegmentMembers;
    const edges = connection?.edges ?? [];
    totalCount = connection?.totalCount ?? 0;

    const pending = edges.map(({ node }) => {
      customersScanned += 1;
      const current = node?.state?.jsonValue ?? null;
      // Merge, never clobber: `uses` belongs to the redemption ledger and other
      // campaigns' entries must survive.
      const existing = findCampaignState(current, campaign.campaignKey);
      const next = upsertCampaignState(
        { ...(current ?? {}) },
        campaign.campaignKey,
        { qualifiedAt: qualifiedDay, uses: existing?.uses ?? 0 },
      );
      return {
        customerId: node.id,
        value: JSON.stringify(serializeCustomerState(next)),
        compareDigest: node?.state?.compareDigest ?? null,
      };
    });

    // Mirror into Postgres BEFORE the metafield write. `projectOrder` rebuilds
    // the metafield from these rows on the customer's next order; without them
    // it would recompute qualifiedAt from that order alone and overwrite the
    // projection, locking out a customer who actually qualifies.
    for (const item of pending) {
      try {
        const existing = await db.customerPurchaseFact.findUnique({
          where: { shop_customerId: { shop, customerId: item.customerId } },
        });
        let qualified = {};
        try {
          qualified = JSON.parse(existing?.qualifiedAt ?? "{}") || {};
        } catch {
          qualified = {};
        }
        qualified[campaign.campaignKey] = earlierDay(
          toDay(qualified[campaign.campaignKey]),
          qualifiedDay,
        );
        await db.customerPurchaseFact.upsert({
          where: { shop_customerId: { shop, customerId: item.customerId } },
          create: {
            shop,
            customerId: item.customerId,
            qualifiedAt: JSON.stringify(qualified),
          },
          update: { qualifiedAt: JSON.stringify(qualified) },
        });
      } catch (error) {
        errors.push(`${item.customerId}: ${error.message}`);
      }
    }

    for (let i = 0; i < pending.length; i += METAFIELD_BATCH) {
      const chunk = pending.slice(i, i + METAFIELD_BATCH);
      const write = await admin.graphql(WRITE_BATCH, {
        variables: {
          metafields: chunk.map((item) => ({
            ownerId: item.customerId,
            namespace: CUSTOMER_STATE_NAMESPACE,
            key: CUSTOMER_STATE_KEY,
            type: "json",
            value: item.value,
            ...(item.compareDigest ? { compareDigest: item.compareDigest } : {}),
          })),
        },
      });
      const writeJson = await write.json();
      const userErrors = writeJson?.data?.metafieldsSet?.userErrors ?? [];
      for (const e of userErrors) errors.push(`${e.code ?? "ERROR"}: ${e.message}`);
      if (!userErrors.length && !writeJson?.errors?.length) {
        customersUpdated += chunk.length;
      }
    }

    cursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    hasMore = Boolean(cursor) && Date.now() - startedAt <= budgetMs;
  }

  const done = !cursor;
  if (done) {
    await db.discountCampaign.update({
      where: { id: campaign.id },
      data: { backfilledCutoff: cutoff, backfilledAt: new Date() },
    });
  }

  return {
    customersScanned,
    customersUpdated,
    totalCount,
    nextCursor: cursor,
    campaignKey: campaign.campaignKey,
    campaignTitle: campaign.title,
    segmentQuery,
    qualifiedDay,
    done,
    elapsedMs: Date.now() - startedAt,
    errors: errors.slice(0, 20),
  };
}
