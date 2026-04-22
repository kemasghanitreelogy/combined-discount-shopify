import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const FUNCTION_HANDLE = "combined-discount";

async function findFunctionId(admin) {
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

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const functionId = await findFunctionId(admin);

  const response = await admin.graphql(
    `#graphql
      query HomeDiscounts {
        discountNodes(first: 100) {
          nodes {
            id
            discount {
              __typename
              ... on DiscountCodeApp {
                title
                status
                startsAt
                endsAt
                discountClasses
                appDiscountType { functionId }
                codes(first: 1) { nodes { code } }
              }
              ... on DiscountAutomaticApp {
                title
                status
                startsAt
                endsAt
                discountClasses
                appDiscountType { functionId }
              }
            }
          }
        }
      }`,
  );
  const json = await response.json();
  const nodes = json?.data?.discountNodes?.nodes ?? [];
  const rows = nodes
    .filter(
      (n) =>
        (n.discount?.__typename === "DiscountCodeApp" ||
          n.discount?.__typename === "DiscountAutomaticApp") &&
        (!functionId ||
          !n.discount?.appDiscountType?.functionId ||
          String(n.discount.appDiscountType.functionId) === String(functionId)),
    )
    .map((n) => {
      const d = n.discount;
      const isAutomatic = d.__typename === "DiscountAutomaticApp";
      return {
        id: n.id,
        method: isAutomatic ? "Automatic" : "Code",
        code: isAutomatic ? null : d.codes?.nodes?.[0]?.code ?? null,
        title: d.title ?? "",
        status: d.status ?? "",
        startsAt: d.startsAt ?? null,
        endsAt: d.endsAt ?? null,
        discountClasses: d.discountClasses ?? [],
      };
    });

  const stats = {
    total: rows.length,
    active: rows.filter((r) => r.status === "ACTIVE").length,
    scheduled: rows.filter((r) => r.status === "SCHEDULED").length,
    expired: rows.filter((r) => r.status === "EXPIRED").length,
    code: rows.filter((r) => r.method === "Code").length,
    automatic: rows.filter((r) => r.method === "Automatic").length,
  };

  return {
    functionId,
    stats,
    recent: rows.slice(0, 5),
  };
};

function statusTone(status) {
  if (status === "ACTIVE") return "success";
  if (status === "EXPIRED") return "critical";
  if (status === "SCHEDULED") return "info";
  return "neutral";
}

function formatDate(value) {
  if (!value) return "—";
  return String(value).slice(0, 10);
}

export default function Index() {
  const { functionId, stats, recent } = useLoaderData();

  return (
    <s-page heading="Combined Discount">
      <s-button
        slot="primary-action"
        variant="primary"
        href="/app/combined-discount"
      >
        Create combined discount
      </s-button>
      <s-button slot="secondary-actions" href="/app/discounts">
        View all
      </s-button>

      <s-section heading="Overview">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Build one discount code (or automatic rule) that bundles up to four
            reward types — amount off order, amount off products, Buy X get Y, and
            free shipping — gated by date range, eligible products, per-customer
            limits, and UTM campaign.
          </s-paragraph>
          <s-grid grid-template-columns="1fr 1fr 1fr 1fr" gap="base">
            <s-box padding="base" border-radius="base" background="subdued">
              <s-stack direction="block" gap="small-100">
                <s-paragraph tone="neutral">Total</s-paragraph>
                <s-heading>{stats.total}</s-heading>
              </s-stack>
            </s-box>
            <s-box padding="base" border-radius="base" background="subdued">
              <s-stack direction="block" gap="small-100">
                <s-paragraph tone="neutral">Active</s-paragraph>
                <s-heading>{stats.active}</s-heading>
              </s-stack>
            </s-box>
            <s-box padding="base" border-radius="base" background="subdued">
              <s-stack direction="block" gap="small-100">
                <s-paragraph tone="neutral">Code</s-paragraph>
                <s-heading>{stats.code}</s-heading>
              </s-stack>
            </s-box>
            <s-box padding="base" border-radius="base" background="subdued">
              <s-stack direction="block" gap="small-100">
                <s-paragraph tone="neutral">Automatic</s-paragraph>
                <s-heading>{stats.automatic}</s-heading>
              </s-stack>
            </s-box>
          </s-grid>
        </s-stack>
      </s-section>

      <s-section heading="Recent discounts">
        {recent.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              No combined discounts yet. Create your first one to start offering
              bundled rewards.
            </s-paragraph>
            <s-button variant="primary" href="/app/combined-discount">
              Create combined discount
            </s-button>
          </s-stack>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header list-slot="primary">Code</s-table-header>
              <s-table-header>Title</s-table-header>
              <s-table-header>Method</s-table-header>
              <s-table-header list-slot="inline">Status</s-table-header>
              <s-table-header>Types</s-table-header>
              <s-table-header>Starts</s-table-header>
              <s-table-header>Ends</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recent.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>
                    <s-link href={`/app/discounts/${encodeURIComponent(r.id)}`}>
                      <s-text type="strong">{r.code || "(automatic)"}</s-text>
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>{r.title}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={r.method === "Automatic" ? "info" : "neutral"}>
                      {r.method}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={statusTone(r.status)}>{r.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-100">
                      {r.discountClasses.length === 0 ? (
                        <s-text tone="neutral">—</s-text>
                      ) : (
                        r.discountClasses.map((c) => (
                          <s-badge key={c}>{c}</s-badge>
                        ))
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{formatDate(r.startsAt)}</s-table-cell>
                  <s-table-cell>{formatDate(r.endsAt)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="Quick actions">
        <s-stack direction="block" gap="small-300">
          <s-button variant="primary" href="/app/combined-discount">
            Create combined discount
          </s-button>
          <s-button href="/app/discounts">View all discounts</s-button>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Status breakdown">
        <s-stack direction="block" gap="small-100">
          <s-paragraph>
            <s-text type="strong">Active:</s-text> {stats.active}
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Scheduled:</s-text> {stats.scheduled}
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Expired:</s-text> {stats.expired}
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Tips">
        <s-unordered-list>
          <s-list-item>
            Set per-type eligibility with the product picker to scope rewards
            precisely.
          </s-list-item>
          <s-list-item>
            Use the UTM gate to run traffic-source specific campaigns without
            exposing codes publicly.
          </s-list-item>
          <s-list-item>
            Pick Automatic when you want the discount to apply without customer
            input; pick Code when you want to distribute a shareable code.
          </s-list-item>
        </s-unordered-list>
      </s-section>

      {!functionId ? (
        <s-section heading="Setup required">
          <s-box padding="base" border-radius="base" background="subdued">
            <s-paragraph>
              The combined-discount Shopify Function isn't registered yet. Run{" "}
              <s-text type="strong">shopify app dev</s-text> or{" "}
              <s-text type="strong">shopify app deploy</s-text> to push it, then
              refresh this page.
            </s-paragraph>
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
