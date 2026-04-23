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
                                       ┌─────────────────────────────────┐
                                       │ Shopify admin iframe            │
                                       │  https://admin.shopify.com/...  │
                                       │  /apps/<app-handle>             │
                                       └─────────────┬───────────────────┘
                                                     │ loads iframe src:
                                                     │ <appUrl>/app?embedded=1
                                                     │   &id_token=<JWT>
                                                     │   &host=<b64>&shop=…
                                                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Fly.io machine — combined-discount-shopify.fly.dev (Node 20)              │
│                                                                           │
│   ┌───────────────────────────────────────────────────────────────────┐   │
│   │  React Router 7 + @shopify/shopify-app-react-router v1.2         │   │
│   │                                                                   │   │
│   │  Request flow                                                     │   │
│   │  ─────────────                                                    │   │
│   │  1. GET /?shop=X         → 302 to /app?shop=X                     │   │
│   │  2. GET /app?id_token=X  → authenticate.admin(request)            │   │
│   │       ├── token valid → token-exchange → session row (Neon)       │   │
│   │       │   returns 200 HTML (embedded app)                         │   │
│   │       └── token invalid / no session →                            │   │
│   │            302 to /auth/session-token?shopify-reload=/app         │   │
│   │  3. GET /auth/session-token → 200 App Bridge HTML                 │   │
│   │       App Bridge reads shopify-reload, fetches fresh id_token     │   │
│   │       from Shopify admin, reloads iframe → step 2                 │   │
│   │                                                                   │   │
│   │  Routes: /app._index, /app.combined-discount, /app.discounts, …   │   │
│   │  Polaris web components (no import — global <s-…> tags)           │   │
│   └────────────┬──────────────────────────────────┬───────────────────┘   │
└────────────────┼──────────────────────────────────┼───────────────────────┘
                 │                                  │
                 │ PrismaSessionStorage             │ admin GraphQL mutations
                 │ CRUD on Session row              │ (with session.accessToken)
                 ▼                                  ▼
     ┌───────────────────────┐       ┌─────────────────────────────────────┐
     │  Neon Postgres        │       │  Shopify admin API                  │
     │  ep-*.aws.neon.tech   │       │  discountCodeApp{Create,Update}     │
     │  Session table        │       │  discountAutomaticApp{Create,…}     │
     └───────────────────────┘       │  discountCodeDelete, nodes(ids:)    │
                                     └─────────────────┬───────────────────┘
                                                       │ writes discount node +
                                                       │ $app/function-configuration
                                                       │ metafield
                                                       ▼
                                     ┌─────────────────────────────────────┐
                                     │  Shopify checkout                   │
                                     │  Invokes Shopify Function (wasm)    │
                                     │  hosted by Shopify itself — NOT Fly │
                                     │                                     │
                                     │  extensions/combined-discount       │
                                     │  Rust → wasm32-unknown-unknown      │
                                     │  Two targets (cart.lines + delivery)│
                                     │  Reads metafield.jsonValue +        │
                                     │  cart.attribute(key:"utm_campaign") │
                                     │  Emits orderDiscountsAdd /          │
                                     │  productDiscountsAdd /              │
                                     │  deliveryDiscountsAdd               │
                                     └─────────────────────────────────────┘
                                                       ▲
                                                       │ cart.attributes.utm_campaign
                                                       │
                                     ┌─────────────────┴───────────────────┐
                                     │  Customer storefront                │
                                     │  theme.liquid <script> snippet:     │
                                     │    URL ?utm_campaign=X              │
                                     │      → localStorage (30 min TTL)    │
                                     │      → POST /cart/update.js         │
                                     │        { attributes: { utm_…: X }}  │
                                     └─────────────────────────────────────┘
