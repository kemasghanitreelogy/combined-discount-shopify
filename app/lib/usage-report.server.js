import db from "../db.server";
import { adminGraphql } from "./admin-graphql.server";
import { RECENT_DAYS, SEARCH_LIMIT } from "./usage-constants";

/**
 * Per-customer usage read off the redemption ledger.
 *
 * The ledger is what the Function's per-customer cap is projected from, so
 * these are the numbers the discount actually enforces — not Shopify's own
 * order counts, which also include orders the ledger has reconciled away.
 */

// `nodes(ids:)` accepts at most 250 IDs per call.
const NODES_BATCH = 250;

export const STATUSES = [
  "all",
  "at_limit",
  "near_limit",
  "repeat",
  "unlimited",
];
export const SORTS = ["uses", "recent"];

const LOOKUP_QUERY = `#graphql
  query UsageLookup($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Customer {
        id
        displayName
        defaultEmailAddress { emailAddress }
        numberOfOrders
      }
      ... on Order {
        id
        name
        cancelledAt
        totalPriceSet { shopMoney { amount currencyCode } }
        totalDiscountsSet { shopMoney { amount currencyCode } }
      }
    }
  }`;

const SEARCH_QUERY = `#graphql
  query UsageCustomerSearch($query: String!) {
    customers(first: 250, query: $query) {
      nodes { id }
    }
  }`;

/** Resolves customer and order GIDs in batches; unreadable IDs are simply absent. */
export async function lookupNodes(admin, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += NODES_BATCH) {
    const json = await adminGraphql(admin, LOOKUP_QUERY, {
      ids: ids.slice(i, i + NODES_BATCH),
    });
    // Orders outside the read_orders window come back null; the ledger still
    // has them, so callers fall back to the raw ID.
    for (const n of json?.data?.nodes ?? []) {
      if (n?.id) out[n.id] = n;
    }
  }
  return out;
}

async function searchCustomerIds(admin, q) {
  const json = await adminGraphql(admin, SEARCH_QUERY, { query: q });
  if (json?.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return (json?.data?.customers?.nodes ?? []).map((n) => n.id);
}

export function describeCustomer(node) {
  return {
    name: node?.displayName || null,
    email: node?.defaultEmailAddress?.emailAddress || null,
    numberOfOrders:
      node?.numberOfOrders != null ? Number(node.numberOfOrders) : null,
  };
}

/** Where one customer stands against one campaign's cap. */
function usageStatus(uses, limit) {
  if (limit == null) return "unlimited";
  if (uses >= limit) return "at_limit";
  if (uses === limit - 1) return "near_limit";
  return "ok";
}

/** The worst standing across a customer's campaigns decides their row. */
const STATUS_RANK = { at_limit: 3, near_limit: 2, ok: 1, unlimited: 0 };

function campaignInfo(campaign, key) {
  return {
    campaignKey: key,
    title: campaign?.title ?? key,
    code: campaign?.code ?? null,
    discountId: campaign?.discountId ?? null,
    limit: campaign?.maxOrdersPerCustomer ?? null,
    archived: Boolean(campaign?.archived),
  };
}

export async function loadCampaigns(shop) {
  const campaigns = await db.discountCampaign.findMany({
    where: { shop },
    orderBy: [{ archived: "asc" }, { title: "asc" }],
  });
  return {
    campaigns,
    byKey: Object.fromEntries(campaigns.map((c) => [c.campaignKey, c])),
  };
}

/**
 * Everything the overview needs, before pagination.
 *
 * Stats and the per-discount summary respect the discount filter but not the
 * status tab or search, so the tab counts stay stable while you click through.
 */
export async function buildUsageReport({
  admin,
  shop,
  campaign = "",
  status = "all",
  sort = "uses",
  q = "",
}) {
  const { campaigns, byKey } = await loadCampaigns(shop);
  const where = { shop, ...(campaign ? { campaignKey: campaign } : {}) };
  const recentSince = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);

  const [grouped, recentRedemptions] = await Promise.all([
    db.discountRedemption.groupBy({
      by: ["customerId", "campaignKey"],
      where,
      _count: { _all: true },
      _max: { orderedAt: true },
      _min: { orderedAt: true },
    }),
    db.discountRedemption.count({
      where: { ...where, orderedAt: { gte: recentSince } },
    }),
  ]);

  const byCustomer = new Map();
  const perCampaign = new Map();

  for (const g of grouped) {
    const info = campaignInfo(byKey[g.campaignKey], g.campaignKey);
    const uses = g._count._all;
    const standing = usageStatus(uses, info.limit);

    const row = byCustomer.get(g.customerId) ?? {
      customerId: g.customerId,
      totalUses: 0,
      firstUsedAt: null,
      lastUsedAt: null,
      status: "unlimited",
      campaigns: [],
    };
    row.totalUses += uses;
    if (!row.lastUsedAt || g._max.orderedAt > row.lastUsedAt)
      row.lastUsedAt = g._max.orderedAt;
    if (!row.firstUsedAt || g._min.orderedAt < row.firstUsedAt)
      row.firstUsedAt = g._min.orderedAt;
    if (STATUS_RANK[standing] > STATUS_RANK[row.status]) row.status = standing;
    row.campaigns.push({ ...info, uses, status: standing });
    byCustomer.set(g.customerId, row);

    const summary = perCampaign.get(g.campaignKey) ?? {
      ...info,
      uses: 0,
      customers: 0,
      atLimit: 0,
    };
    summary.uses += uses;
    summary.customers += 1;
    if (standing === "at_limit") summary.atLimit += 1;
    perCampaign.set(g.campaignKey, summary);
  }

  const all = [...byCustomer.values()];
  for (const row of all) row.campaigns.sort((a, b) => b.uses - a.uses);

  const counts = {
    all: all.length,
    at_limit: all.filter((r) => r.status === "at_limit").length,
    near_limit: all.filter((r) => r.status === "near_limit").length,
    repeat: all.filter((r) => r.totalUses > 1).length,
    unlimited: all.filter((r) => r.status === "unlimited").length,
  };

  const stats = {
    totalRedemptions: all.reduce((n, r) => n + r.totalUses, 0),
    recentRedemptions,
    customers: all.length,
    atLimit: counts.at_limit,
  };

  let rows = all.filter((r) => {
    if (status === "repeat") return r.totalUses > 1;
    if (status === "all") return true;
    return r.status === status;
  });

  let search = null;
  if (q) {
    try {
      const ids = await searchCustomerIds(admin, q);
      const matches = new Set(ids);
      rows = rows.filter((r) => matches.has(r.customerId));
      search = { truncated: ids.length >= SEARCH_LIMIT, error: null };
    } catch (error) {
      search = { truncated: false, error: error.message };
    }
  }

  rows.sort(
    sort === "recent"
      ? (a, b) => b.lastUsedAt - a.lastUsedAt
      : (a, b) => b.totalUses - a.totalUses || b.lastUsedAt - a.lastUsedAt,
  );

  return {
    campaigns: campaigns.map((c) => campaignInfo(c, c.campaignKey)),
    stats,
    counts,
    search,
    rows,
    campaignSummary: [...perCampaign.values()].sort((a, b) => b.uses - a.uses),
  };
}

