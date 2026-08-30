import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  CONFIG_KEY as METAFIELD_KEY,
  CONFIG_NAMESPACE as METAFIELD_NAMESPACE,
  FUNCTION_HANDLE,
  newCampaignKey,
} from "../lib/combined-discount.server";
import { backfillPurchaseHistory } from "../lib/purchase-backfill.server";

async function fetchProductTitles(admin, ids) {
  if (!ids.length) return { titles: {}, parents: {} };
  const response = await admin.graphql(
    `#graphql
      query ProductTitles($ids: [ID!]!) {
        nodes(ids: $ids) {
          __typename
          ... on Product { id title }
          ... on ProductVariant { id title displayName product { id title } }
        }
      }`,
    { variables: { ids } },
  );
  const json = await response.json();
  const titles = {};
  const parents = {};
  for (const n of json?.data?.nodes ?? []) {
    if (!n) continue;
    if (n.__typename === "Product") titles[n.id] = n.title;
    else if (n.__typename === "ProductVariant") {
      titles[n.id] = n.displayName || `${n.product?.title || ""} — ${n.title}`;
      if (n.product?.id) {
        parents[n.id] = n.product.id;
        titles[n.product.id] = titles[n.product.id] || n.product.title;
      }
    }
  }
  return { titles, parents };
}

/**
 * Rebuilds the picker's `{ product, variants }` shape from the flat ID lists in
 * the saved configuration.
 *
 * Variants are grouped by their real parent product ID. An earlier version
 * matched on title prefixes, which silently failed whenever a rule targeted
 * variants without also listing their product — every variant then became its
 * own pseudo-product and its ID leaked into `productIds` on the next save.
 *
 * `variantsOnly` records that the parent was reconstructed for display and was
 * not itself selected, so `selectionToIds` can round-trip without inventing a
 * product-wide match the merchant never asked for.
 */
function hydrateSelection(productIds, variantIds, titles, parents = {}) {
  const byProduct = new Map();
  for (const pid of productIds || []) {
    byProduct.set(pid, {
      id: pid,
      title: titles[pid] || pid,
      variants: [],
      variantsOnly: false,
    });
  }
  for (const vid of variantIds || []) {
    const parent = parents[vid] || vid;
    if (!byProduct.has(parent)) {
      byProduct.set(parent, {
        id: parent,
        title: titles[parent] || parent,
        variants: [],
        variantsOnly: true,
      });
    }
    byProduct.get(parent).variants.push({ id: vid, title: titles[vid] || vid });
  }
  return Array.from(byProduct.values());
}

async function findCombinedDiscountFunctionId(admin) {
  const response = await admin.graphql(
    `#graphql
      query FindFunction {
        shopifyFunctions(first: 50) {
          nodes { id title apiType }
        }
      }`,
  );
  const json = await response.json();
  const nodes = json?.data?.shopifyFunctions?.nodes ?? [];
  const match = nodes.find(
    (fn) =>
      fn.apiType === "discount" &&
      (fn.title === FUNCTION_HANDLE || fn.title?.includes("combined-discount")),
  );
  return match?.id ?? null;
}

