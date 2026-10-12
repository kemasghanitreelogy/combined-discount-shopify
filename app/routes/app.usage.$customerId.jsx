import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getCustomerUsage } from "../lib/usage-report.server";
import {
  StatTile,
  UsageBadge,
  formatDate,
  formatMoney,
  legacyId,
} from "../lib/usage-ui";

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const id = String(params.customerId || "");
  if (!/^\d+$/.test(id))
    throw new Response("Invalid customer", { status: 400 });

  const usage = await getCustomerUsage({
    admin,
    shop: session.shop,
    customerId: `gid://shopify/Customer/${id}`,
  });
  if (!usage.found && usage.orders.length === 0) {
    throw new Response("Customer not found", { status: 404 });
  }

  // Return to the list exactly as it was filtered.
  const back = new URL(request.url).searchParams.get("back");
  return { usage, backHref: back ? `/app/usage?${back}` : "/app/usage" };
};

export default function CustomerUsage() {
  const { usage, backHref } = useLoaderData();
  const name = usage.name || `Customer #${legacyId(usage.customerId)}`;
  const lastUsedAt = usage.orders[0]?.orderedAt ?? null;

  return (
    <s-page heading={name}>
      <s-link slot="breadcrumb-actions" href={backHref}>
        Customer usage
      </s-link>
      <s-button
        slot="primary-action"
        href={`shopify://admin/customers/${legacyId(usage.customerId)}`}
        target="_blank"
      >
        Open in Shopify
      </s-button>

      <s-section padding="base">
        <s-grid
          grid-template-columns="repeat(auto-fit, minmax(160px, 1fr))"
          gap="base"
        >
          <StatTile label="Discounted orders" value={usage.orders.length} />
          <StatTile label="Discounts used" value={usage.campaigns.length} />
          <StatTile label="Last used" value={formatDate(lastUsedAt)} />
          <StatTile
            label="All orders"
            value={usage.numberOfOrders ?? "—"}
            help="in Shopify, any discount"
          />
        </s-grid>
      </s-section>

      <s-section heading="Usage per discount">
        {usage.campaigns.length === 0 ? (
          <s-paragraph tone="neutral">
            This customer has not redeemed a combined discount.
          </s-paragraph>
        ) : (
          <s-grid
            grid-template-columns="repeat(auto-fit, minmax(240px, 1fr))"
            gap="base"
          >
            {usage.campaigns.map((c) => (
              <s-box
                key={c.campaignKey}
                padding="base"
                border="base"
                border-radius="base"
              >
                <s-stack direction="block" gap="small">
                  <s-stack
                    direction="inline"
                    gap="small-200"
                    align-items="center"
                  >
                    {c.discountId ? (
                      <s-link
                        href={`/app/discounts/${encodeURIComponent(c.discountId)}`}
                      >
                        {c.code || c.title}
                      </s-link>
                    ) : (
                      <s-text type="strong">{c.code || c.title}</s-text>
                    )}
                    {c.archived ? <s-badge>Archived</s-badge> : null}
                  </s-stack>
                  {c.code ? <s-text tone="neutral">{c.title}</s-text> : null}
                  <UsageBadge uses={c.uses} limit={c.limit} status={c.status} />
                  <s-text tone="neutral">
                    Last used {formatDate(c.lastUsedAt)}
                  </s-text>
                </s-stack>
              </s-box>
            ))}
          </s-grid>
        )}
      </s-section>

      <s-section padding="none" accessibility-label="Orders">
        <s-box padding="base">
          <s-heading>{`Orders counted toward the limit (${usage.orders.length})`}</s-heading>
        </s-box>
        <s-table>
          <s-table-header-row>
            <s-table-header list-slot="primary">Order</s-table-header>
            <s-table-header list-slot="inline">Discount</s-table-header>
            <s-table-header>Date</s-table-header>
            <s-table-header format="currency">Order total</s-table-header>
            <s-table-header format="currency">All discounts</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {usage.orders.map((o) => (
              <s-table-row key={o.orderId}>
                <s-table-cell>
                  <s-stack
                    direction="inline"
                    gap="small-200"
                    align-items="center"
                  >
                    <s-link
                      href={`shopify://admin/orders/${legacyId(o.orderId)}`}
                      target="_blank"
                    >
                      {o.orderName || `Order #${legacyId(o.orderId)}`}
                    </s-link>
                    {o.cancelled ? (
                      <s-badge tone="critical">Cancelled</s-badge>
                    ) : null}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-badge>{o.label}</s-badge>
                </s-table-cell>
                <s-table-cell>{formatDate(o.orderedAt)}</s-table-cell>
                <s-table-cell>{formatMoney(o.total)}</s-table-cell>
                <s-table-cell>{formatMoney(o.discount)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section slot="aside" heading="Customer">
        <s-stack direction="block" gap="small-200">
          <s-text type="strong">{name}</s-text>
          {usage.email ? <s-text tone="neutral">{usage.email}</s-text> : null}
          <s-text tone="neutral">ID {legacyId(usage.customerId)}</s-text>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Reading this page">
        <s-paragraph>
          Each row is an order the ledger counts toward this customer&apos;s
          limit. A cancelled order still listed here is removed on the next
          reconcile, which gives the use back. Orders older than 60 days may
          show only their ID.
        </s-paragraph>
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