/** Adds name/email to a slice of report rows. */
export async function withCustomerDetails(admin, rows) {
  const nodes = await lookupNodes(
    admin,
    rows.map((r) => r.customerId),
  );
  return rows.map((r) => ({ ...r, ...describeCustomer(nodes[r.customerId]) }));
}

/** One customer's ledger, with each order resolved where Shopify allows it. */
export async function getCustomerUsage({ admin, shop, customerId }) {
  const { byKey } = await loadCampaigns(shop);
  const redemptions = await db.discountRedemption.findMany({
    where: { shop, customerId },
    orderBy: { orderedAt: "desc" },
  });

  const nodes = await lookupNodes(admin, [
    customerId,
    ...redemptions.map((r) => r.orderId),
  ]);

  const perCampaign = new Map();
  for (const r of redemptions) {
    const entry = perCampaign.get(r.campaignKey) ?? {
      ...campaignInfo(byKey[r.campaignKey], r.campaignKey),
      uses: 0,
      lastUsedAt: null,
    };
    entry.uses += 1;
    if (!entry.lastUsedAt || r.orderedAt > entry.lastUsedAt)
      entry.lastUsedAt = r.orderedAt;
    perCampaign.set(r.campaignKey, entry);
  }

  return {
    customerId,
    found: Boolean(nodes[customerId]),
    ...describeCustomer(nodes[customerId]),
    campaigns: [...perCampaign.values()]
      .map((c) => ({ ...c, status: usageStatus(c.uses, c.limit) }))
      .sort((a, b) => b.uses - a.uses),
    orders: redemptions.map((r) => {
      const o = nodes[r.orderId];
      const info = campaignInfo(byKey[r.campaignKey], r.campaignKey);
      return {
        orderId: r.orderId,
        orderedAt: r.orderedAt,
        campaignKey: r.campaignKey,
        label: info.code || info.title,
        orderName: o?.name ?? null,
        cancelled: Boolean(o?.cancelledAt),
        total: o?.totalPriceSet?.shopMoney ?? null,
        discount: o?.totalDiscountsSet?.shopMoney ?? null,
      };
    }),
  };
}

export function parseFilters(url) {
  const p = url.searchParams;
  const status = p.get("status");
  const sort = p.get("sort");
  return {
    campaign: p.get("campaign") || "",
    status: STATUSES.includes(status) ? status : "all",
    sort: SORTS.includes(sort) ? sort : "uses",
    q: (p.get("q") || "").trim(),
    page: Math.max(1, Number(p.get("page")) || 1),
  };
}