function normalizeIds(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePricingRules(raw) {
  if (!raw) return [];
  let parsed = [];
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((rule) => {
      const isPct = rule?.kind === "percentage";
      const value = Number(rule?.value);
      if (!Number.isFinite(value) || value <= 0) return null;
      const out = {
        value: isPct ? Math.max(0, Math.min(100, value)) : value,
        isPercentage: isPct,
        appliesToEachItem: true,
        productIds: normalizeIds(rule?.productIds),
        variantIds: normalizeIds(rule?.variantIds),
      };
      const message = String(rule?.message ?? "").trim();
      if (message) out.message = message;
      return out;
    })
    .filter(Boolean);
}

function buildConfigAndClasses(v) {
  const classes = new Set();
  const config = {};

  const clampPct = (n) => Math.max(0, Math.min(100, n));

  // Stable per-discount key. The Function input schema exposes no discount ID,
  // so this is how a customer's counters are attributed to this campaign.
  config.campaignKey = v.campaignKey || newCampaignKey();

  if (v.orderEnabled && Number(v.orderValue) > 0) {
    classes.add("ORDER");
    const isPct = v.orderKind === "percentage";
    config.orderAmountOff = {
      value: isPct ? clampPct(Number(v.orderValue)) : Number(v.orderValue),
      isPercentage: isPct,
    };
  }
  if (v.productEnabled) {
    const rules = parsePricingRules(v.pricingRules);
    if (rules.length) {
      classes.add("PRODUCT");
      config.productAmountOffRules = rules;
    }
  }
  if (v.bxgyEnabled && Number(v.bxgyBuy) > 0 && Number(v.bxgyPct) > 0) {
    classes.add("PRODUCT");
    config.buyXGetY = {
      buyQuantity: Number(v.bxgyBuy),
      discountPercentage: Number(v.bxgyPct),
      buyProductIds: normalizeIds(v.bxgyBuyProductIds),
      buyVariantIds: normalizeIds(v.bxgyBuyVariantIds),
      getProductIds: normalizeIds(v.bxgyGetProductIds),
      getVariantIds: normalizeIds(v.bxgyGetVariantIds),
    };
  }
  if (v.shippingEnabled) {
    classes.add("SHIPPING");
    config.freeShipping = true;
  }
  if (v.requiredUtmCampaign && v.requiredUtmCampaign.trim()) {
    config.requiredUtmCampaign = v.requiredUtmCampaign.trim();
  }

  const qualifyingProductIds = normalizeIds(v.eligibilityProductIds);
  const qualifyingVariantIds = normalizeIds(v.eligibilityVariantIds);

  if (v.eligibilityEnabled && v.purchasedBefore) {
    config.customerEligibility = {
      purchasedBefore: String(v.purchasedBefore).slice(0, 10),
      // Always campaign-scoped. Historical eligibility is projected per campaign
      // from a customer segment, so the function reads that campaign's
      // qualifiedAt rather than the global first-purchase date.
      requireQualifyingProducts: true,
    };
  }

  const maxOrders = Number(v.maxOrdersPerCustomer);
  if (v.usageLimitEnabled && Number.isFinite(maxOrders) && maxOrders > 0) {
    config.usageLimit = { maxOrdersPerCustomer: Math.trunc(maxOrders) };
  }

  return {
    discountClasses: Array.from(classes),
    config,
    campaign: {
      campaignKey: config.campaignKey,
      qualifyingProductIds,
      qualifyingVariantIds,
      maxOrdersPerCustomer: config.usageLimit?.maxOrdersPerCustomer ?? null,
      purchasedBefore: config.customerEligibility?.purchasedBefore ?? null,
    },
  };
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const functionId = await findCombinedDiscountFunctionId(admin);

  const url = new URL(request.url);
  const editId = url.searchParams.get("id");
  if (!editId) {
    return { functionId, edit: null };
  }

  const response = await admin.graphql(
    `#graphql
      query EditDiscount($id: ID!, $namespace: String!, $key: String!) {
        discountNode(id: $id) {
          id
          metafield(namespace: $namespace, key: $key) { jsonValue }
          discount {
            __typename
            ... on DiscountCodeApp {
              title
              status
              startsAt
              endsAt
              discountClasses
              appliesOncePerCustomer
              combinesWith {
                orderDiscounts
                productDiscounts
                shippingDiscounts
              }
              codes(first: 1) { nodes { code } }
            }
            ... on DiscountAutomaticApp {
              title
              status
              startsAt
              endsAt
              discountClasses
              combinesWith {
                orderDiscounts
                productDiscounts
                shippingDiscounts
              }
            }
          }
        }
      }`,
    {
      variables: { id: editId, namespace: METAFIELD_NAMESPACE, key: METAFIELD_KEY },
    },
  );
  const json = await response.json();
  const node = json?.data?.discountNode;
  const typename = node?.discount?.__typename;
  if (!node || (typename !== "DiscountCodeApp" && typename !== "DiscountAutomaticApp")) {
    return { functionId, edit: null };
  }
  const d = node.discount;
  const config = node.metafield?.jsonValue ?? {};
  const method = typename === "DiscountAutomaticApp" ? "automatic" : "code";

  const allIds = new Set();
  const pushIds = (arr) => (arr || []).forEach((x) => allIds.add(x));
  pushIds(config.productAmountOff?.eligibleProductIds);
  pushIds(config.productAmountOff?.eligibleVariantIds);
  pushIds(config.buyXGetY?.buyProductIds);
  pushIds(config.buyXGetY?.buyVariantIds);
  pushIds(config.buyXGetY?.getProductIds);
  pushIds(config.buyXGetY?.getVariantIds);
  for (const rule of config.productAmountOffRules ?? []) {
    pushIds(rule?.productIds);
    pushIds(rule?.variantIds);
  }

  const campaignKey = config.campaignKey ?? null;
  const campaignRow = campaignKey
    ? await db.discountCampaign.findUnique({
        where: { shop_campaignKey: { shop, campaignKey } },
      })
    : null;
  pushIds(campaignRow ? JSON.parse(campaignRow.qualifyingProductIds) : []);
  pushIds(campaignRow ? JSON.parse(campaignRow.qualifyingVariantIds) : []);

  const { titles, parents } = await fetchProductTitles(admin, Array.from(allIds));

  // Redemption ledger stats, so the merchant can see the cap actually working.
  const [redemptionCount, customersAtCap] = campaignKey
    ? await Promise.all([
        db.discountRedemption.count({ where: { shop, campaignKey } }),
        config.usageLimit?.maxOrdersPerCustomer
          ? db.discountRedemption
              .groupBy({
                by: ["customerId"],
                where: { shop, campaignKey },
                _count: { orderId: true },
              })
              .then(
                (rows) =>
                  rows.filter(
                    (r) => r._count.orderId >= config.usageLimit.maxOrdersPerCustomer,
                  ).length,
              )
          : Promise.resolve(0),
      ])
    : [0, 0];

  return {
    functionId,
    edit: {
      id: node.id,
      method,
      code: d.codes?.nodes?.[0]?.code ?? "",
      title: d.title ?? "",
      startsAt: d.startsAt ? String(d.startsAt).slice(0, 10) : "",
      endsAt: d.endsAt ? String(d.endsAt).slice(0, 10) : "",
      appliesOncePerCustomer: Boolean(d.appliesOncePerCustomer),
      combinesWithOrder: Boolean(d.combinesWith?.orderDiscounts),
      combinesWithProduct: Boolean(d.combinesWith?.productDiscounts),
      combinesWithShipping: Boolean(d.combinesWith?.shippingDiscounts),
      requiredUtmCampaign: config.requiredUtmCampaign || "",
      orderEnabled: Boolean(config.orderAmountOff),
      orderKind: config.orderAmountOff?.isPercentage ? "percentage" : "fixedAmount",
      orderValue: String(config.orderAmountOff?.value ?? "100000"),
      campaignKey,
      productEnabled: Boolean(
        config.productAmountOffRules?.length || config.productAmountOff,
      ),
      // Legacy single-rate discounts are surfaced as a one-row pricing table so
      // saving from this screen migrates them forward.
      pricingRules: (config.productAmountOffRules?.length
        ? config.productAmountOffRules
        : config.productAmountOff
          ? [
              {
                value: config.productAmountOff.value,
                isPercentage: config.productAmountOff.isPercentage,
                productIds: config.productAmountOff.eligibleProductIds,
                variantIds: config.productAmountOff.eligibleVariantIds,
              },
            ]
          : []
      ).map((rule, index) => ({
        uid: `rule-${index}`,
        kind: rule.isPercentage ? "percentage" : "fixedAmount",
        value: String(rule.value ?? ""),
        message: rule.message ?? "",
        selection: hydrateSelection(rule.productIds, rule.variantIds, titles, parents),
      })),
      eligibilityEnabled: Boolean(config.customerEligibility?.purchasedBefore),
      purchasedBefore: config.customerEligibility?.purchasedBefore ?? "",
      eligibilitySelection: hydrateSelection(
        campaignRow ? JSON.parse(campaignRow.qualifyingProductIds) : [],
        campaignRow ? JSON.parse(campaignRow.qualifyingVariantIds) : [],
        titles,
        parents,
      ),
      usageLimitEnabled: Boolean(config.usageLimit?.maxOrdersPerCustomer),
      maxOrdersPerCustomer: String(config.usageLimit?.maxOrdersPerCustomer ?? "3"),
      redemptionCount,
      customersAtCap,
      bxgyEnabled: Boolean(config.buyXGetY),
      bxgyBuy: String(config.buyXGetY?.buyQuantity ?? "2"),
      bxgyPct: String(config.buyXGetY?.discountPercentage ?? "100"),
      bxgyBuySelection: hydrateSelection(
        config.buyXGetY?.buyProductIds,
        config.buyXGetY?.buyVariantIds,
        titles,
        parents,
      ),
      bxgyGetSelection: hydrateSelection(
        config.buyXGetY?.getProductIds,
        config.buyXGetY?.getVariantIds,
        titles,
        parents,
      ),
      shippingEnabled: Boolean(config.freeShipping),
    },
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const values = Object.fromEntries(formData);

  // Rebuilding purchase history is its own long-running job, not a discount save.
  if (values.intent === "backfill") {
    try {
      const result = await backfillPurchaseHistory({
        admin,
        shop,
        cursor: values.cursor ? String(values.cursor) : null,
      });
      return { backfill: result, userErrors: [] };
    } catch (error) {
      return {
        userErrors: [
          {
            message:
              `Backfill failed: ${error.message}. ` +
              "This needs the read_customers and read_orders scopes; " +
              "order history older than 60 days also needs read_all_orders.",
          },
        ],
      };
    }
  }

  const editId = values.editId ? String(values.editId) : null;
  const method = values.method === "automatic" ? "automatic" : "code";
  const code = String(values.code || "").trim();
  const title = String(values.title || "").trim();
  const appliesOncePerCustomer = values.appliesOncePerCustomer === "on";
  const startsAt = values.startsAt
    ? new Date(String(values.startsAt)).toISOString()
    : new Date().toISOString();
  const endsAt = values.endsAt
    ? new Date(String(values.endsAt) + "T23:59:59").toISOString()
    : null;

  const { discountClasses, config, campaign } = buildConfigAndClasses({
    campaignKey: values.campaignKey,
    orderEnabled: values.orderEnabled === "on",
    orderKind: values.orderKind,
    orderValue: values.orderValue,
    productEnabled: values.productEnabled === "on",
    pricingRules: values.pricingRules,
    eligibilityEnabled: values.eligibilityEnabled === "on",
    purchasedBefore: values.purchasedBefore,
    eligibilityProductIds: values.eligibilityProductIds,
    eligibilityVariantIds: values.eligibilityVariantIds,
    usageLimitEnabled: values.usageLimitEnabled === "on",
    maxOrdersPerCustomer: values.maxOrdersPerCustomer,
    bxgyEnabled: values.bxgyEnabled === "on",
    bxgyBuy: values.bxgyBuy,
    bxgyPct: values.bxgyPct,
    bxgyBuyProductIds: values.bxgyBuyProductIds,
    bxgyBuyVariantIds: values.bxgyBuyVariantIds,
    bxgyGetProductIds: values.bxgyGetProductIds,
    bxgyGetVariantIds: values.bxgyGetVariantIds,
    shippingEnabled: values.shippingEnabled === "on",
    requiredUtmCampaign: values.requiredUtmCampaign,
  });

  if (!title) {
    return { userErrors: [{ message: "Title is required." }] };
  }
  if (method === "code" && !code) {
    return { userErrors: [{ message: "Code is required for code-based discounts." }] };
  }
  if (discountClasses.length === 0) {
    return {
      userErrors: [
        { message: "Enable at least one discount type with valid values." },
      ],
    };
  }

  const functionId = await findCombinedDiscountFunctionId(admin);
  if (!functionId) {
    return {
      userErrors: [
        {
          message:
            "Combined-discount function not registered. Run `shopify app dev` or `shopify app deploy`.",
        },
      ],
    };
  }

  /**
   * Mirrors the campaign into Postgres. The orders webhook needs to answer
   * "did this order redeem this campaign, and does this order qualify the
   * customer?" without re-reading every discount from the Admin API, and the
   * redemption ledger needs a stable key to hang off.
   */
  const recordCampaign = async (discountId) => {
    if (!discountId) return;
    const data = {
      shop,
      campaignKey: campaign.campaignKey,
      discountId,
      method,
      title,
      code: method === "code" ? code : null,
      qualifyingProductIds: JSON.stringify(campaign.qualifyingProductIds),
      qualifyingVariantIds: JSON.stringify(campaign.qualifyingVariantIds),
      maxOrdersPerCustomer: campaign.maxOrdersPerCustomer,
      purchasedBefore: campaign.purchasedBefore,
      archived: false,
    };
    // A discount keeps one campaign key for life, but an edit can arrive before
    // the row exists (legacy discounts), so reconcile on either unique key.
    const existing = await db.discountCampaign.findFirst({
      where: { shop, OR: [{ campaignKey: campaign.campaignKey }, { discountId }] },
    });
    if (existing) {
      await db.discountCampaign.update({ where: { id: existing.id }, data });
    } else {
      await db.discountCampaign.create({ data });
    }
  };

  const metafields = [
    {
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
      type: "json",
      value: JSON.stringify(config),
    },
  ];
  // Which other discount classes this one is willing to stack with. Shopify
  // accepts any combination of the three for an app discount — verified against
  // the Admin API — so the merchant decides, not us.
  //
  // What the merchant should know: product discounts on *separate* cart lines
  // combine on every plan, but two product discounts on the *same* line need
  // Shopify Plus. A shopper can also carry at most 5 product/order codes per
  // order.
  const combinesWith = {
    orderDiscounts: values.combinesWithOrder === "on",
    productDiscounts: values.combinesWithProduct === "on",
    shippingDiscounts: values.combinesWithShipping === "on",
  };

  if (method === "automatic") {
    const automaticAppDiscount = {
      title,
      functionId,
      discountClasses,
      combinesWith,
      startsAt,
      ...(endsAt ? { endsAt } : {}),
      metafields,
    };
    if (editId) {
      const response = await admin.graphql(
        `#graphql
          mutation UpdateAutomatic($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
            discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
              automaticAppDiscount {
                discountId
                title status startsAt endsAt
              }
              userErrors { field message }
            }
          }`,
        { variables: { id: editId, automaticAppDiscount } },
      );
      const json = await response.json();
      const result = json?.data?.discountAutomaticAppUpdate;
      if (result?.automaticAppDiscount && !result.userErrors?.length) {
        await recordCampaign(result.automaticAppDiscount.discountId ?? editId);
      }
      return {
        codeAppDiscount: result?.automaticAppDiscount
          ? { ...result.automaticAppDiscount, discountId: editId }
          : null,
        userErrors: result?.userErrors ?? [],
        mode: "update",
      };
    }
    const response = await admin.graphql(
      `#graphql
        mutation CreateAutomatic($automaticAppDiscount: DiscountAutomaticAppInput!) {
          discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
            automaticAppDiscount { discountId title status startsAt endsAt }
            userErrors { field message }
          }
        }`,
      { variables: { automaticAppDiscount } },
    );
    const json = await response.json();
    const result = json?.data?.discountAutomaticAppCreate;
    if (result?.automaticAppDiscount && !result.userErrors?.length) {
      await recordCampaign(result.automaticAppDiscount.discountId);
    }
    return {
      codeAppDiscount: result?.automaticAppDiscount ?? null,
      userErrors: result?.userErrors ?? [],
      mode: "create",
    };
  }

  const codeAppDiscount = {
    title,
    code,
    functionId,
    appliesOncePerCustomer,
    discountClasses,
    combinesWith,
    startsAt,
    ...(endsAt ? { endsAt } : {}),
    metafields,
  };

  if (editId) {
    const response = await admin.graphql(
      `#graphql
        mutation UpdateCombinedCode($id: ID!, $codeAppDiscount: DiscountCodeAppInput!) {
          discountCodeAppUpdate(id: $id, codeAppDiscount: $codeAppDiscount) {
            codeAppDiscount {
              discountId title status startsAt endsAt
              codes(first: 1) { nodes { code } }
            }
            userErrors { field message }
          }
        }`,
      { variables: { id: editId, codeAppDiscount } },
    );
    const json = await response.json();
    const result = json?.data?.discountCodeAppUpdate;
    if (result?.codeAppDiscount && !result.userErrors?.length) {
      await recordCampaign(result.codeAppDiscount.discountId ?? editId);
    }
    return {
      codeAppDiscount: result?.codeAppDiscount ?? null,
      userErrors: result?.userErrors ?? [],
      mode: "update",
    };
  }

  const response = await admin.graphql(
    `#graphql
      mutation CreateCombinedCode($codeAppDiscount: DiscountCodeAppInput!) {
        discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
          codeAppDiscount {
            discountId title status startsAt endsAt
            codes(first: 1) { nodes { code } }
          }
          userErrors { field message }
        }
      }`,
    { variables: { codeAppDiscount } },
  );
  const json = await response.json();
  const result = json?.data?.discountCodeAppCreate;
  if (result?.codeAppDiscount && !result.userErrors?.length) {
    await recordCampaign(result.codeAppDiscount.discountId);
  }
  return {
    codeAppDiscount: result?.codeAppDiscount ?? null,
    userErrors: result?.userErrors ?? [],
    mode: "create",
  };
};

/**
 * @param {"product"|"variant"} mode  `variant` lets the merchant pick individual
 *   variants, which is what per-variant pricing needs — picking a whole product
 *   would give every one of its variants the same amount.
 */
function ProductPicker({ label, selection, setSelection, mode = "product" }) {
  const shopify = useAppBridge();
  const isVariantMode = mode === "variant";

  const pick = async () => {
    try {
      const picker =
        (typeof window !== "undefined" && window.shopify?.resourcePicker) ||
        shopify?.resourcePicker;
      if (!picker) {
        shopify?.toast?.show?.("Resource picker not available", { isError: true });
        return;
      }
      const selected = await picker({
        type: isVariantMode ? "variant" : "product",
        multiple: true,
        selectionIds: selection.map((p) => ({
          id: p.id,
          ...(p.variants?.length
            ? { variants: p.variants.map((v) => ({ id: v.id })) }
            : {}),
        })),
      });
      if (!selected || !selected.length) return;

      let normalized;
      if (isVariantMode) {
        // The picker returns ProductVariant[]; regroup under each parent product
        // purely for display. `variantsOnly` keeps the product out of the saved
        // productIds, so only the chosen variants ever match.
        const byProduct = new Map();
        for (const variant of selected) {
          const parentId = variant.product?.id || variant.id;
          if (!byProduct.has(parentId)) {
            byProduct.set(parentId, {
              id: parentId,
              title: variant.product?.title || parentId,
              variants: [],
              variantsOnly: true,
            });
          }
          byProduct.get(parentId).variants.push({
            id: variant.id,
            title: variant.displayName || variant.title || variant.id,
          });
        }
        normalized = Array.from(byProduct.values());
      } else {
        normalized = selected.map((p) => ({
          id: p.id,
          title: p.title || p.handle || p.id,
          variantsOnly: false,
          variants: Array.isArray(p.variants)
            ? p.variants.map((v) => ({
                id: v.id,
                title: v.title || v.displayName || v.id,
              }))
            : [],
        }));
      }

      setSelection(normalized);
      const count = isVariantMode
        ? normalized.reduce((n, p) => n + p.variants.length, 0)
        : normalized.length;
      shopify?.toast?.show?.(
        `Selected ${count} ${isVariantMode ? "variant" : "product"}(s)`,
      );
    } catch (err) {
      shopify?.toast?.show?.(`Picker error: ${err?.message || err}`, { isError: true });
    }
  };

  const removeProduct = (productId) => {
    setSelection(selection.filter((p) => p.id !== productId));
  };

  const clearAll = () => setSelection([]);

  const totalVariants = selection.reduce((n, p) => n + (p.variants?.length || 0), 0);

  return (
    <s-stack direction="block" gap="small-300">
      <s-paragraph>
        {label} —{" "}
        {isVariantMode
          ? `${totalVariants} variant(s) selected`
          : `${selection.length} product(s)${totalVariants > 0 ? `, ${totalVariants} variant(s)` : ""} selected`}
      </s-paragraph>

      {selection.length > 0 ? (
        <s-stack direction="block" gap="small-200">
          {selection.map((p) => (
            <s-box
              key={p.id}
              padding="small-300"
              border-radius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="small-100">
                <s-stack direction="inline" gap="base">
                  <s-paragraph>
                    <s-text type="strong">{p.title}</s-text>
                  </s-paragraph>
                  <s-button
                    variant="tertiary"
                    onClick={() => removeProduct(p.id)}
                  >
                    Remove
                  </s-button>
                </s-stack>
                {p.variants && p.variants.length > 0 ? (
                  <s-paragraph tone="neutral">
                    {p.variantsOnly ? "Only these variants: " : "Variants: "}
                    {p.variants.map((v) => v.title).join(", ")}
                  </s-paragraph>
                ) : null}
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      ) : null}

      <s-stack direction="inline" gap="base">
        <s-button onClick={pick}>
          {selection.length > 0
            ? `Change ${isVariantMode ? "variants" : "products"}`
            : `Pick ${isVariantMode ? "variants" : "products"}`}
        </s-button>
        {selection.length > 0 ? (
          <s-button variant="tertiary" onClick={clearAll}>
            Clear all
          </s-button>
        ) : null}
      </s-stack>

      <s-paragraph tone="neutral">
        {isVariantMode
          ? "Each variant picked here gets this rule's amount. Leave empty to make this the fallback for everything not matched above."
          : "Leave empty to apply to all products."}
      </s-paragraph>
    </s-stack>
  );
}

function ValueWithKind({ kind, setKind, value, setValue, labelFixed, labelPct }) {
  const handlePercentageChange = (raw) => {
    if (raw === "" || raw == null) {
      setValue("");
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setValue(raw);
      return;
    }
    const clamped = Math.max(0, Math.min(100, n));
    setValue(String(clamped));
  };

  const handleKindChange = (next) => {
    if (next === "percentage") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 100) {
        setValue("100");
      }
    }
    setKind(next);
  };

  return (
    <s-grid grid-template-columns="auto 1fr" gap="base">
      <s-select
        label="Type"
        value={kind}
        onChange={(e) => handleKindChange(e.target.value)}
      >
        <s-option value="fixedAmount">Fixed amount</s-option>
        <s-option value="percentage">Percentage</s-option>
      </s-select>
      {kind === "percentage" ? (
        <s-number-field
          label={labelPct}
          value={value}
          min={0}
          max={100}
          step={1}
          suffix="%"
          details="Maximum 100%."
          onChange={(e) => handlePercentageChange(e.target.value)}
        />
      ) : (
        <s-money-field
          label={labelFixed}
          value={value}
          min={0}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
    </s-grid>
  );
}

let ruleCounter = 0;
const makeRule = () => ({
  uid: `rule-${Date.now()}-${(ruleCounter += 1)}`,
  kind: "fixedAmount",
  value: "",
  message: "",
  selection: [],
});

/**
 * The per-product pricing table.
 *
 * Every cart line is claimed by exactly one row, and specificity wins: a row
 * naming the exact variant beats a row naming the product, which beats a row
 * with no products at all. That is what makes the amount off differ per
 * variant without rows fighting over the same line.
 */
function PricingRules({ rules, setRules }) {
  const update = (uid, patch) =>
    setRules(rules.map((rule) => (rule.uid === uid ? { ...rule, ...patch } : rule)));

  const remove = (uid) => {
    const next = rules.filter((rule) => rule.uid !== uid);
    setRules(next.length ? next : [makeRule()]);
  };

  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target], next[index]];
    setRules(next);
  };

  return (
    <s-stack direction="block" gap="large-200">
      {rules.map((rule, index) => {
        const scope = rule.selection.length
          ? `${rule.selection.length} product(s)` +
            (rule.selection.some((p) => p.variants?.length)
              ? `, ${rule.selection.reduce((n, p) => n + (p.variants?.length || 0), 0)} variant(s)`
              : "")
          : "every other product (catch-all)";
        return (
          <s-box
            key={rule.uid}
            padding="base"
            border-radius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base">
                <s-heading>Rule {index + 1}</s-heading>
                <s-button
                  variant="tertiary"
                  {...(index === 0 ? { disabled: true } : {})}
                  onClick={() => move(index, -1)}
                >
                  Move up
                </s-button>
                <s-button
                  variant="tertiary"
                  {...(index === rules.length - 1 ? { disabled: true } : {})}
                  onClick={() => move(index, 1)}
                >
                  Move down
                </s-button>
                <s-button variant="tertiary" onClick={() => remove(rule.uid)}>
                  Remove
                </s-button>
              </s-stack>

              <s-paragraph tone="neutral">Applies to {scope}.</s-paragraph>

              <ValueWithKind
                kind={rule.kind}
                setKind={(kind) => update(rule.uid, { kind })}
                value={rule.value}
                setValue={(value) => update(rule.uid, { value })}
                labelFixed="Amount off per item"
                labelPct="Percent off per item"
              />

              <ProductPicker
                mode="variant"
                label="Variants for this rule"
                selection={rule.selection}
                setSelection={(selection) => update(rule.uid, { selection })}
              />

              <s-text-field
                label="Checkout label (optional)"
                details="Shown next to the discount at checkout. Defaults to the amount."
                value={rule.message}
                onChange={(e) => update(rule.uid, { message: e.target.value })}
              />
            </s-stack>
          </s-box>
        );
      })}

      <s-button onClick={() => setRules([...rules, makeRule()])}>
        Add pricing rule
      </s-button>

      <s-paragraph tone="neutral">
        Rules are checked in order within each specificity tier, so move the row
        you want to win to the top. A rule with no products selected acts as the
        fallback for everything not matched above it.
      </s-paragraph>
    </s-stack>
  );
}

function selectionToIds(selection) {
  const productIds = selection.filter((p) => !p.variantsOnly).map((p) => p.id);
  const variantIds = selection.flatMap((p) =>
    Array.isArray(p.variants) ? p.variants.map((v) => v.id) : [],
  );
  return { productIds: productIds.join(","), variantIds: variantIds.join(",") };
}

export default function CombinedDiscount() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const { edit } = useLoaderData();
  const isEditing = Boolean(edit?.id);

  const [method, setMethod] = useState(edit?.method ?? "code");
  const [code, setCode] = useState(edit?.code ?? "SAVEBIG");
  const [title, setTitle] = useState(edit?.title ?? "Combined savings");
  const [startsAt, setStartsAt] = useState(edit?.startsAt ?? "");
  const [endsAt, setEndsAt] = useState(edit?.endsAt ?? "");
  const [appliesOncePerCustomer, setAppliesOncePerCustomer] = useState(
    edit ? edit.appliesOncePerCustomer : true,
  );
  const [requiredUtmCampaign, setRequiredUtmCampaign] = useState(
    edit?.requiredUtmCampaign ?? "",
  );

  const [orderEnabled, setOrderEnabled] = useState(edit ? edit.orderEnabled : true);
  const [orderKind, setOrderKind] = useState(edit?.orderKind ?? "fixedAmount");
  const [orderValue, setOrderValue] = useState(edit?.orderValue ?? "100000");

  const [productEnabled, setProductEnabled] = useState(edit ? edit.productEnabled : false);
  const [pricingRules, setPricingRules] = useState(
    edit?.pricingRules?.length ? edit.pricingRules : [makeRule()],
  );

  const [eligibilityEnabled, setEligibilityEnabled] = useState(
    edit ? edit.eligibilityEnabled : false,
  );
  const [purchasedBefore, setPurchasedBefore] = useState(edit?.purchasedBefore ?? "");
  const [eligibilitySelection, setEligibilitySelection] = useState(
    edit?.eligibilitySelection ?? [],
  );

  const [combinesWithOrder, setCombinesWithOrder] = useState(
    edit ? edit.combinesWithOrder : false,
  );
  const [combinesWithProduct, setCombinesWithProduct] = useState(
    edit ? edit.combinesWithProduct : false,
  );
  const [combinesWithShipping, setCombinesWithShipping] = useState(
    edit ? edit.combinesWithShipping : false,
  );

  const [usageLimitEnabled, setUsageLimitEnabled] = useState(
    edit ? edit.usageLimitEnabled : false,
  );
  const [maxOrdersPerCustomer, setMaxOrdersPerCustomer] = useState(
    edit?.maxOrdersPerCustomer ?? "3",
  );

  const [bxgyEnabled, setBxgyEnabled] = useState(edit ? edit.bxgyEnabled : false);
  const [bxgyBuy, setBxgyBuy] = useState(edit?.bxgyBuy ?? "2");
  const [bxgyPct, setBxgyPct] = useState(edit?.bxgyPct ?? "100");
  const [bxgyBuySelection, setBxgyBuySelection] = useState(edit?.bxgyBuySelection ?? []);
  const [bxgyGetSelection, setBxgyGetSelection] = useState(edit?.bxgyGetSelection ?? []);

  const [shippingEnabled, setShippingEnabled] = useState(
    edit ? edit.shippingEnabled : true,
  );

  const isSubmitting =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.data?.codeAppDiscount?.discountId) {
      shopify.toast.show(
        fetcher.data.mode === "update"
          ? "Combined discount updated"
          : "Combined discount created",
      );
    } else if (fetcher.data?.userErrors?.length) {
      shopify.toast.show(fetcher.data.userErrors[0].message, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const isBackfilling =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formData?.get("intent") === "backfill";

  // The backfill walks every purchasing customer, which is far more than one
  // request should hold open. Each call returns a cursor; this drives it to
  // completion and keeps a running total for the merchant.
  const [backfillTotals, setBackfillTotals] = useState(null);

  const runBackfill = (cursor = null) => {
    if (!cursor) setBackfillTotals(null);
    const form = new FormData();
    form.set("intent", "backfill");
    if (cursor) form.set("cursor", cursor);
    fetcher.submit(form, { method: "POST" });
  };

  useEffect(() => {
    const result = fetcher.data?.backfill;
    if (!result || fetcher.state !== "idle") return;
    setBackfillTotals((prev) => {
      const totals = {
        scanned: (prev?.scanned ?? 0) + result.customersScanned,
        updated: (prev?.updated ?? 0) + result.customersUpdated,
        truncated: (prev?.truncated ?? 0) + (result.truncatedCustomers ?? 0),
        done: result.done,
        cursor: result.nextCursor,
        segmentQuery: result.segmentQuery ?? prev?.segmentQuery ?? null,
        note: result.note ?? null,
        errors: [...(prev?.errors ?? []), ...(result.errors ?? [])].slice(0, 20),
      };
      if (!result.done && result.nextCursor && result.nextCursor !== prev?.cursor) {
        runBackfill(result.nextCursor);
      }
      return totals;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, fetcher.state]);

  const submit = () => {
    const form = new FormData();
    if (isEditing) form.set("editId", edit.id);
    form.set("method", method);
    form.set("code", code);
    form.set("title", title);
    if (startsAt) form.set("startsAt", startsAt);
    if (endsAt) form.set("endsAt", endsAt);
    if (appliesOncePerCustomer) form.set("appliesOncePerCustomer", "on");
    if (requiredUtmCampaign) form.set("requiredUtmCampaign", requiredUtmCampaign);
    if (orderEnabled) {
      form.set("orderEnabled", "on");
      form.set("orderKind", orderKind);
      form.set("orderValue", orderValue);
    }
    if (edit?.campaignKey) form.set("campaignKey", edit.campaignKey);
    if (productEnabled) {
      form.set("productEnabled", "on");
      form.set(
        "pricingRules",
        JSON.stringify(
          pricingRules.map((rule) => {
            const ids = selectionToIds(rule.selection);
            return {
              kind: rule.kind,
              value: rule.value,
              message: rule.message,
              productIds: ids.productIds,
              variantIds: ids.variantIds,
            };
          }),
        ),
      );
    }
    if (eligibilityEnabled && purchasedBefore) {
      form.set("eligibilityEnabled", "on");
      form.set("purchasedBefore", purchasedBefore);
      const ids = selectionToIds(eligibilitySelection);
      form.set("eligibilityProductIds", ids.productIds);
      form.set("eligibilityVariantIds", ids.variantIds);
    }
    if (usageLimitEnabled) {
      form.set("usageLimitEnabled", "on");
      form.set("maxOrdersPerCustomer", maxOrdersPerCustomer);
    }
    if (bxgyEnabled) {
      form.set("bxgyEnabled", "on");
      form.set("bxgyBuy", bxgyBuy);
      form.set("bxgyPct", bxgyPct);
      const buyIds = selectionToIds(bxgyBuySelection);
      const getIds = selectionToIds(bxgyGetSelection);
      form.set("bxgyBuyProductIds", buyIds.productIds);
      form.set("bxgyBuyVariantIds", buyIds.variantIds);
      form.set("bxgyGetProductIds", getIds.productIds);
      form.set("bxgyGetVariantIds", getIds.variantIds);
    }
    if (shippingEnabled) form.set("shippingEnabled", "on");
    if (combinesWithOrder) form.set("combinesWithOrder", "on");
    if (combinesWithProduct) form.set("combinesWithProduct", "on");
    if (combinesWithShipping) form.set("combinesWithShipping", "on");
    fetcher.submit(form, { method: "POST" });
  };

  const enabledCount = [
    orderEnabled,
    productEnabled,
    bxgyEnabled,
    shippingEnabled,
  ].filter(Boolean).length;

  return (
    <s-page heading={isEditing ? `Edit ${edit.code || "discount"}` : "Combined discount"}>
      {isEditing ? (
        <s-button slot="primary-action" href="/app/discounts">
          Back to list
        </s-button>
      ) : null}
      <s-section heading="Basics">
        <s-stack direction="block" gap="large-200">
          <s-select
            label="Method"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            {...(isEditing ? { disabled: true } : {})}
            details={
              isEditing
                ? "Method can't be changed after creation. Delete and recreate to switch."
                : "Code = customer enters a code at checkout. Automatic = applies without a code."
            }
          >
            <s-option value="code">Code</s-option>
            <s-option value="automatic">Automatic</s-option>
          </s-select>

          <s-grid grid-template-columns="1fr 1fr" gap="base">
            {method === "code" ? (
              <s-text-field
                label="Code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            ) : (
              <s-text-field label="Code" value="(not used for automatic)" disabled />
            )}
            <s-text-field
              label="Title (admin only)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </s-grid>

          <s-grid grid-template-columns="1fr 1fr" gap="base">
            <s-date-field
              label="Starts at"
              name="startsAt"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
            <s-date-field
              label="Ends at (optional)"
              name="endsAt"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </s-grid>

          {method === "code" ? (
            <s-checkbox
              label="Limit to one use per customer"
              checked={appliesOncePerCustomer}
              onChange={(e) => setAppliesOncePerCustomer(e.target.checked)}
            />
          ) : null}

          <s-text-field
            label="Required UTM campaign (optional)"
            details="Only applies when cart attribute 'utm_campaign' matches. See the aside for the theme snippet."
            value={requiredUtmCampaign}
            onChange={(e) => setRequiredUtmCampaign(e.target.value)}
          />
        </s-stack>
      </s-section>

      <s-section heading="Customer eligibility">
        <s-stack direction="block" gap="base">
          <s-checkbox
            label="Only for customers who already purchased before a date"
            checked={eligibilityEnabled}
            onChange={(e) => setEligibilityEnabled(e.target.checked)}
          />
          {eligibilityEnabled ? (
            <s-stack direction="block" gap="large-200">
              <s-date-field
                label="Qualifying purchase must be before"
                name="purchasedBefore"
                details="The purchase must be strictly before this day. Customers with no earlier purchase are excluded."
                value={purchasedBefore}
                onChange={(e) => setPurchasedBefore(e.target.value)}
              />

              <s-box padding="base" border-radius="base" background="subdued">
                <s-stack direction="block" gap="small-300">
                  <s-heading>Qualifying products (optional)</s-heading>
                  <s-paragraph tone="neutral">
                    Leave empty and any purchase before the date qualifies. Pick
                    products — a lifetime plan, a membership — and only customers
                    who bought one of them before the date qualify.
                  </s-paragraph>
                  <ProductPicker
                    label="Qualifying products"
                    selection={eligibilitySelection}
                    setSelection={setEligibilitySelection}
                  />
                </s-stack>
              </s-box>

              <s-box padding="base" border-radius="base" background="subdued">
                <s-stack direction="block" gap="small-300">
                  <s-heading>Purchase history</s-heading>
                  <s-paragraph tone="neutral">
                    This gate reads a per-customer record the app maintains from
                    the orders webhook. Customers who bought before the app was
                    installed have no record yet — save the discount, then run
                    this once to build it from a Shopify customer segment.
                  </s-paragraph>
                  <s-paragraph tone="neutral">
                    Re-run it whenever you change the date above, otherwise the
                    projected records still describe the old cutoff. Historical
                    qualifying is matched per product — Shopify segments have no
                    variant-level filter — while new orders match the exact
                    variant.
                  </s-paragraph>
                  <s-button
                    onClick={() => runBackfill()}
                    {...(isBackfilling ? { loading: true } : {})}
                  >
                    Rebuild purchase history
                  </s-button>
                  {backfillTotals ? (
                    <s-stack direction="block" gap="small-200">
                      <s-paragraph>
                        {backfillTotals.done ? "Finished — s" : "Working… s"}canned{" "}
                        <s-text type="strong">{backfillTotals.scanned}</s-text>{" "}
                        customers, updated{" "}
                        <s-text type="strong">{backfillTotals.updated}</s-text>.
                      </s-paragraph>
                      {backfillTotals.segmentQuery ? (
                        <s-paragraph tone="neutral">
                          Segment: <s-text type="strong">{backfillTotals.segmentQuery}</s-text>
                        </s-paragraph>
                      ) : null}
                      {backfillTotals.truncated ? (
                        <s-paragraph tone="critical">
                          {backfillTotals.truncated} customer(s) had order history
                          Shopify would not return. Reading further back than 60 days
                          needs the read_all_orders scope, which Shopify grants on
                          request — until then their earliest purchase date may be
                          wrong.
                        </s-paragraph>
                      ) : null}
                      {backfillTotals.note ? (
                        <s-paragraph tone="critical">{backfillTotals.note}</s-paragraph>
                      ) : null}
                      {backfillTotals.errors?.length ? (
                        <s-paragraph tone="critical">
                          {backfillTotals.errors.length} error(s):{" "}
                          {backfillTotals.errors[0]}
                        </s-paragraph>
                      ) : null}
                    </s-stack>
                  ) : null}
                </s-stack>
              </s-box>
            </s-stack>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Usage limit">
        <s-stack direction="block" gap="base">
          <s-checkbox
            label="Limit how many separate orders each customer can use this on"
            checked={usageLimitEnabled}
            onChange={(e) => setUsageLimitEnabled(e.target.checked)}
          />
          <s-paragraph tone="neutral">
            {combinesWithOrder || combinesWithProduct || combinesWithShipping
              ? `Combines with: ${[
                  combinesWithProduct ? "product" : null,
                  combinesWithOrder ? "order" : null,
                  combinesWithShipping ? "shipping" : null,
                ]
                  .filter(Boolean)
                  .join(", ")} discounts.`
              : "Exclusive — won't stack with any other discount."}
          </s-paragraph>
          {usageLimitEnabled ? (
            <s-stack direction="block" gap="base">
              <s-number-field
                label="Orders per customer"
                value={maxOrdersPerCustomer}
                min={1}
                step={1}
                details="Counted from real orders, so a customer can spread the uses across separate checkouts."
                onChange={(e) => setMaxOrdersPerCustomer(e.target.value)}
              />
              {isEditing ? (
                <s-paragraph tone="neutral">
                  Redeemed on{" "}
                  <s-text type="strong">{edit.redemptionCount ?? 0}</s-text>{" "}
                  order(s) so far;{" "}
                  <s-text type="strong">{edit.customersAtCap ?? 0}</s-text>{" "}
                  customer(s) have reached the cap.
                </s-paragraph>
              ) : null}
            </s-stack>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Amount off order">
        <s-stack direction="block" gap="base">
          <s-checkbox
            label="Enable amount off the order subtotal"
            checked={orderEnabled}
            onChange={(e) => setOrderEnabled(e.target.checked)}
          />
          {orderEnabled ? (
            <ValueWithKind
              kind={orderKind}
              setKind={setOrderKind}
              value={orderValue}
              setValue={setOrderValue}
              labelFixed="Amount off"
              labelPct="Percent off"
            />
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Amount off products">
        <s-stack direction="block" gap="base">
          <s-checkbox
            label="Enable amount off eligible cart lines"
            checked={productEnabled}
            onChange={(e) => setProductEnabled(e.target.checked)}
          />
          {productEnabled ? (
            <s-stack direction="block" gap="base">
              <s-paragraph tone="neutral">
                Give each product or variant its own amount off. Add a rule per
                price point — the amount a cart line receives is whichever rule
                names it most specifically.
              </s-paragraph>
              <PricingRules rules={pricingRules} setRules={setPricingRules} />
            </s-stack>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Buy X get Y">
        <s-stack direction="block" gap="base">
          <s-checkbox
            label="Enable buy X get Y rewards"
            checked={bxgyEnabled}
            onChange={(e) => setBxgyEnabled(e.target.checked)}
          />
          {bxgyEnabled ? (
            <s-stack direction="block" gap="large-200">
              <s-grid grid-template-columns="1fr 1fr" gap="base">
                <s-number-field
                  label="Buy quantity (X)"
                  value={bxgyBuy}
                  min={1}
                  step={1}
                  onChange={(e) => setBxgyBuy(e.target.value)}
                />
                <s-number-field
                  label="Discount % on Get products"
                  value={bxgyPct}
                  min={1}
                  max={100}
                  step={1}
                  suffix="%"
                  onChange={(e) => setBxgyPct(e.target.value)}
                />
              </s-grid>

              <s-grid grid-template-columns="1fr 1fr" gap="large-200">
                <s-box padding="base" border-radius="base" background="subdued">
                  <s-stack direction="block" gap="small-300">
                    <s-heading>Buy products (trigger)</s-heading>
                    <s-paragraph tone="neutral">
                      Customer must have at least <s-text type="strong">{bxgyBuy}</s-text> of these in the cart.
                    </s-paragraph>
                    <ProductPicker
                      label="Buy products"
                      selection={bxgyBuySelection}
                      setSelection={setBxgyBuySelection}
                    />
                  </s-stack>
                </s-box>

                <s-box padding="base" border-radius="base" background="subdued">
                  <s-stack direction="block" gap="small-300">
                    <s-heading>Get products (reward)</s-heading>
                    <s-paragraph tone="neutral">
                      Every matching cart line gets{" "}
                      <s-text type="strong">{bxgyPct}%</s-text> off when the trigger is met.
                    </s-paragraph>
                    <ProductPicker
                      label="Get products"
                      selection={bxgyGetSelection}
                      setSelection={setBxgyGetSelection}
                    />
                  </s-stack>
                </s-box>
              </s-grid>
            </s-stack>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Combine with other discounts">
        <s-stack direction="block" gap="base">
          <s-paragraph tone="neutral">
            Choose which of Shopify&apos;s own discount types this one is allowed to
            stack with. Leave everything off to make it exclusive — a shopper who
            uses this discount then can&apos;t also use another.
          </s-paragraph>

          <s-checkbox
            label="Combine with product discounts"
            details="Other discounts on specific products or variants."
            checked={combinesWithProduct}
            onChange={(e) => setCombinesWithProduct(e.target.checked)}
          />
          <s-checkbox
            label="Combine with order discounts"
            details="Discounts taken off the order subtotal."
            checked={combinesWithOrder}
            onChange={(e) => setCombinesWithOrder(e.target.checked)}
          />
          <s-checkbox
            label="Combine with shipping discounts"
            details="Free or reduced shipping offers."
            checked={combinesWithShipping}
            onChange={(e) => setCombinesWithShipping(e.target.checked)}
          />

          <s-box padding="base" border-radius="base" background="subdued">
            <s-stack direction="block" gap="small-200">
              <s-heading>What Shopify allows</s-heading>
              <s-unordered-list>
                <s-list-item>
                  Two product discounts land on the same order only when they hit{" "}
                  <s-text type="strong">different items</s-text>. Stacking two on one
                  cart line needs Shopify Plus.
                </s-list-item>
                <s-list-item>
                  A shopper can carry at most{" "}
                  <s-text type="strong">5 product or order codes</s-text> plus 1
                  shipping code per order.
                </s-list-item>
                <s-list-item>
                  Both sides have to agree — the other discount must also be set to
                  combine, or neither stacks.
                </s-list-item>
              </s-unordered-list>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Free shipping">
        <s-checkbox
          label="Make all shipping options free"
          checked={shippingEnabled}
          onChange={(e) => setShippingEnabled(e.target.checked)}
        />
      </s-section>

      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text type="strong">{enabledCount}</s-text> of 4 discount types selected
            {requiredUtmCampaign ? `. UTM-gated on "${requiredUtmCampaign}".` : "."}
          </s-paragraph>
          {eligibilityEnabled && purchasedBefore ? (
            <s-paragraph tone="neutral">
              Restricted to customers who purchased
              {eligibilitySelection.length ? " a qualifying product" : ""} before{" "}
              <s-text type="strong">{purchasedBefore}</s-text>.
            </s-paragraph>
          ) : null}
          {usageLimitEnabled ? (
            <s-paragraph tone="neutral">
              Usable on up to{" "}
              <s-text type="strong">{maxOrdersPerCustomer}</s-text> separate
              order(s) per customer.
            </s-paragraph>
          ) : null}
          <s-button
            variant="primary"
            onClick={submit}
            {...(isSubmitting ? { loading: true } : {})}
          >
            {isEditing ? "Save changes" : "Create combined discount"}
          </s-button>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-paragraph>
          Each enabled toggle is bundled into one Shopify Function discount, configured
          entirely from this page. Start and end dates are enforced natively by Shopify;
          everything else runs inside the function.
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">Pricing rules</s-text> — every cart line is claimed by
            one rule, most specific first: variant beats product beats catch-all.
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Customer eligibility</s-text> — the app records each
            customer&apos;s first (or first qualifying) purchase date from the orders
            webhook, and the function compares it to your cutoff.
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Usage limit</s-text> — redemptions are counted per
            customer from real orders, so the cap spans separate checkouts rather than
            one cart.
          </s-list-item>
        </s-unordered-list>
        <s-paragraph tone="neutral">
          Both customer gates need an identified customer. Carts that check out without a
          customer account are excluded, since there is nothing to attribute history or a
          redemption count to.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="UTM tracking snippet">
        <s-paragraph>
          Paste inside <s-text type="strong">theme.liquid</s-text> (before the closing <s-text type="strong">&lt;/body&gt;</s-text> tag). It:
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>Captures all <s-text type="strong">utm_*</s-text> query params on any landing page</s-list-item>
          <s-list-item>Persists them to <s-text type="strong">localStorage</s-text> for 30 minutes (session window for auto-applying discounts)</s-list-item>
          <s-list-item>Writes them to <s-text type="strong">cart.attributes</s-text> on page load</s-list-item>
          <s-list-item>Re-applies after any AJAX cart mutation (add, change, update, clear) so even a cart started later still carries the UTM</s-list-item>
        </s-unordered-list>
        <s-box padding="base" background="subdued" border-radius="base">
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
{`<script>
(function () {
  var KEY = 'app_utm_attrs';
  var TTL_MS = 30 * 60 * 1000; // 30 minutes
  var UTM_KEYS = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'];

  // 1. Capture from URL, save to localStorage
  var params = new URLSearchParams(window.location.search);
  var fromUrl = {};
  UTM_KEYS.forEach(function (k) {
    var v = params.get(k);
    if (v) fromUrl[k] = v;
  });
  if (Object.keys(fromUrl).length) {
    try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), attrs: fromUrl })); } catch (e) {}
  }

  // 2. Read stored attrs (respect TTL)
  function readStored() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.at || Date.now() - obj.at > TTL_MS) {
        localStorage.removeItem(KEY);
        return null;
      }
      return obj.attrs || null;
    } catch (e) { return null; }
  }
  var stored = readStored();
  if (!stored) return;

  // 3. Push to cart attributes
  function pushToCart() {
    return fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attributes: stored }),
    }).catch(function () {});
  }
  pushToCart();

  // 4. Re-apply after cart mutations
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var promise = origFetch(input, init);
      if (/\\/cart\\/(add|change|update|clear)(\\.js)?/.test(url)) {
        promise.then(function () { setTimeout(pushToCart, 50); });
      }
      return promise;
    };
  }
})();
</script>`}
          </pre>
        </s-box>
        <s-paragraph tone="neutral">
          The combined-discount function reads <s-text type="strong">cart.attributes.utm_campaign</s-text> to gate discounts. The other utm_* keys are stored too — useful for reporting or to gate on additional fields later.
        </s-paragraph>
      </s-section>

      {fetcher.data?.userErrors?.length ? (
        <s-section heading="Errors">
          <s-box padding="base" border-radius="base" background="subdued">
            <pre style={{ margin: 0 }}><code>{JSON.stringify(fetcher.data.userErrors, null, 2)}</code></pre>
          </s-box>
        </s-section>
      ) : null}

      {fetcher.data?.codeAppDiscount ? (
        <s-section heading="Created">
          <s-box padding="base" border-radius="base" background="subdued">
            <pre style={{ margin: 0 }}><code>{JSON.stringify(fetcher.data.codeAppDiscount, null, 2)}</code></pre>
          </s-box>
        </s-section>
      ) : null}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
