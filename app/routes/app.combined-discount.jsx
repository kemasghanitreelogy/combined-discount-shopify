import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const FUNCTION_HANDLE = "combined-discount";
const METAFIELD_NAMESPACE = "$app";
const METAFIELD_KEY = "function-configuration";

async function fetchProductTitles(admin, ids) {
  if (!ids.length) return {};
  const response = await admin.graphql(
    `#graphql
      query ProductTitles($ids: [ID!]!) {
        nodes(ids: $ids) {
          __typename
          ... on Product { id title }
          ... on ProductVariant { id title displayName product { title } }
        }
      }`,
    { variables: { ids } },
  );
  const json = await response.json();
  const out = {};
  for (const n of json?.data?.nodes ?? []) {
    if (!n) continue;
    if (n.__typename === "Product") out[n.id] = n.title;
    else if (n.__typename === "ProductVariant") {
      out[n.id] = n.displayName || `${n.product?.title || ""} — ${n.title}`;
    }
  }
  return out;
}

function hydrateSelection(productIds, variantIds, titles) {
  const pids = productIds || [];
  const vids = variantIds || [];
  const byProduct = new Map();
  for (const pid of pids) {
    byProduct.set(pid, { id: pid, title: titles[pid] || pid, variants: [] });
  }
  for (const vid of vids) {
    const title = titles[vid] || vid;
    let assignedToProduct = false;
    for (const [, product] of byProduct) {
      if (typeof titles[vid] === "string" && typeof product.title === "string") {
        if (
          titles[vid].startsWith(product.title) ||
          titles[vid].includes(product.title)
        ) {
          product.variants.push({ id: vid, title });
          assignedToProduct = true;
          break;
        }
      }
    }
    if (!assignedToProduct) {
      byProduct.set(vid, { id: vid, title, variants: [{ id: vid, title }] });
    }
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

function buildConfigAndClasses(v) {
  const classes = new Set();
  const config = {};

  const clampPct = (n) => Math.max(0, Math.min(100, n));
  if (v.orderEnabled && Number(v.orderValue) > 0) {
    classes.add("ORDER");
    const isPct = v.orderKind === "percentage";
    config.orderAmountOff = {
      value: isPct ? clampPct(Number(v.orderValue)) : Number(v.orderValue),
      isPercentage: isPct,
    };
  }
  if (v.productEnabled && Number(v.productValue) > 0) {
    classes.add("PRODUCT");
    const isPct = v.productKind === "percentage";
    config.productAmountOff = {
      value: isPct ? clampPct(Number(v.productValue)) : Number(v.productValue),
      isPercentage: isPct,
      eligibleProductIds: normalizeIds(v.productEligibleProductIds),
      eligibleVariantIds: normalizeIds(v.productEligibleVariantIds),
    };
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

  return { discountClasses: Array.from(classes), config };
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
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
              codes(first: 1) { nodes { code } }
            }
            ... on DiscountAutomaticApp {
              title
              status
              startsAt
              endsAt
              discountClasses
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
  const titles = await fetchProductTitles(admin, Array.from(allIds));

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
      requiredUtmCampaign: config.requiredUtmCampaign || "",
      orderEnabled: Boolean(config.orderAmountOff),
      orderKind: config.orderAmountOff?.isPercentage ? "percentage" : "fixedAmount",
      orderValue: String(config.orderAmountOff?.value ?? "100000"),
      productEnabled: Boolean(config.productAmountOff),
      productKind: config.productAmountOff?.isPercentage ? "percentage" : "fixedAmount",
      productValue: String(config.productAmountOff?.value ?? "5000"),
      productSelection: hydrateSelection(
        config.productAmountOff?.eligibleProductIds,
        config.productAmountOff?.eligibleVariantIds,
        titles,
      ),
      bxgyEnabled: Boolean(config.buyXGetY),
      bxgyBuy: String(config.buyXGetY?.buyQuantity ?? "2"),
      bxgyPct: String(config.buyXGetY?.discountPercentage ?? "100"),
      bxgyBuySelection: hydrateSelection(
        config.buyXGetY?.buyProductIds,
        config.buyXGetY?.buyVariantIds,
        titles,
      ),
      bxgyGetSelection: hydrateSelection(
        config.buyXGetY?.getProductIds,
        config.buyXGetY?.getVariantIds,
        titles,
      ),
      shippingEnabled: Boolean(config.freeShipping),
    },
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const values = Object.fromEntries(formData);
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

  const { discountClasses, config } = buildConfigAndClasses({
    orderEnabled: values.orderEnabled === "on",
    orderKind: values.orderKind,
    orderValue: values.orderValue,
    productEnabled: values.productEnabled === "on",
    productKind: values.productKind,
    productValue: values.productValue,
    productEligibleProductIds: values.productEligibleProductIds,
    productEligibleVariantIds: values.productEligibleVariantIds,
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

  const metafields = [
    {
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
      type: "json",
      value: JSON.stringify(config),
    },
  ];
  const combinesWith = {
    orderDiscounts: false,
    productDiscounts: false,
    shippingDiscounts: false,
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
                discountId: appDiscountType { functionId }
                title status startsAt endsAt
              }
              userErrors { field message }
            }
          }`,
        { variables: { id: editId, automaticAppDiscount } },
      );
      const json = await response.json();
      const result = json?.data?.discountAutomaticAppUpdate;
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
            automaticAppDiscount { title status startsAt endsAt }
            userErrors { field message }
          }
        }`,
      { variables: { automaticAppDiscount } },
    );
    const json = await response.json();
    const result = json?.data?.discountAutomaticAppCreate;
    return {
      codeAppDiscount: result?.automaticAppDiscount
        ? { ...result.automaticAppDiscount, discountId: "automatic" }
        : null,
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
  return {
    codeAppDiscount: result?.codeAppDiscount ?? null,
    userErrors: result?.userErrors ?? [],
    mode: "create",
  };
};

function ProductPicker({ label, selection, setSelection }) {
  const shopify = useAppBridge();

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
        type: "product",
        multiple: true,
        selectionIds: selection.map((p) => ({ id: p.id })),
      });
      if (!selected || !selected.length) return;
      const normalized = selected.map((p) => ({
        id: p.id,
        title: p.title || p.handle || p.id,
        variants: Array.isArray(p.variants)
          ? p.variants.map((v) => ({
              id: v.id,
              title: v.title || v.displayName || v.id,
            }))
          : [],
      }));
      setSelection(normalized);
      shopify?.toast?.show?.(`Selected ${normalized.length} product(s)`);
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
        {label} — {selection.length} product(s)
        {totalVariants > 0 ? `, ${totalVariants} variant(s)` : ""} selected
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
                    Variants: {p.variants.map((v) => v.title).join(", ")}
                  </s-paragraph>
                ) : null}
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      ) : null}

      <s-stack direction="inline" gap="base">
        <s-button onClick={pick}>
          {selection.length > 0 ? "Change products" : "Pick products"}
        </s-button>
        {selection.length > 0 ? (
          <s-button variant="tertiary" onClick={clearAll}>
            Clear all
          </s-button>
        ) : null}
      </s-stack>

      <s-paragraph tone="neutral">
        Leave empty to apply to all products.
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

function selectionToIds(selection) {
  const productIds = selection.map((p) => p.id);
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
  const [productKind, setProductKind] = useState(edit?.productKind ?? "fixedAmount");
  const [productValue, setProductValue] = useState(edit?.productValue ?? "5000");
  const [productSelection, setProductSelection] = useState(edit?.productSelection ?? []);

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
    if (productEnabled) {
      form.set("productEnabled", "on");
      form.set("productKind", productKind);
      form.set("productValue", productValue);
      const ids = selectionToIds(productSelection);
      form.set("productEligibleProductIds", ids.productIds);
      form.set("productEligibleVariantIds", ids.variantIds);
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
              <ValueWithKind
                kind={productKind}
                setKind={setProductKind}
                value={productValue}
                setValue={setProductValue}
                labelFixed="Amount off per item"
                labelPct="Percent off per item"
              />
              <ProductPicker
                label="Eligible products"
                selection={productSelection}
                setSelection={setProductSelection}
              />
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
          Each enabled toggle is bundled into one Shopify Function discount. Dates and the
          per-customer limit are enforced natively by Shopify; eligibility and UTM gating
          run inside the function.
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
