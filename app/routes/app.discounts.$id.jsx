import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

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

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const id = decodeURIComponent(params.id || "");
  if (!id) throw new Response("Missing id", { status: 400 });

  const response = await admin.graphql(
    `#graphql
      query DiscountDetail($id: ID!, $namespace: String!, $key: String!) {
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
              usageLimit
              codes(first: 5) { nodes { code } }
              appDiscountType { functionId }
              combinesWith { orderDiscounts productDiscounts shippingDiscounts }
            }
            ... on DiscountAutomaticApp {
              title
              status
              startsAt
              endsAt
              discountClasses
              appDiscountType { functionId }
              combinesWith { orderDiscounts productDiscounts shippingDiscounts }
            }
          }
        }
      }`,
    {
      variables: { id, namespace: METAFIELD_NAMESPACE, key: METAFIELD_KEY },
    },
  );
  const json = await response.json();
  const node = json?.data?.discountNode;
  if (!node) {
    throw new Response("Not found", { status: 404 });
  }
  const config = node.metafield?.jsonValue ?? null;

  const allIds = new Set();
  const pushIds = (arr) => (arr || []).forEach((id) => allIds.add(id));
  if (config) {
    pushIds(config.productAmountOff?.eligibleProductIds);
    pushIds(config.productAmountOff?.eligibleVariantIds);
    pushIds(config.buyXGetY?.buyProductIds);
    pushIds(config.buyXGetY?.buyVariantIds);
    pushIds(config.buyXGetY?.getProductIds);
    pushIds(config.buyXGetY?.getVariantIds);
  }
  const titles = await fetchProductTitles(admin, Array.from(allIds));

  return { id, node, config, titles };
};

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function statusTone(status) {
  if (status === "ACTIVE") return "success";
  if (status === "EXPIRED") return "critical";
  if (status === "SCHEDULED") return "info";
  return "neutral";
}

function IdList({ heading, ids, titles }) {
  if (!ids || !ids.length) return null;
  return (
    <s-stack direction="block" gap="small-100">
      <s-paragraph>
        <s-text type="strong">{heading}</s-text>
      </s-paragraph>
      <s-unordered-list>
        {ids.map((id) => (
          <s-list-item key={id}>{titles[id] || id}</s-list-item>
        ))}
      </s-unordered-list>
    </s-stack>
  );
}

