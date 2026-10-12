import { useRef, useState } from "react";
import {
  useLoaderData,
  useNavigation,
  useRouteError,
  useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  buildUsageReport,
  parseFilters,
  withCustomerDetails,
} from "../lib/usage-report.server";
import { RECENT_DAYS, SEARCH_LIMIT } from "../lib/usage-constants";
import {
  StatTile,
  StatusBadge,
  UsageBadge,
  formatDate,
  legacyId,
} from "../lib/usage-ui";

const PAGE_SIZE = 50;

const TABS = [
  { value: "all", label: "All" },
  { value: "at_limit", label: "At limit" },
  { value: "near_limit", label: "1 left" },
  { value: "repeat", label: "Used more than once" },
  { value: "unlimited", label: "No limit" },
];

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const filters = parseFilters(new URL(request.url));
  const report = await buildUsageReport({
    admin,
    shop: session.shop,
    ...filters,
  });

  const pageCount = Math.max(1, Math.ceil(report.rows.length / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const pageRows = report.rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return {
    filters: { ...filters, page, pageCount },
    campaigns: report.campaigns,
    stats: report.stats,
    counts: report.counts,
    search: report.search,
    matched: report.rows.length,
    campaignSummary: report.campaignSummary,
    rows: await withCustomerDetails(admin, pageRows),
  };
};

async function downloadCsv(search) {
  // App Bridge adds the session token to same-origin fetches, which a plain
  // link would not carry.
  const response = await fetch(`/app/usage/export${search}`);
  if (!response.ok) throw new Error(`Export failed (${response.status})`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `discount-usage-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function UsageOverview() {
  const {
    filters,
    campaigns,
    stats,
    counts,
    search,
    matched,
    campaignSummary,
    rows,
  } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const searchRef = useRef(null);

  const loading = navigation.state === "loading";
  const filtering = Boolean(
    filters.q || filters.campaign || filters.status !== "all",
  );

  const withParams = (patch) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, String(value));
      else next.delete(key);
    }
    return next;
  };
  const updateParams = (patch) => setSearchParams(withParams(patch));
  const submitSearch = (value) => {
    const q = String(value ?? "").trim();
    if (q !== filters.q) updateParams({ q, page: null });
  };
  const detailHref = (customerId) => {
    const back = searchParams.toString();
    return `/app/usage/${legacyId(customerId)}${back ? `?back=${encodeURIComponent(back)}` : ""}`;
  };

  const onExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const params = withParams({ page: null }).toString();
      await downloadCsv(params ? `?${params}` : "");
    } catch (error) {
      setExportError(error.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <s-page heading="Customer usage" inline-size="large">
      <s-button
        slot="primary-action"
        onClick={onExport}
        {...(exporting ? { loading: true } : {})}
        {...(matched === 0 ? { disabled: true } : {})}
      >
        Export CSV
      </s-button>
      <s-button slot="secondary-actions" href="/app/discounts">
        Discounts list
      </s-button>

      {exportError ? (
        <s-banner tone="critical" heading="Export failed">
          {exportError}
        </s-banner>
      ) : null}

      <s-section padding="base">
        <s-grid
          grid-template-columns="repeat(auto-fit, minmax(160px, 1fr))"
          gap="base"
        >
          <StatTile label="Total redemptions" value={stats.totalRedemptions} />
          <StatTile
            label={`Last ${RECENT_DAYS} days`}
            value={stats.recentRedemptions}
            help="redemptions"
          />
          <StatTile
            label="Customers"
            value={stats.customers}
            help="used a discount"
          />
          <StatTile
            label="At their limit"
            value={stats.atLimit}
            help={stats.atLimit ? "cannot redeem again" : "nobody yet"}
          />
        </s-grid>
      </s-section>

      <s-section padding="none" accessibility-label="Customers">
        <s-table {...(loading ? { loading: true } : {})}>
          <s-stack slot="filters" direction="block" gap="small">
            <s-button-group
              gap="none"
              accessibility-label="Filter by limit status"
            >
              {TABS.map((t) => (
                <s-button
                  key={t.value}
                  variant={filters.status === t.value ? "primary" : "secondary"}
                  onClick={() =>
                    updateParams({
                      status: t.value === "all" ? null : t.value,
                      page: null,
                    })
                  }
                >
                  {`${t.label} (${counts[t.value]})`}
                </s-button>
              ))}
            </s-button-group>
            <s-grid grid-template-columns="2fr 1fr 1fr" gap="small">
              <s-stack direction="inline" gap="small-200">
                <s-text-field
                  label="Search customers"
                  label-accessibility-visibility="exclusive"
                  placeholder="Name or email"
                  ref={searchRef}
                  value={filters.q}
                  onChange={(e) => submitSearch(e.target.value)}
                />
                <s-button
                  onClick={() => submitSearch(searchRef.current?.value)}
                >
                  Search
                </s-button>
              </s-stack>
              <s-select
                label="Discount"
                label-accessibility-visibility="exclusive"
                value={filters.campaign}
                onChange={(e) =>
                  updateParams({ campaign: e.target.value, page: null })
                }
              >
                <s-option value="">All discounts</s-option>
                {campaigns.map((c) => (
                  <s-option key={c.campaignKey} value={c.campaignKey}>
                    {(c.code ? `${c.code} — ${c.title}` : c.title) +
                      (c.archived ? " (archived)" : "")}
                  </s-option>
                ))}
              </s-select>
              <s-select
                label="Sort"
                label-accessibility-visibility="exclusive"
                value={filters.sort}
                onChange={(e) =>
                  updateParams({
                    sort: e.target.value === "uses" ? null : e.target.value,
                  })
                }
              >
                <s-option value="uses">Sort: most uses</s-option>
                <s-option value="recent">Sort: last used</s-option>
              </s-select>
            </s-grid>
            {search?.error ? (
              <s-text tone="critical">Search failed: {search.error}</s-text>
            ) : search?.truncated ? (
              <s-text tone="neutral">
                Showing customers among the first {SEARCH_LIMIT} matches —
                narrow the search for more.
              </s-text>
            ) : null}
            {filtering ? (
              <s-stack direction="inline" gap="small" align-items="center">
                <s-text tone="neutral">{matched} customer(s) match</s-text>
                <s-button variant="tertiary" href="/app/usage">
                  Clear filters
                </s-button>
              </s-stack>
            ) : null}
          </s-stack>

          <s-table-header-row>
            <s-table-header list-slot="primary">Customer</s-table-header>
            <s-table-header list-slot="inline">Status</s-table-header>
            <s-table-header format="numeric">Uses</s-table-header>
            <s-table-header list-slot="secondary">Per discount</s-table-header>
            <s-table-header>Last used</s-table-header>
            <s-table-header>First used</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.length === 0 ? (
              <s-table-row>
                <s-table-cell>
                  <s-text tone="neutral">
                    {filtering
                      ? "No customers match these filters."
                      : "No redemptions yet. Customers appear here once an order uses a combined discount."}
                  </s-text>
                </s-table-cell>
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
                <s-table-cell />
              </s-table-row>
            ) : (
              rows.map((r) => (
                <s-table-row
                  key={r.customerId}
                  click-delegate={`open-${legacyId(r.customerId)}`}
                >
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-link
                        id={`open-${legacyId(r.customerId)}`}
                        href={detailHref(r.customerId)}
                      >
                        {r.name || `Customer #${legacyId(r.customerId)}`}
                      </s-link>
                      {r.email ? (
                        <s-text tone="neutral">{r.email}</s-text>
                      ) : null}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <StatusBadge status={r.status} />
                  </s-table-cell>
                  <s-table-cell>
                    <s-text type="strong">{r.totalUses}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      {r.campaigns.map((c) => (
                        <UsageBadge
                          key={c.campaignKey}
                          label={c.code || c.title}
                          uses={c.uses}
                          limit={c.limit}
                          status={c.status}
                        />
                      ))}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{formatDate(r.lastUsedAt)}</s-table-cell>
                  <s-table-cell>{formatDate(r.firstUsedAt)}</s-table-cell>
                </s-table-row>
              ))
            )}
          </s-table-body>
        </s-table>
        {filters.pageCount > 1 ? (
          <s-box padding="base">
            <s-stack
              direction="inline"
              gap="base"
              align-items="center"
              justify-content="center"
            >
              <s-button
                accessibility-label="Previous page"
                onClick={() => updateParams({ page: filters.page - 1 })}
                {...(filters.page <= 1 ? { disabled: true } : {})}
              >
                Previous
              </s-button>
              <s-text tone="neutral">
                Page {filters.page} of {filters.pageCount}
              </s-text>
              <s-button
                accessibility-label="Next page"
                onClick={() => updateParams({ page: filters.page + 1 })}
                {...(filters.page >= filters.pageCount
                  ? { disabled: true }
                  : {})}
              >
                Next
              </s-button>
            </s-stack>
          </s-box>
        ) : null}
      </s-section>

      <s-section slot="aside" heading="By discount">
        {campaignSummary.length === 0 ? (
          <s-paragraph tone="neutral">No usage yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="small">
            {campaignSummary.map((c) => (
              <s-box
                key={c.campaignKey}
                padding="small"
                border-radius="base"
                border="base"
                background={
                  filters.campaign === c.campaignKey ? "subdued" : "base"
                }
              >
                <s-stack direction="block" gap="small-200">
                  <s-stack
                    direction="inline"
                    gap="small-200"
                    align-items="center"
                  >
                    <s-link
                      href={`/app/usage?${withParams({ campaign: c.campaignKey, page: null }).toString()}`}
                    >
                      {c.code || c.title}
                    </s-link>
                    {c.archived ? <s-badge>Archived</s-badge> : null}
                  </s-stack>
                  {c.code ? <s-text tone="neutral">{c.title}</s-text> : null}
                  <s-text>
                    {c.uses} uses · {c.customers} customers
                  </s-text>
                  {c.limit != null ? (
                    <s-text tone={c.atLimit ? "caution" : "neutral"}>
                      Limit {c.limit}/customer · {c.atLimit} at limit
                    </s-text>
                  ) : (
                    <s-text tone="neutral">No per-customer limit</s-text>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="How this is counted">
        <s-paragraph>
          From the app&apos;s redemption ledger — the same count the discount
          uses to enforce its per-customer limit. Cancelled orders drop out on
          the next reconcile. Click a customer to see the orders behind their
          number.
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