```

### Four moving parts

1. **Shopify Function** (`extensions/combined-discount/`) — pure Rust compiled to `wasm32-unknown-unknown`. **Hosted and executed by Shopify at checkout**, not on your Fly machine. Reads the discount's JSON metafield, the cart's `utm_campaign` attribute, and returns operations for the checkout.
2. **Admin UI** (`app/routes/app.*.jsx`) — embedded admin React Router app, hosted on Fly.io. Create, list, view, edit, delete combined discounts. Calls Shopify admin GraphQL mutations to persist both the discount and its metafield in one round-trip.
3. **Session storage** (Neon Postgres) — `PrismaSessionStorage` writes one row per installed shop after the token-exchange flow completes. Without this row, every `authenticate.admin()` call fails and the admin iframe shows a blank screen.
4. **Storefront snippet** — ~30 lines of JavaScript you paste into `theme.liquid`. Captures UTM query params, persists them to `localStorage` (30-minute TTL), and writes them to the cart's attributes. The function reads `cart.attributes.utm_campaign` to gate on campaigns.

### Authentication flow (embedded admin)

This app uses **token exchange** auth (via `@shopify/shopify-app-react-router` v1.2). Understanding this flow matters because the **most common deployment bug — a blank admin iframe — is always a broken token-exchange cycle** (see [Troubleshooting → blank iframe / infinite redirect](#embedded-admin-shows-blank-iframe--infinite-redirect-loop)).

1. Shopify admin iframe loads `https://<appUrl>/app?embedded=1&id_token=<JWT>&host=<base64>&shop=<shop>.myshopify.com&…`
2. The `/app` loader calls `authenticate.admin(request)`, which:
   - Extracts `id_token` from query string
   - Validates the JWT's signature using `apiSecretKey` and checks `aud` against `apiKey`
   - If the `id_token` is missing or invalid → throws a 302 to `/auth/session-token?shopify-reload=<original-url-minus-id_token>`
   - If valid but no live session exists in Neon → performs **token exchange** with Shopify's OAuth endpoint to get an offline access token, stores it as a new Session row, then returns the app context
3. `/auth/session-token` returns a minimal HTML page containing the App Bridge script. App Bridge reads the `shopify-reload` URL, requests a fresh `id_token` from the parent Shopify admin, and reloads the iframe to the `shopify-reload` URL with that new token → back to step 2 (this time valid).

The critical invariant: **`apiKey` in `shopifyApp()` must exactly match the `aud` claim in the `id_token`**. If it doesn't (even a trailing space / newline in the env var), every token validation fails and steps 2 ↔ 3 loop forever.

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

Deploying this app to production is a **two-track** process:

1. **Shopify side** — push the Function extension + app config to Shopify via `shopify app deploy`
2. **Host side** — deploy the embedded admin (React Router) to an HTTPS host. This README covers **Fly.io** (compute) + **Neon** (Postgres) as the recommended stack, because:
   - Fly.io runs the Docker image + `release_command` handles Prisma migrations automatically
   - Neon's free tier (0.5 GB Postgres, auto-pauses) covers session storage without paying for a dedicated DB VM
   - Combined monthly cost is ~$1–3 for low-traffic admin apps

### Recommended stack

```
┌────────────────────────┐       ┌──────────────────────────┐
│  Shopify merchant      │ https │  Fly.io machine          │
│  admin → embedded app  ├──────►│  Node 20 + React Router  │
└────────────────────────┘       │  prisma client           │
                                 └──────────┬───────────────┘
                                            │ DATABASE_URL
                                            ▼
                                 ┌──────────────────────────┐
                                 │  Neon (Postgres)         │
                                 │  Session table only      │
                                 └──────────────────────────┘
```

The Function itself doesn't run on Fly — Shopify hosts and executes the compiled wasm. Fly only hosts the admin web server.

### 1. Set up Neon (Postgres)

