# Combined Discount — Shopify App

A Shopify app that lets merchants build **one discount (code or automatic) that bundles up to four reward types** in a single rule:

- **Amount off order** — fixed amount or percentage off the order subtotal
- **Amount off products** — fixed amount or percentage off eligible cart lines
- **Buy X get Y** — trigger condition on "Buy products", reward on "Get products"
- **Free shipping** — 100% off every shipping option

Plus cross-cutting controls:

- **Start / end dates** (native Shopify schedule)
- **Once per customer** limit (for code discounts only)
- **Eligible products / variants** via Shopify resource pickers (applied per discount type)
- **UTM campaign gate** — only apply when the cart carries a matching `utm_campaign` attribute
- **Method** — pick **Code** (customer enters a code) or **Automatic** (applies on cart without input)

Everything is driven by a single Shopify Function (Rust) plus an embedded admin built with React Router 7 and Polaris web components.

---

## Table of contents

1. [Architecture](#architecture)
2. [Feature walkthrough](#feature-walkthrough)
3. [Metafield configuration schema](#metafield-configuration-schema)
4. [Admin UI map](#admin-ui-map)
5. [Prerequisites](#prerequisites)
6. [Install & first run](#install--first-run)
7. [Development workflow](#development-workflow)
8. [Storefront UTM snippet](#storefront-utm-snippet)
9. [Testing the function locally](#testing-the-function-locally)
10. [Deployment](#deployment)
11. [Troubleshooting](#troubleshooting)
12. [Reference: scopes, mutations, schemas](#reference)

---

## Architecture

```
┌─────────────────────────┐          ┌──────────────────────────┐
│  Merchant (admin UI)    │          │  Shopify admin           │
│  React Router 7 routes  │ mutation │  discountCode/Automatic  │
│  @ /app/…               ├─────────►│  AppCreate / AppUpdate   │
│  Polaris web components │          │                          │
└──────────┬──────────────┘          └───────────┬──────────────┘
           │                                     │
           │                                     │  functionId + metafield
           │                                     ▼
           │                          ┌──────────────────────────┐
           │                          │  Shopify Function        │
           │                          │  combined-discount (Rust)│
           │                          │  two targets             │
           │                          └───────────┬──────────────┘
           │                                      │
           ▼                                      ▼
┌─────────────────────────┐          ┌──────────────────────────┐
│  Customer storefront    │ cart     │  Checkout                │
│  theme.liquid snippet   │ attrs    │  applies operations      │
│  captures utm_campaign  ├─────────►│  from function output    │
└─────────────────────────┘          └──────────────────────────┘
```

### Three moving parts

1. **Shopify Function** (`extensions/combined-discount/`) — pure Rust compiled to `wasm32-unknown-unknown`. Reads the discount's JSON metafield, the cart's `utm_campaign` attribute, and returns operations for the checkout.
2. **Admin UI** (`app/routes/app.*.jsx`) — embedded admin app. Create, list, view, edit, delete combined discounts. Calls Shopify admin GraphQL mutations to persist both the discount and its metafield in one round-trip.
3. **Storefront snippet** — ~30 lines of JavaScript you paste into `theme.liquid`. Captures UTM query params, persists them to `localStorage` (30-minute TTL), and writes them to the cart's attributes. The function reads `cart.attributes.utm_campaign` to gate on campaigns.

### Why two function targets

The Shopify Discount Function API exposes two entry points:

| Target                                             | Fires for classes | What we return |
|----------------------------------------------------|-------------------|----------------|
| `cart.lines.discounts.generate.run`                | `ORDER`, `PRODUCT` | `orderDiscountsAdd`, `productDiscountsAdd` |
| `cart.delivery-options.discounts.generate.run`     | `SHIPPING`        | `deliveryDiscountsAdd` |

Shopify only invokes each target when the discount's `discountClasses` array contains a matching class. The admin UI computes this array from which checkboxes the merchant enabled and sends it alongside the mutation.

---

## Feature walkthrough

### 1. Amount off order

- **Config**: `{ value: number, isPercentage: boolean }`
- **Type selector**: Fixed amount (shop currency) or Percentage (0–100, clamped)
- **Discount class**: `ORDER`
- **Function output**: `orderDiscountsAdd` targeting `orderSubtotal`, using `FixedAmount` or `Percentage`
- **Fires when**: `ORDER` class is on the discount AND cart has at least 1 line

### 2. Amount off products

- **Config**: `{ value, isPercentage, eligibleProductIds[], eligibleVariantIds[] }`
- **Type selector**: Fixed amount or Percentage (0–100, clamped)
- **Eligibility**: If both ID lists are empty → applies to all lines. Otherwise a line qualifies if its variant or product ID appears in either list.
- **Discount class**: `PRODUCT`
- **Function output**: one `productDiscountsAdd` operation with a `CartLine` target per qualifying line. Fixed amount mode sets `appliesToEachItem: true`.
- **Fires when**: `PRODUCT` class is on the discount AND at least one cart line matches eligibility

### 3. Buy X get Y

- **Config**: `{ buyQuantity, discountPercentage, getQuantity?, buyProductIds[], buyVariantIds[], getProductIds[], getVariantIds[] }`
- **Semantics**: *"To qualify, the cart must contain at least `buyQuantity` total units matching the Buy-eligibility. When that condition is met, every cart line matching the Get-eligibility receives `discountPercentage`% off."*
- **`getQuantity` is optional**:
  - **omitted / null / ≤ 0** → all matching Get lines get the full-line discount (default)
  - **> 0** → legacy cap: only the cheapest `getQuantity` units get discounted, cheapest-first walk across eligible lines
- **Discount class**: `PRODUCT`
- **Function output**: one `productDiscountsAdd` operation, targets per qualifying line, `Percentage` value, message like `BUY 2 GET ALL AT 100% OFF` or `BUY 2 GET 1 AT 100% OFF` when capped.

### 4. Free shipping

- **Config**: `freeShipping: true`
- **Discount class**: `SHIPPING`
- **Function output**: one `deliveryDiscountsAdd` operation targeting every `deliveryOption` across all `deliveryGroups`, `Percentage 100%`, `selectionStrategy: ALL`
- **Fires when**: `SHIPPING` class is on the discount AND the cart has at least one delivery option

### 5. UTM campaign gate

- **Config**: `requiredUtmCampaign: string`
- **Behavior**: Before emitting any operation on either target, the function reads `cart.attributes["utm_campaign"]` (aliased in the GraphQL input as `utmAttribute`). If the configured value is non-empty and the cart's attribute doesn't match, the function returns empty operations — nothing discounts.
- **Attribute source**: the storefront snippet (see below) writes it from the URL's `?utm_campaign=…` to `cart.attributes`.
- **Rule**: `required` empty → gate is off (no restriction). `required` set → cart attribute must equal the required value exactly.

### 6. Start / end dates

- **Storage**: Native Shopify fields `startsAt` / `endsAt` on the `DiscountCodeApp` / `DiscountAutomaticApp` object — Shopify enforces the schedule, the function doesn't need any date logic.
- **UI**: `<s-date-field>` pickers. End date is stored with `T23:59:59` so the discount is active for the full end-day.

### 7. Once per customer

- **Storage**: Native Shopify field `appliesOncePerCustomer: boolean`. Only exposed for **Code** discounts (Shopify doesn't support per-customer limits on automatic discounts).

### 8. Method — Code vs Automatic

| Method    | Mutation                                            | Has `code` | Has `appliesOncePerCustomer` | Customer experience |
|-----------|-----------------------------------------------------|------------|------------------------------|---------------------|
| Code      | `discountCodeAppCreate` / `discountCodeAppUpdate`   | yes        | yes                          | Customer types a code at checkout |
| Automatic | `discountAutomaticAppCreate` / `discountAutomaticAppUpdate` | no        | no                           | Applies without input when the cart matches |

The **Method** can't be changed after creation — Shopify doesn't support converting between types. The edit form disables the select and shows a hint telling the merchant to delete and recreate if they want to switch.

### 9. Method/Eligibility interactions

- A discount must enable **at least one** reward type for the action to succeed.
- `discountClasses` is derived server-side: ORDER if `orderAmountOff` is set, PRODUCT if `productAmountOff` or `buyXGetY` is set, SHIPPING if `freeShipping: true`. If two reward types share a class (e.g. product-off + BXGY both use PRODUCT), the class appears once.
- `combinesWith` is always `{ order: false, product: false, shipping: false }` — the combined discount is self-contained and doesn't stack with other codes. Change in the code if you want different behavior.

---

## Metafield configuration schema

The full configuration is stored as a JSON metafield at `namespace = "$app"`, `key = "function-configuration"` on the discount node. The Rust `Configuration` struct deserializes this directly.

```jsonc
{
  // All keys are optional. Absent = that reward type is disabled.

  "orderAmountOff": {
    "value": 100000,          // shop currency units for fixed, or 0–100 for percentage
    "isPercentage": false     // default false = fixed amount
  },

  "productAmountOff": {
    "value": 20,
    "isPercentage": true,
    "eligibleProductIds": ["gid://shopify/Product/123"],
    "eligibleVariantIds": ["gid://shopify/ProductVariant/456"]
  },

  "buyXGetY": {
    "buyQuantity": 1,
    "discountPercentage": 100,
    "getQuantity": null,       // null / omitted = discount every matching Get line (default)
    "buyProductIds": ["gid://shopify/Product/PA"],
    "buyVariantIds": [],
    "getProductIds": ["gid://shopify/Product/PB"],
    "getVariantIds": []
  },

  "freeShipping": true,

  "requiredUtmCampaign": "summer-sale"  // cart.attributes.utm_campaign must equal this
}
```

**Rules**

- Dates and per-customer settings are **not** in the metafield — they live on the discount object itself.
- Percentage values are clamped to `[0, 100]` both in the UI and again on submit (`buildConfigAndClasses`).
- ID lists store full Shopify GIDs (`gid://shopify/Product/…`, `gid://shopify/ProductVariant/…`).

---

## Admin UI map

Navigation (in `app/routes/app.jsx`):

| Link                       | Route                          | Purpose |
|----------------------------|--------------------------------|---------|
| Home                       | `/app`                         | Dashboard — stats + recent discounts + quick actions |
| Discounts list             | `/app/discounts`               | Table of all combined discounts created by this app |
| Create combined discount   | `/app/combined-discount`       | Create form (also reused for edit via `?id=<gid>`) |
| Additional page            | `/app/additional`              | Stock template page (not used for the feature) |

### `/app` — Home dashboard

- **Primary action**: Create combined discount
- **Overview section**: 4 stat cards — Total, Active, Code, Automatic
- **Recent discounts** table (top 5)
- **Aside**: Quick actions + Status breakdown (Active/Scheduled/Expired) + Tips
- **Setup alert** if the function ID can't be resolved (function not deployed yet)

### `/app/discounts` — List

- Query: `discountNodes(first: 100)` → filter to `DiscountCodeApp` / `DiscountAutomaticApp` whose `appDiscountType.functionId` matches this app's combined-discount function
- Columns: Code / Title / Method / Status / Types / Starts / Ends / Actions
- **Actions**: Edit (links to `/app/combined-discount?id=<gid>`), Delete (calls `discountCodeDelete` or `discountAutomaticDelete` based on the node GID)
- Empty state with a primary Create button
- Debug aside showing detected function ID + node counts + any GraphQL errors

### `/app/discounts/:id` — Detail

- Query: `discountNode(id: $id)` plus metafield + resolved product/variant titles via `nodes(ids:)`
- Sections rendered based on which reward types are configured:
  - Status and schedule (badges + dates)
  - Amount off order
  - Amount off products (with eligible product/variant titles)
  - Buy X get Y (two columns: Buy trigger + Get reward, both with titles)
  - Free shipping
  - UTM gate
- Aside: Method details (Code / Automatic), Combines with, Raw metafield JSON
- Primary action: Edit (links to the create form in edit mode)

### `/app/combined-discount` — Create or Edit

- **Create mode**: default state, writes via `discountCodeAppCreate` or `discountAutomaticAppCreate`
- **Edit mode**: triggered by `?id=<encoded-gid>`. Loader fetches the existing discount + metafield + resolved product titles, hydrates every form field (including product pickers rendered with proper titles). Submit calls the `*Update` mutation.
- Sections:
  - **Basics**: Method select, Code (code method only), Title, Start/End date pickers, Once per customer (code only), Required UTM campaign
  - **Amount off order**: enable toggle + type (fixed/percent) + value input
  - **Amount off products**: enable toggle + type/value + eligible products picker
  - **Buy X get Y**: enable toggle + Buy qty + Discount % + Buy products picker + Get products picker
  - **Free shipping**: enable toggle
  - Submit summary: "N of 4 discount types selected" + primary button
- **Aside**: How it works + UTM theme snippet (copy-pasteable) + error/success blocks

### Product picker component

Lives inside `app/routes/app.combined-discount.jsx`. Key points:

- Uses `shopify.resourcePicker({ type: 'product', multiple: true })` from App Bridge. Falls back to `window.shopify.resourcePicker` when the hook version isn't available.
- Stores selection as `[{ id, title, variants: [{ id, title }] }]` so titles render correctly on reopen without a second round-trip.
- When opening the picker in edit mode, passes `selectionIds` so previously picked products are pre-checked.
- On submit, `selectionToIds()` flattens the selection into CSV strings for `productIds` / `variantIds`, which then become JSON arrays in the metafield.
- Loader hydrates edit-mode selections via `fetchProductTitles` + `hydrateSelection`.

---

## Prerequisites

- **Node.js** `>= 20.19 < 22` or `>= 22.12`
- **Rust** with the `wasm32-unknown-unknown` target installed:
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **Shopify CLI** `>= 3.80` (tested on 3.90). Install with `npm i -g @shopify/cli@latest`.
- A **Shopify Partner account** with a development store.

---

## Install & first run

```bash
# 1. Install JS dependencies
npm install

# 2. Install Rust wasm target (one-time)
rustup target add wasm32-unknown-unknown

# 3. Link this folder to your Partner dashboard app
shopify app config link

# 4. Start the dev server (tunnel + function watcher + React Router)
shopify app dev
```

On first run the CLI will:

1. Open a Cloudflare tunnel for the embedded admin.
2. Build the Rust function and push it as a dev preview to the selected store.
3. Install / reinstall the app on the store, requesting the scopes listed in `shopify.app.toml` (`write_products`, `write_metaobjects`, `write_metaobject_definitions`, `write_discounts`).
4. Print a **Preview URL** like `https://<store>.myshopify.com/admin/oauth/redirect_from_cli?client_id=…`. Open that to install.

After install, navigate to **Apps → Combined Discount** in the Shopify admin. The home dashboard should load.

### Access scopes required

Declared in `shopify.app.toml`:

```toml
scopes = "write_products,write_metaobjects,write_metaobject_definitions,write_discounts"
```

`write_discounts` is **mandatory** — without it, even the dev preview upload fails because the function declares a discount extension. If you ever see:

```
[discount]: Requires the following access scope: write_discounts
```

…you've accidentally removed it.

### Discount metafield definition

Also declared in `shopify.app.toml`:

```toml
[discount.metafields.app.function-configuration]
type = "json"
name = "Combined Discount configuration"
description = "Stores amountOff for the combined discount function"

  [discount.metafields.app.function-configuration.access]
  admin = "merchant_read_write"
  storefront = "none"
```

This is what makes `metafield(namespace: "$app", key: "function-configuration")` resolve at both read (function input) and write (admin mutation) time. Without it the function sees `metafield: null` and silently does nothing.

---

## Development workflow

### The happy path

1. `shopify app dev` (keep it running)
2. Edit source files — the CLI hot-reloads:
   - `extensions/combined-discount/src/*.rs` / `*.graphql` → rebuilds wasm + pushes new dev preview
   - `app/routes/*.jsx` → React Router HMR
3. Refresh the embedded admin to see changes

### Key files

```
extensions/combined-discount/
├── Cargo.toml                # shopify_function = "2.1.0"
├── shopify.extension.toml    # targets + build + watch + metafield declaration
├── schema.graphql            # generated by `shopify app function schema`
└── src/
    ├── main.rs                                          # typegen root + module imports
    ├── cart_lines_discounts_generate_run.graphql        # input query for cart-lines target
    ├── cart_lines_discounts_generate_run.rs             # Configuration struct + order/product/BXGY logic
    ├── cart_delivery_options_discounts_generate_run.graphql  # input query for delivery target
    └── cart_delivery_options_discounts_generate_run.rs  # free-shipping logic, imports Configuration

app/
├── shopify.server.js            # App Bridge config, session storage (Prisma + SQLite)
└── routes/
    ├── app.jsx                  # Embedded layout + nav
    ├── app._index.jsx           # Home dashboard
    ├── app.combined-discount.jsx  # Create/edit form (single route, ?id for edit)
    ├── app.discounts.jsx        # List + delete
    ├── app.discounts.$id.jsx    # Detail
    └── app.additional.jsx       # Template leftover, can be removed

shopify.app.toml                  # Scopes, metafield definitions, webhooks, auth
```

### After pulling changes or editing the function

```bash
# From the extension dir
cd extensions/combined-discount
cargo build --target=wasm32-unknown-unknown --release
# or let `shopify app dev` do it for you on save
```

If the generated Rust types get out of date vs the `.graphql` files, regenerate them:

```bash
cd extensions/combined-discount
shopify app function schema       # regenerates schema.graphql from Shopify
shopify app function typegen      # regenerates Rust typegen if needed
```

### `shopify.extension.toml` watch list

```toml
[extensions.build]
command = "cargo build --target=wasm32-unknown-unknown --release"
path = "target/wasm32-unknown-unknown/release/combined_discount.wasm"
watch = ["src/**/*.rs", "src/**/*.graphql"]
```

The `watch` list is **critical**: without it the default watcher also watches `target/`, and `wasm-opt` rewriting the output wasm triggers a rebuild loop (`❌ Wasm file is not present` spam, never reaches Ready).

---

## Storefront UTM snippet

Paste this inside your theme's `theme.liquid`, just before `</body>`. The admin page also shows it in the aside of the Create form for convenient copy-paste.

```html
<script>
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

  // 4. Re-apply after cart mutations (AJAX add-to-cart, change, etc.)
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var promise = origFetch(input, init);
      if (/\/cart\/(add|change|update|clear)(\.js)?/.test(url)) {
        promise.then(function () { setTimeout(pushToCart, 50); });
      }
      return promise;
    };
  }
})();
</script>
```

**What it does**

1. Captures `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` from the URL on any page load.
2. Persists them to `localStorage` with a 30-minute TTL — only the session window is covered, expired entries auto-delete on read.
3. On every page load (within TTL) writes them to `cart.attributes` via `/cart/update.js`.
4. Intercepts `window.fetch` for `/cart/(add|change|update|clear)` endpoints and re-applies after the cart mutation completes, so AJAX add-to-cart doesn't wipe the attributes.

Only `utm_campaign` is used by the function today — the other fields are stored alongside for reporting or future gate conditions.

**Testing**

```
# Step 1: visit with the query string
https://<store>.myshopify.com/?utm_campaign=summer-sale

# Step 2: check the cart
https://<store>.myshopify.com/cart.js
# should show attributes: { utm_campaign: "summer-sale", ... }

# Step 3: apply a discount that has requiredUtmCampaign = "summer-sale"
# it should now fire. If attribute is missing or different, the function returns empty operations.
```

---

## Testing the function locally

### With `shopify app function run`

```bash
cd extensions/combined-discount
cargo build --target=wasm32-unknown-unknown --release
shopify app function run \
  --input=src/cart_lines_discounts_generate_run.input.json \
  --export=cart_lines_discounts_generate_run
```

Sample input files are in `src/*.input.json`.

### Trampoline (when the CLI errors with `shopify_function_v2::…`)

`shopify_function` 2.x produces a newer wasm ABI that the CLI's bundled `function-runner-9.1.2` doesn't understand directly. Use `shopify-function-trampoline` to translate:

```bash
TR=$(npm root -g)/@shopify/cli/bin/shopify-function-trampoline-2.0.1
FR=$(npm root -g)/@shopify/cli/bin/function-runner-9.1.2
WASM=target/wasm32-unknown-unknown/release/combined_discount.wasm
OUT=/tmp/combined_discount_trampolined.wasm

"$TR" -i "$WASM" -o "$OUT"
"$FR" -f "$OUT" \
  --input src/cart_lines_discounts_generate_run.input.json \
  --export cart_lines_discounts_generate_run
```

Both paths exist inside the globally-installed `@shopify/cli` package. The trampoline output runs identically to how Shopify's own runner executes the function at checkout.

### Typical test matrix (all should pass)

| Scenario                                                   | Target          | Expected |
|------------------------------------------------------------|-----------------|----------|
| All four reward types enabled, all classes present         | cart-lines      | 3 ops (order + product + bxgy) |
| All four enabled                                           | delivery        | 1 op (free shipping 100%) |
| Only `orderAmountOff`, class=`[ORDER]`                     | cart-lines      | 1 order op |
| `productAmountOff` percentage 20%                          | cart-lines      | 1 product op with `percentage: 20.0` |
| BXGY trigger not met (not enough buy units)                | cart-lines      | empty |
| BXGY trigger met, get products present                     | cart-lines      | 1 product op targeting every matching Get line |
| Config has `requiredUtmCampaign` but cart attr missing     | either          | empty |
| Config has `requiredUtmCampaign`, cart attr matches        | either          | normal operations |
| Eligibility restricts productAmountOff to one variant      | cart-lines      | 1 product op targeting only that line |

---

## Deployment

```bash
shopify app deploy
```

This pushes:

- A new app version registering the function
- The declared metafields + scopes
- Any active `shopify.app.toml` config (URLs, webhooks)

Install or upgrade the app on a production store. The embedded admin is served from whatever host you deploy the React Router app to — see the [Shopify launch docs](https://shopify.dev/docs/apps/launch/deployment) for Fly.io / Google Cloud Run / Render / manual hosting.

### Production session storage

This template uses Prisma + SQLite (`prisma/schema.prisma`) for the CLI-session table. For multi-instance production, swap the datasource to MySQL / PostgreSQL. See `@shopify/shopify-app-session-storage-prisma` for alternatives.

---

## Troubleshooting

### "SAVE100K isn't working right now" at checkout

Shopify's generic "doesn't work" message. Causes we've hit:

- **Function panicked** — check `shopify app logs`. Common trigger: missing `input_query` in `shopify.extension.toml`, which makes Shopify send `{}` as input and the Rust deserializer panics with `InvalidType`. Make sure each `[[extensions.targeting]]` block has `input_query = "src/…"`.
- **Metafield read returns null** — the discount was created without the config metafield, or under the wrong namespace. The function `discount.metafield(namespace: "$app", key: "function-configuration")` expects exactly that shape, declared in `shopify.app.toml`.
- **`discountClasses` doesn't include what you need** — the UI computes this from which reward toggles are enabled. A discount saved with only `[SHIPPING]` won't invoke the cart-lines target at all (so you'll see free shipping only).

### `shopify app dev` stuck in a loop (`❌ Wasm file is not present`)

Default watcher is watching `target/`. Add:

```toml
[extensions.build]
watch = ["src/**/*.rs", "src/**/*.graphql"]
```

Kill the process and restart.

### `AbortError: The user aborted a request` during dev preview

Transient tunnel / network flake. Restart:

```bash
shopify app dev --reset
```

### `The App Dev GraphQL API responded unsuccessfully with the HTTP status 502`

Shopify platform 5xx. Retry `shopify app dev` — it usually clears in seconds.

### Discounts list is empty but codes exist in the admin

Check the **Debug** aside on `/app/discounts`:

- **Function ID** unknown → your function isn't registered on this shop yet; run `shopify app dev` or `shopify app deploy` until the extension pushes successfully.
- **App-type discounts in shop: 0** → Shopify returned no `DiscountCodeApp` / `DiscountAutomaticApp` nodes. Either there are none, or your access scope doesn't include `write_discounts`.
- Both > 0 but list still empty → function-ID filter mismatch; the loader loosens the filter automatically when either side is missing.

### `Eligible products — 0 product(s) selected` after opening the picker

The picker opened and you selected, but nothing was saved. Usually caused by:

- `<s-button type="button">` (the `type` attribute isn't recognized on Polaris web components — leave it off)
- Wrapping the buttons in `<s-button-group>` (behaved inconsistently for us — use `<s-stack direction="inline">` instead)

### `AmountOrPercentage` > 100% in the storage

The UI clamps on every keystroke and `buildConfigAndClasses` clamps again on submit — but if you hand-edit the metafield via GraphQL, nothing else enforces it. The function itself accepts any value.

### Unknown import: `shopify_function_v2::shopify_function_output_new_object`

CLI's `function-runner-9.1.2` can't execute the v2 wasm directly. Use the trampoline (see [Testing the function locally](#testing-the-function-locally)).

---

## Reference

### Admin GraphQL mutations used

- `discountCodeAppCreate(codeAppDiscount: DiscountCodeAppInput!)`
- `discountCodeAppUpdate(id: ID!, codeAppDiscount: DiscountCodeAppInput!)`
- `discountAutomaticAppCreate(automaticAppDiscount: DiscountAutomaticAppInput!)`
- `discountAutomaticAppUpdate(id: ID!, automaticAppDiscount: DiscountAutomaticAppInput!)`
- `discountCodeDelete(id: ID!)`
- `discountAutomaticDelete(id: ID!)`

### Admin GraphQL queries used

- `shopifyFunctions(first: 50)` — find the function's ID
- `discountNodes(first: 100)` — list
- `discountNode(id: $id)` — detail / edit
- `nodes(ids: [ID!]!)` — resolve product / variant titles

### Function input queries (abbreviated)

`src/cart_lines_discounts_generate_run.graphql`:

```graphql
query Input {
  cart {
    utmAttribute: attribute(key: "utm_campaign") { value }
    lines {
      id
      quantity
      cost {
        subtotalAmount { amount }
        amountPerQuantity { amount }
      }
      merchandise {
        __typename
        ... on ProductVariant {
          id
          product { id }
        }
      }
    }
  }
  discount {
    discountClasses
    metafield(namespace: "$app", key: "function-configuration") { jsonValue }
  }
}
```

`src/cart_delivery_options_discounts_generate_run.graphql`:

```graphql
query Input {
  cart {
    utmAttribute: attribute(key: "utm_campaign") { value }
    deliveryGroups {
      deliveryOptions { handle }
    }
  }
  discount {
    discountClasses
    metafield(namespace: "$app", key: "function-configuration") { jsonValue }
  }
}
```

### Rust `Configuration` struct

From `extensions/combined-discount/src/cart_lines_discounts_generate_run.rs`:

```rust
pub struct Configuration {
    pub product_amount_off: Option<ProductAmountOff>,
    pub buy_x_get_y: Option<BuyXGetY>,
    pub order_amount_off: Option<OrderAmountOff>,
    pub free_shipping: Option<bool>,
    pub required_utm_campaign: Option<String>,
}
```

This struct is also referenced as `Configuration` from the delivery target (`super::cart_lines_discounts_generate_run::Configuration`) so both targets read the same config shape.

### External resources

- [Shopify Functions — Discount API](https://shopify.dev/docs/api/functions/latest/discount)
- [Polaris web components (App Home)](https://shopify.dev/docs/api/app-home/polaris-web-components)
- [App Bridge — Resource Picker](https://shopify.dev/docs/api/app-home/apis/user-interface-and-interactions/resource-picker-api)
- [Shopify CLI reference](https://shopify.dev/docs/apps/tools/cli)
- [`DiscountCodeAppInput`](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/DiscountCodeAppInput)
- [`DiscountAutomaticAppInput`](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/DiscountAutomaticAppInput)