export default function DiscountDetail() {
  const { node, config, titles } = useLoaderData();
  const d = node.discount;
  const isAutomatic = d?.__typename === "DiscountAutomaticApp";
  const code = isAutomatic ? "(automatic)" : d?.codes?.nodes?.[0]?.code ?? "(no code)";

  return (
    <s-page heading={`${code} — ${d?.title ?? ""}`}>
      <s-button
        slot="primary-action"
        variant="primary"
        href={`/app/combined-discount?id=${encodeURIComponent(node.id)}`}
      >
        Edit
      </s-button>
      <s-button slot="secondary-actions" href="/app/discounts">
        Back to list
      </s-button>

      <s-section heading="Status and schedule">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-badge tone={statusTone(d?.status)}>{d?.status || "—"}</s-badge>
            <s-badge tone={isAutomatic ? "info" : "neutral"}>
              {isAutomatic ? "Automatic" : "Code"}
            </s-badge>
            {(d?.discountClasses ?? []).map((c) => (
              <s-badge key={c}>{c}</s-badge>
            ))}
          </s-stack>
          <s-stack direction="inline" gap="large-200">
            <s-paragraph>
              <s-text type="strong">Starts:</s-text> {formatDate(d?.startsAt)}
            </s-paragraph>
            <s-paragraph>
              <s-text type="strong">Ends:</s-text> {formatDate(d?.endsAt)}
            </s-paragraph>
            {!isAutomatic ? (
              <s-paragraph>
                <s-text type="strong">One use per customer:</s-text>{" "}
                {d?.appliesOncePerCustomer ? "Yes" : "No"}
              </s-paragraph>
            ) : null}
          </s-stack>
        </s-stack>
      </s-section>

      {!config ? (
        <s-section heading="Configuration">
          <s-paragraph>No metafield configuration attached to this discount.</s-paragraph>
        </s-section>
      ) : (
        <>
          {config.orderAmountOff ? (
            <s-section heading="Amount off order">
              <s-paragraph>
                {config.orderAmountOff.isPercentage
                  ? `${config.orderAmountOff.value}% off order subtotal`
                  : `${config.orderAmountOff.value} off order subtotal (shop currency)`}
              </s-paragraph>
            </s-section>
          ) : null}

          {config.productAmountOff ? (
            <s-section heading="Amount off products">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  {config.productAmountOff.isPercentage
                    ? `${config.productAmountOff.value}% off each eligible item`
                    : `${config.productAmountOff.value} off each eligible item`}
                </s-paragraph>
                <IdList
                  heading="Eligible products"
                  ids={config.productAmountOff.eligibleProductIds}
                  titles={titles}
                />
                <IdList
                  heading="Eligible variants"
                  ids={config.productAmountOff.eligibleVariantIds}
                  titles={titles}
                />
                {!(
                  config.productAmountOff.eligibleProductIds?.length ||
                  config.productAmountOff.eligibleVariantIds?.length
                ) ? (
                  <s-paragraph tone="neutral">Applies to all products.</s-paragraph>
                ) : null}
              </s-stack>
            </s-section>
          ) : null}

          {config.buyXGetY ? (
            <s-section heading="Buy X get Y">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Buy <s-text type="strong">{config.buyXGetY.buyQuantity}</s-text>,
                  get <s-text type="strong">{config.buyXGetY.getQuantity}</s-text> at{" "}
                  <s-text type="strong">{config.buyXGetY.discountPercentage}%</s-text> off.
                </s-paragraph>
                <s-grid grid-template-columns="1fr 1fr" gap="large-200">
                  <s-box padding="base" border-radius="base" background="subdued">
                    <s-stack direction="block" gap="small-200">
                      <s-heading>Buy products (trigger)</s-heading>
                      <IdList
                        heading="Products"
                        ids={config.buyXGetY.buyProductIds}
                        titles={titles}
                      />
                      <IdList
                        heading="Variants"
                        ids={config.buyXGetY.buyVariantIds}
                        titles={titles}
                      />
                      {!(
                        config.buyXGetY.buyProductIds?.length ||
                        config.buyXGetY.buyVariantIds?.length
                      ) ? (
                        <s-paragraph tone="neutral">Any product triggers.</s-paragraph>
                      ) : null}
                    </s-stack>
                  </s-box>
                  <s-box padding="base" border-radius="base" background="subdued">
                    <s-stack direction="block" gap="small-200">
                      <s-heading>Get products (reward)</s-heading>
                      <IdList
                        heading="Products"
                        ids={config.buyXGetY.getProductIds}
                        titles={titles}
                      />
                      <IdList
                        heading="Variants"
                        ids={config.buyXGetY.getVariantIds}
                        titles={titles}
                      />
                      {!(
                        config.buyXGetY.getProductIds?.length ||
                        config.buyXGetY.getVariantIds?.length
                      ) ? (
                        <s-paragraph tone="neutral">Any product is the reward.</s-paragraph>
                      ) : null}
                    </s-stack>
                  </s-box>
                </s-grid>
              </s-stack>
            </s-section>
          ) : null}

          {config.freeShipping ? (
            <s-section heading="Free shipping">
              <s-paragraph>All delivery options are free when this code applies.</s-paragraph>
            </s-section>
          ) : null}

          {config.requiredUtmCampaign ? (
            <s-section heading="UTM gate">
              <s-paragraph>
                Only applies when the cart attribute{" "}
                <s-text type="strong">utm_campaign</s-text> equals{" "}
                <s-text type="strong">{config.requiredUtmCampaign}</s-text>.
              </s-paragraph>
            </s-section>
          ) : null}
        </>
      )}

      <s-section slot="aside" heading="Method">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            <s-text type="strong">Method:</s-text> {isAutomatic ? "Automatic" : "Code"}
          </s-paragraph>
          {!isAutomatic ? (
            <>
              <s-paragraph>
                <s-text type="strong">Code:</s-text> {code}
              </s-paragraph>
              {d?.codes?.nodes?.length > 1 ? (
                <s-paragraph>
                  Additional codes:{" "}
                  {d.codes.nodes
                    .slice(1)
                    .map((c) => c.code)
                    .join(", ")}
                </s-paragraph>
              ) : null}
            </>
          ) : (
            <s-paragraph tone="neutral">
              Applies at checkout without customer input.
            </s-paragraph>
          )}
          <s-paragraph>
            <s-text type="strong">Function ID:</s-text>{" "}
            {d?.appDiscountType?.functionId || "—"}
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Combines with">
        <s-stack direction="block" gap="small-100">
          <s-paragraph>
            Order discounts: {d?.combinesWith?.orderDiscounts ? "Yes" : "No"}
          </s-paragraph>
          <s-paragraph>
            Product discounts: {d?.combinesWith?.productDiscounts ? "Yes" : "No"}
          </s-paragraph>
          <s-paragraph>
            Shipping discounts:{" "}
            {d?.combinesWith?.shippingDiscounts ? "Yes" : "No"}
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Raw metafield">
        <s-box padding="base" border-radius="base" background="subdued">
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            <code>{JSON.stringify(config, null, 2)}</code>
          </pre>
        </s-box>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