1. Sign up at [neon.tech](https://neon.tech).
2. Create a project, e.g. `combined-discount-shopify`:
   - Postgres version: **17** (default)
   - Region: pick the one nearest to your Fly region (e.g. AWS `ap-southeast-1 Singapore` to match Fly's `sin`)
3. From the project's **Connect** dialog, copy the **Prisma** connection string. It looks like:
   ```
   postgresql://<user>:<password>@ep-xxx-yyy.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```
   - `?sslmode=require` is mandatory — Neon only accepts TLS connections.
4. Keep this string handy; you'll set it as `DATABASE_URL` on Fly.

> **Do I need `npx neonctl init`?** Only if you want to run the app locally against Neon. For deploy-to-Fly, skip the CLI — all you need is the connection string.

### 2. Switch Prisma to Postgres

`prisma/schema.prisma` has already been configured for production Postgres:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

A Postgres-compatible baseline migration lives in `prisma/migrations/20260422000000_init/`. `prisma/migrations/migration_lock.toml` pins the provider:

```toml
provider = "postgresql"
```

If you re-run `prisma migrate dev` against a fresh local DB you may need to delete the existing migration folder and regenerate — but for production the baseline is already correct.

### 3. Dockerfile

A `Dockerfile` at the repo root builds a production image:

```dockerfile
FROM node:20-alpine
RUN apk add --no-cache openssl
EXPOSE 3000
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force
RUN npx prisma generate
COPY . .
RUN npm run build
CMD ["npm", "run", "docker-start"]
```

- `openssl` is required by Prisma's query engine.
- `prisma generate` runs at build time so cold starts skip the client codegen step.
- `npm run docker-start` is the production entrypoint defined in `package.json`.

### 4. `fly.toml`

```toml
app = "combined-discount-shopify"
primary_region = "sin"

[build]

[deploy]
  release_command = "npx prisma migrate deploy"

[env]
  NODE_ENV = "production"
  PORT = "3000"
  SCOPES = "write_products,write_metaobjects,write_metaobject_definitions,write_discounts"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0
  processes = ["app"]

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512
```

- **`app`** must be globally unique across all of Fly.io. If you see `Failed to create app`, rename this to something more specific (e.g. `combined-discount-<yourorg>`). Note: when launching via Fly's GitHub UI flow, Fly may override this field with the repo name — always verify the actual hostname via `flyctl status` after launch.
- **`auto_stop_machines` / `min_machines_running = 0`** stops the VM when idle, so you only pay while the admin is actively loading. Cold start is ~5 s (Node startup + Prisma engine), acceptable for admin-only use.
- **`release_command`** runs before each new release replaces the running machine — `prisma migrate deploy` applies any pending migrations to Neon. No manual migration step is ever needed.
- `SCOPES` is set here (non-sensitive), secrets are set via `flyctl secrets` (sensitive).

### 5. `.dockerignore`

Keep the image slim and prevent secrets from being copied in:

```
.cache
build
node_modules
.git
.gitignore
.env
.env.*
.shopify
extensions/*/target
extensions/*/node_modules
prisma/dev.sqlite
npm-debug.log
.DS_Store
README.md
CHANGELOG.md
```

Critical: `.env` and `.env.*` must be ignored — secrets live on Fly, not in the image.

### 6. Deploy via Fly CLI (recommended)

```bash
# Install CLI
brew install flyctl            # macOS
# curl -L https://fly.io/install.sh | sh  # Linux / WSL

# Authenticate
flyctl auth login              # opens browser

# Launch the app (no deploy yet — we set secrets first)
flyctl launch \
  --no-deploy \
  --copy-config \
  --name combined-discount-shopify \
  --region sin
```

Answer the interactive prompts:

| Prompt                                                 | Answer |
|--------------------------------------------------------|--------|
| Copy existing `fly.toml` configuration?                | **Y**  |
| Tweak settings before proceeding?                      | **N**  |
| Switch to a region that supports Managed Postgres?     | **N**  (we use Neon) |
| Set up a Postgresql database now?                      | **N**  |
| Set up an Upstash Redis database now?                  | **N**  |
| Create `.dockerignore` from `.gitignore`?              | **N**  (we already have one) |

About the `"This organization has no payment method, turning off high availability"` warning: it's not a blocker — HA is orthogonal, and `min_machines_running = 0` doesn't use it anyway. Fly will require a credit card to actually serve traffic, but you can add it later via `flyctl dashboard` → Billing.

### 7. Set secrets

All values that must not land in git or image layers:

```bash
flyctl secrets set \
  SHOPIFY_API_KEY=<client_id from Partners> \
  SHOPIFY_API_SECRET=<client_secret from Partners> \
  DATABASE_URL="postgresql://<user>:<pw>@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require" \
  SHOPIFY_APP_URL="https://combined-discount-shopify.fly.dev"
```

- `SHOPIFY_API_KEY` = client ID (not the app name). **Do not wrap in quotes if copy-pasting from the Shopify Dev Dashboard** — some copy sources append trailing whitespace that breaks JWT audience validation. See [blank iframe troubleshooting](#embedded-admin-shows-blank-iframe--infinite-redirect-loop).
- `SHOPIFY_API_SECRET` = client secret (starts with `shpss_…`).
- `SHOPIFY_APP_URL` starts as a guess — Fly assigns `https://<app-name>.fly.dev` by default. You'll confirm the real URL after the first deploy and update both here and in Shopify Partners.
- Verify secret length immediately after setting:
  ```bash
  flyctl ssh console -a <fly-app> -C \
    'node -e "console.log(process.env.SHOPIFY_API_KEY.length)"'
  ```
  Must return exactly `32`. Anything else = whitespace bug → auth loop.

### 8. Deploy

```bash
flyctl deploy
```

Fly will:

1. Build the Docker image (Node install + `prisma generate` + `npm run build`).
2. Push it to the Fly registry.
3. Run `npx prisma migrate deploy` against Neon (applies the initial `Session` table migration).
4. Roll out a new machine serving port 3000 behind HTTPS.

After success:

```bash
flyctl status                  # should show a running machine
flyctl logs                    # tail logs
curl -I https://combined-discount-shopify.fly.dev/    # should be 200 or 302
```

### 9. Update Shopify app config with the Fly URL

If the URL you set in `SHOPIFY_APP_URL` doesn't match the real Fly hostname, fix it now — otherwise OAuth will reject the callback.

```bash
# If it differs, update:
flyctl secrets set SHOPIFY_APP_URL="https://combined-discount-shopify.fly.dev"
```

Then edit `shopify.app.toml` locally:

```toml
application_url = "https://combined-discount-shopify.fly.dev"

[build]
automatically_update_urls_on_dev = false   # prevent shopify app dev from overwriting production URLs

[auth]
redirect_urls = [
  "https://combined-discount-shopify.fly.dev/auth/callback",
  "https://combined-discount-shopify.fly.dev/auth/shopify/callback",
  "https://combined-discount-shopify.fly.dev/api/auth",
  "https://combined-discount-shopify.fly.dev/api/auth/callback"
]
```

> Shopify has migrated app configuration from the legacy Partners dashboard to the **Dev Dashboard** (`dev.shopify.com/dashboard/<org-id>/apps`). The Partners dashboard now only shows distribution/earnings for App Store–listed apps. App URL + redirect URLs for custom apps are managed via `shopify app deploy` → Dev Dashboard, not manual form editing.

### 10. Deploy the Shopify app extension

With the host live, publish the function + config to Shopify:

```bash
shopify app deploy --force
```

This pushes:

- The compiled wasm function
- Scopes + metafield definitions
- The updated `application_url` and redirect URLs

### 11. Install on your store

Generate an install link from the Partners dashboard (or run `shopify app dev` once against the target store to trigger the install flow). After OAuth completes, navigate to **Apps → Combined Discount** in the Shopify admin. The dashboard should load.

### Alternative: Deploy via Fly's GitHub UI

If you'd rather not use the CLI, `fly.io/launch` → **Launch an App from GitHub** reads the same `fly.toml` + `Dockerfile` and deploys on push. You'll need to:

- Set the env vars / secrets manually in the "New environment variable" section of the launch form
- Uncheck "Managed Postgres" (we use Neon)
- Leave **Working directory** and **Config path** empty (defaults to repo root where `fly.toml` lives)
- Click Deploy — if it fails with `Failed to create app`, the app name is already taken; rename `app = "…"` in `fly.toml`, commit, push, retry

### Post-deploy smoke test

1. **Install the app** on a dev store via the Partners install link.
2. **Open Apps → Combined Discount.** Dashboard loads; function ID appears in `/app/discounts` Debug aside.
3. **Create a discount** (e.g. free shipping + BXGY) at `/app/combined-discount`.
4. **Paste the UTM snippet** into `theme.liquid`, visit `?utm_campaign=summer-sale`, add an item, check `/cart.js` shows the attribute.
5. **Checkout** with the code you created — discount should apply.

### Cost ballpark

| Resource                                 | Cost / month |
|------------------------------------------|--------------|
| Fly.io 512 MB shared-cpu-1x, idle-stop   | $1–3 (pay-per-second) |
| Neon free tier (0.5 GB, auto-pause)      | $0           |
| **Total**                                | **$1–3**     |

Usage-based pricing on Fly means rarely-used admin apps effectively cost pennies. If you hit Neon's free-tier compute limit, upgrade to their $19/mo tier.

### Why not Fly Managed Postgres?

Fly's Managed Postgres starts at ~$38/mo for the smallest HA cluster. For session storage (low IOPS, < 1 MB of data), that's massive overkill. Neon's free tier covers this workload forever.

### Production session storage notes

`@shopify/shopify-app-session-storage-prisma` uses the `Session` table defined in `prisma/schema.prisma`. Any Postgres-compatible DB works — Neon is just the cheapest. If you outgrow it, point `DATABASE_URL` at any other managed Postgres (Supabase, RDS, Cloud SQL, Planetscale+pglite, etc.) and re-run `flyctl deploy` — the `release_command` will migrate the new DB automatically.

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

### Embedded admin shows blank iframe / infinite redirect loop

**Symptom:** The app appears in the store's admin sidebar, you click it, and the right-hand panel stays empty. DevTools Network shows repeated `/app?embedded=1&id_token=… → 302 /auth/session-token → 200 → /app?… → 302 …` with no successful 200 on `/app`.

**Root cause (>90% of cases):** `SHOPIFY_API_KEY` set on the host has **trailing whitespace / newline** and doesn't literally equal the JWT `aud` claim. JWT validation fails silently, `authenticate.admin()` throws a redirect, and the cycle never terminates because the library treats it as "invalid session token" not "show error."

**How to diagnose** — add a custom logger to `app/shopify.server.js` and redeploy:

```js
logger: {
  level: 4,
  log: (severity, message) => {
    console.log(`[shopify-lib sev=${severity}] ${message}`);
  },
},
```

Trigger a page load and tail `flyctl logs` for lines like:

```
[shopify-app/DEBUG] Failed to validate session token: Session token had invalid API key
```

That message is always the signature of this bug — it is *not* saying the env var is missing, it is saying `apiKey !== JWT.aud`.

**How to confirm it is whitespace** — SSH into the machine and compare length:

```bash
flyctl ssh console -a <fly-app> -C \
  'node -e "const k=process.env.SHOPIFY_API_KEY; console.log(k.length, JSON.stringify(k));"'
```

Shopify client IDs are exactly **32 lowercase hex characters**. Any other length is the bug.

**Fix** — re-set the secret without quotes or copy-pasted whitespace:

```bash
flyctl secrets set SHOPIFY_API_KEY=<32-char-client-id> -a <fly-app>
```

Note: no `"` wrapping in the shell, and pipe the value from your clipboard carefully — some copy sources (Shopify dashboard "Copy" button, Notion, Slack) append a trailing newline.

**Verify session row now writes after reload:**

```bash
flyctl ssh console -a <fly-app> -C \
  'node -e "const{PrismaClient}=require(\"@prisma/client\"); new PrismaClient().session.count().then(c=>{console.log(\"sessions:\",c); process.exit(0)})"'
```

After a successful reload this should return 1+, and the iframe renders the dashboard.

Remove the debug `logger` config once confirmed — it logs every JWT to stdout, which is noisy for production.

### Fly: `Failed to create app. Please try again.`

The `app = "…"` name in `fly.toml` is globally taken. Rename to something more specific (e.g. `combined-discount-<yourorg>`), commit + push, retry.

### Browser: `<host>.fly.dev's server IP address could not be found`

Your local DNS (router / Chrome / macOS) cached the `NXDOMAIN` response from before the Fly app was created. The domain resolves fine from public resolvers but your system keeps the negative cache.

Verify whether public DNS can resolve it:

```bash
dig @8.8.8.8 +short <fly-app>.fly.dev   # should return a Fly IP
host <fly-app>.fly.dev                  # may still return NXDOMAIN if cached
```

Fix:

1. **macOS**: flush DNS cache
   ```bash
   sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder
   ```
2. **Chrome**: visit `chrome://net-internals/#dns` → **Clear host cache**
3. **If still failing**: add `8.8.8.8`, `8.8.4.4`, `1.1.1.1` to your macOS DNS servers (System Settings → Network → Wi-Fi → Details → DNS → `+`). Your router's DNS cache is TTL-bound and will catch up eventually, but this gets you unblocked immediately.

Other computers reaching the app are unaffected — this is purely local cache.

### Fly: `flyctl launch` prompts "switch region for Managed Postgres?"

Answer **N**. We use Neon (external), not Fly Managed Postgres — the region doesn't need to support it.

### Fly: `This organization has no payment method, turning off high availability`

Not a blocker. HA is orthogonal to our setup (`min_machines_running = 0` doesn't use HA). Add a credit card via `flyctl dashboard` → Billing when Fly actually demands it.

### Neon: `Error: P1001: Can't reach database server`

- **Missing `?sslmode=require`**: Neon only accepts TLS. Append it to `DATABASE_URL`.
- **Compute paused**: Neon auto-pauses on inactivity, first connect takes ~1 s. Retry.
- **Wrong region**: not a connection issue but hurts latency. Put Neon in the same region as Fly (e.g. both `ap-southeast-1`).

### Fly deploy: `Error: P3009 migrate found failed migrations`

A previous migration run failed mid-flight. Mark it as rolled back:

```bash
flyctl ssh console -C "npx prisma migrate resolve --rolled-back <migration-name>"
flyctl deploy
```

### OAuth: `redirect_uri is not whitelisted`

`SHOPIFY_APP_URL` on Fly, `application_url` in `shopify.app.toml`, and the redirect URLs in Partners must all agree. Run `shopify app deploy --force` after updating `shopify.app.toml`.

### Embedded admin shows white screen / infinite redirect

Usually means the session DB isn't reachable or the app URL is stale:

```bash
flyctl logs                          # look for Prisma errors or OAuth loops
flyctl secrets list                  # verify DATABASE_URL + SHOPIFY_APP_URL
flyctl ssh console -C "npx prisma migrate status"  # should say "up to date"
```

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
