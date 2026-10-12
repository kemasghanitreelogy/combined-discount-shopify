# Workflow: Customer Discount Usage Dashboard

Generated with `/sc:workflow` (strategy: systematic, depth: normal) · 2026-10-12
Design input: UI/UX Pro Max → style **Data-Dense Dashboard**, anti-pattern to avoid: _no filtering_.

## Goal

Merchant opens one page and answers, in under 10 seconds:

1. **Who used which discount, and how many times?**
2. **Who has hit (or is about to hit) their per-customer limit?**
3. **Which orders count toward that number?** (drill-down, with links to Shopify admin)

## Constraints

- Embedded admin app → **Polaris web components only** (`s-*`). UI/UX Pro Max's palette/fonts
  (Fira, blue/amber) are *not* applied: Polaris owns colors/typography inside the admin, and
  overriding them would look foreign. We take the *structure* rules (KPI row, dense table,
  filters first, status not by color alone) and map them onto Polaris tones.
- Source of truth = `DiscountRedemption` ledger (same counts the Function enforces).
  Names/emails/order names come from Admin GraphQL `nodes(ids:)` (validated, scopes
  `read_customers`, `read_orders` — both granted).
- `read_orders` without `read_all_orders` → orders older than 60 days may resolve to `null`;
  UI must fall back to the raw ID, never crash.

## Information architecture

```
/app/usage                       ← overview + customer list (review screen)
  ├ KPI row: Total redemptions · Last 30 days · Customers · At limit
  ├ Status tabs: All | At limit | 1 left | Repeat (>1) | Unlimited
  ├ Filters slot: Discount select · Search name/email · Sort (uses | last used)
  ├ Table (s-table paginate): Customer | Usage (badge "2 / 3 · 1 left" + s-progress) | Per discount | Last used | →
  ├ Aside: By discount (uses, customers, # at limit, link to discount)
  └ Export CSV (current filter)
/app/usage/:customerId           ← drill-down (bookmarkable, back button)
  ├ Header: name, email, total orders, "Open in Shopify admin"
  ├ Per-discount cards: uses / limit with s-progress + tone
  └ Orders table: Order (link) | Date | Discount | Total | Discounts | Cancelled badge
/app/usage.csv                   ← resource route, same filters → text/csv
```

"Easy to review" decisions:
- **Status tabs instead of manual scanning** — "At limit" and "1 left" are the two questions
  merchants actually ask; one click each.
- **Status never by color only** — every tone badge carries text (`At limit`, `1 left`, `2 / 5`).
- **Drill-down is its own page**, not an inline panel that pushes the list down.
- **Default sort = most uses**, so heavy users surface first.
- **Empty states explain why** (no redemptions yet vs. filter matched nothing).

## Phases

### Phase 1 — Data layer (backend) · depends on: nothing
| # | Task | File |
|---|------|------|
| 1.1 | Extract aggregation into `app/lib/usage-report.server.js`: `buildUsageReport({shop, campaign, status, sort})` returns `{stats, rows, campaignSummary}`; status computed per row: `at_limit` / `near_limit` / `ok` / `unlimited` | new |
| 1.2 | Customer search via `customers(query:)` → ID set filter (validated) | same |
| 1.3 | `lookupNodes` batching (250) + null-safe fallbacks | same |
| 1.4 | `getCustomerUsage({shop, customerId})` for drill-down | same |

✅ Checkpoint: unit-run the aggregation against Supabase dev data (`node -e`), compare counts with `SELECT customerId, campaignKey, count(*) FROM "DiscountRedemption" GROUP BY 1,2`.

### Phase 2 — Overview page · depends on: 1.1–1.3
| # | Task | File |
|---|------|------|
| 2.1 | Rewrite `app/routes/app.usage.jsx` using the lib; KPI row with `s-grid` | existing draft |
| 2.2 | Status tabs (`s-button-group` / `s-choice-list` per Polaris docs) bound to `?status=` | |
| 2.3 | Move filters into `s-table` `filters` slot; native `<form>` submit for search (no `onKeyDown` — not a valid prop, caught by validator) | |
| 2.4 | Use `s-table paginate hasNextPage hasPreviousPage` + `nextpage`/`previouspage` events instead of hand-rolled buttons | |
| 2.5 | Usage cell: tone badge with text + `s-progress` (when limit set) | |
| 2.6 | Row → link to `/app/usage/:id` | |

### Phase 3 — Drill-down page · depends on: 1.4
| # | Task | File |
|---|------|------|
| 3.1 | `app/routes/app.usage.$customerId.jsx` | new |
| 3.2 | Admin deep links: `shopify://admin/customers/<id>`, `shopify://admin/orders/<id>` | |

### Phase 4 — CSV export · depends on: 1.1 (parallel with 2/3)
| 4.1 | `app/routes/app.usage[.]csv.jsx` loader → `text/csv`, same params, all pages | new |

### Phase 5 — Wiring & quality gates · depends on: 2–4
| # | Gate | Tool |
|---|------|------|
| 5.1 | Nav link "Customer usage" in `app/routes/app.jsx` | (done in draft) |
| 5.2 | GraphQL validation | `shopify-admin/scripts/validate.mjs` |
| 5.3 | Polaris component validation | `shopify-polaris-app-home/scripts/validate.mjs` |
| 5.4 | `eslint` + `npm run build` | |
| 5.5 | UI/UX Pro Max pre-delivery checklist: labels on inputs, keyboard order, status not color-only, list layout on narrow width (s-table auto) | manual |
| 5.6 | Smoke in `shopify app dev`: empty shop, shop with data, customer with null order lookups | manual |

## Risks

| Risk | Mitigation |
|------|------------|
| `groupBy` over whole ledger grows with shop size | Fine to ~100k rows; add `@@index([shop, customerId])` if needed later |
| Search returns >250 customers | Cap documented in UI ("showing first 250 matches") |
| Old orders not readable (60-day window) | Fallback label `Order #<id>`, still linked |
| Automatic discounts not in reconcile | Already a known ledger limitation; noted in aside copy |

## Out of scope
Charts/trend graph (KPI "last 30 days" covers it for v1), bulk actions, editing limits from this page.

## Next step
`/sc:implement claudedocs/workflow_customer_usage.md`
