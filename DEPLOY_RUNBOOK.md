# Shopify App → Fly.io + Neon — Deployment Runbook

A battle-tested, copy-paste runbook for deploying any Shopify embedded app (React Router / Remix template) onto Fly.io with a Neon Postgres session store. Every gotcha we've hit is encoded here with a concrete verification step — follow in order and you won't spend a day debugging auth loops again.

**Target stack:**
- `@shopify/shopify-app-react-router` v1.2+ (or equivalent Remix template)
- Fly.io (compute)
- Neon (Postgres, free tier fine for session storage)
- Prisma (session storage adapter)

**Cost baseline:** ~$1–3 / month per app (Fly pay-per-second + Neon free tier).

---

## 0. Prerequisites

```bash
brew install flyctl                       # or curl -L https://fly.io/install.sh | sh
npm i -g @shopify/cli@latest              # CLI 3.90+
rustup target add wasm32-unknown-unknown  # only if your app has a Shopify Function
```

Accounts needed:
- **Fly.io** — credit card verified (required even for free usage since Oct 2024)
- **Neon** — free tier works (0.5 GB, auto-pauses)
- **Shopify Partners** — and one or more dev stores

Install time once, reuse forever.

---

## 1. Neon: create project + copy connection string

1. [neon.tech](https://neon.tech) → **New project**
2. Postgres version 17, region matching Fly (e.g. AWS `ap-southeast-1 Singapore` for Fly's `sin`).
3. Project dashboard → **Connect** (top-right) → framework **Prisma** → **copy connection string**:
   ```
   postgresql://<user>:<pw>@ep-xxx-yyy.<region>.aws.neon.tech/neondb?sslmode=require
   ```
4. `?sslmode=require` is **mandatory** — Neon rejects non-TLS connections.

You do NOT need `npx neonctl init` for this flow. That's only for local dev against Neon. For deploy, the connection string is all you need.

---

## 2. Switch Prisma to Postgres (once per repo)

### `prisma/schema.prisma`
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

### `prisma/migrations/migration_lock.toml`
```toml
provider = "postgresql"
```

### Regenerate a Postgres-compatible baseline migration

Delete the existing `prisma/migrations/*` folders (they're SQLite-specific), then:

```bash
DATABASE_URL="postgresql://..." npx prisma migrate dev --name init
```

Or hand-write a `migration.sql` with Postgres DDL (e.g. `TIMESTAMP(3)` instead of SQLite `DATETIME`, `BIGINT` instead of `INTEGER`).

---

## 3. `Dockerfile` at repo root

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

- `openssl` — required by Prisma query engine
- `prisma generate` at build time — skips client codegen on cold start
- `docker-start` script must exist in `package.json`:
  ```json
  "scripts": {
    "docker-start": "npm run setup && npm run start",
    "setup": "prisma generate && prisma migrate deploy",
    "start": "react-router-serve ./build/server/index.js"
  }
  ```

---

## 4. `.dockerignore` at repo root

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

`.env*` **must** be in this list — secrets live on Fly, never in image layers.

---

## 5. `fly.toml` at repo root

```toml
app = "<your-globally-unique-name>"     # MUST be unique across ALL of Fly
primary_region = "sin"                  # pick nearest to Neon region

[build]

[deploy]
  release_command = "npx prisma migrate deploy"

[env]
  NODE_ENV = "production"
  PORT = "3000"
  SCOPES = "write_products,..."         # match shopify.app.toml

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

Key choices:
- `auto_stop_machines + min_machines_running = 0` — machine stops when idle. Cold start ~5s, acceptable for admin-only apps.
- `release_command` runs **before** each new release replaces the running machine. `prisma migrate deploy` is idempotent, so this is safe to run every deploy.
- `app` must be **globally unique across all Fly users**. `combined-discount` is taken; `combined-discount-<yourorg>-<yyyy>` is safer.

---

## 6. Launch app on Fly via CLI

Prefer CLI over Fly's GitHub UI launch — CLI gives real error messages and skips the "repo name overrides toml" quirk.

```bash
flyctl auth login                        # opens browser

flyctl launch \
  --no-deploy \
  --copy-config \
  --name <your-app-name> \
  --region sin
```

Answer prompts:

| Prompt | Answer |
|---|---|
| Copy existing `fly.toml` configuration? | **Y** |
| Tweak settings before proceeding? | **N** |
| Switch to a region that supports Managed Postgres? | **N** (we use Neon) |
| Set up a Postgresql database now? | **N** |
| Set up an Upstash Redis database now? | **N** |
| Create `.dockerignore` from `.gitignore`? | **N** (we already have one) |

Ignore warnings:
- `"This organization has no payment method, turning off high availability"` — HA orthogonal to our `min_machines_running = 0`. Add CC later via `flyctl dashboard` → Billing.

On `Failed to create app` → the name is globally taken. Rename `app = …` in `fly.toml` and retry.

---

## 7. Set secrets — **THE MOST ERROR-PRONE STEP**

```bash
flyctl secrets set \
  SHOPIFY_API_KEY=<32-char-client-id> \
  SHOPIFY_API_SECRET=<shpss_...> \
  DATABASE_URL="postgresql://...?sslmode=require" \
  SHOPIFY_APP_URL="https://<your-app-name>.fly.dev" \
  -a <your-app-name>
```

### ⚠️ Whitespace rules (learned the hard way)

- **Do not wrap `SHOPIFY_API_KEY` in quotes.** Quotes make trailing whitespace invisible. JWT `aud` claim is compared via strict equality — a single trailing space breaks every request.
- **Copy-paste source matters.** Shopify Dev Dashboard "Copy" button, Notion, Slack sometimes append newlines. Paste into a plain text editor first, inspect, then paste into terminal.
- **Verify immediately after setting:**
  ```bash
  flyctl ssh console -a <your-app-name> -C \
    'node -e "console.log(process.env.SHOPIFY_API_KEY.length)"'
  ```
  Must be **exactly `32`**. Shopify client IDs are always 32-lowercase-hex.
- Same applies to `SHOPIFY_API_SECRET` (typically 38 chars for `shpss_…` format) — verify length matches what's in the Dev Dashboard.

Where to find each value:
- `SHOPIFY_API_KEY` = Dev Dashboard → your app → **Client ID**
- `SHOPIFY_API_SECRET` = Dev Dashboard → your app → **Client secret** (reveal + copy)
- `DATABASE_URL` = Neon Connect dialog, Prisma framework option
- `SHOPIFY_APP_URL` = `https://<fly-app-name>.fly.dev` (no trailing slash)

---

## 8. Deploy

```bash
flyctl deploy -a <your-app-name>
```

Fly does:
1. Build Docker image (Node install + `prisma generate` + `npm run build`)
2. Push to Fly registry
3. Run `npx prisma migrate deploy` against Neon (release_command) — applies initial `Session` table
4. Roll out a machine on port 3000 behind HTTPS

Verify:

```bash
flyctl status -a <your-app-name>         # machine running, state "started" or "stopped" (auto-stop is fine)
flyctl logs -a <your-app-name>           # tail logs
```

Direct HTTP smoke test (bypassing potential local DNS cache issues):

```bash
DNS_IP=$(dig @8.8.8.8 +short <your-app-name>.fly.dev | head -1)
curl -I --resolve <your-app-name>.fly.dev:443:$DNS_IP \
  https://<your-app-name>.fly.dev/
# expect: HTTP/2 200
```

---

## 9. Update Shopify app config with Fly URL

Edit `shopify.app.toml`:

```toml
application_url = "https://<your-app-name>.fly.dev"

[build]
automatically_update_urls_on_dev = false   # ⚠️ prevents shopify app dev from clobbering prod URLs
include_config_on_deploy = true

[auth]
redirect_urls = [
  "https://<your-app-name>.fly.dev/auth/callback",
  "https://<your-app-name>.fly.dev/auth/shopify/callback",
  "https://<your-app-name>.fly.dev/api/auth",
  "https://<your-app-name>.fly.dev/api/auth/callback"
]
```

`automatically_update_urls_on_dev = false` is critical — without it, next time you run `shopify app dev`, the Cloudflare tunnel URL overwrites your Fly URL in the Dev Dashboard.

---

## 10. Deploy Shopify app config + function

```bash
shopify app deploy --force
```

This pushes to Shopify Dev Dashboard:
- Compiled wasm function (if the app has one)
- Scopes, metafield definitions, webhooks
- Updated `application_url` + `redirect_urls`
- A new app version

Note: Shopify migrated app configuration from the legacy Partners dashboard to the **Dev Dashboard** (`dev.shopify.com/dashboard/<org-id>/apps`). The Partners dashboard now only shows distribution/earnings for App Store–listed apps. Ignore instructions that tell you to edit URLs manually in Partners — they're stale.

---

## 11. Install + smoke test

1. Dev Dashboard → your app → **Install** (or **Test your app**) → pick store
2. Browser goes through OAuth: consent page → callback to `https://<your-app-name>.fly.dev/auth/callback` → redirect to admin
3. In admin store → **Apps → <Your App>** — should render (not blank)

### Verify auth completed successfully

```bash
flyctl ssh console -a <your-app-name> -C \
  'node -e "const{PrismaClient}=require(\"@prisma/client\"); new PrismaClient().session.count().then(c=>{console.log(\"sessions:\",c); process.exit(0)})"'
```

Must return **`sessions: 1`** (or more, one per installed shop). If it returns `0` after opening the admin → auth loop bug (jump to Troubleshooting).

---

## 12. Browser DNS: if you can't open the app yourself

Right after Fly provisions the domain, your laptop may have cached the prior `NXDOMAIN` response. Other people can reach the app; you can't.

```bash
dig @8.8.8.8 +short <your-app-name>.fly.dev   # public DNS: returns IP
host <your-app-name>.fly.dev                  # your DNS: may still NXDOMAIN
```

Fix:

```bash
sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder
```

Then Chrome → `chrome://net-internals/#dns` → **Clear host cache**. If still failing, add `8.8.8.8`, `1.1.1.1` to System Settings → Network → Wi-Fi → Details → DNS.

---

## 🔴 Troubleshooting — the Top 3 bugs

### 🟥 #1: Embedded admin shows blank iframe / infinite redirect loop

**Symptom:** App appears in sidebar, click it, right panel stays empty. Network shows repeated `/app?embedded=1&id_token=… → 302 /auth/session-token → 200` with no 200 on `/app`.

**>90% of cases: whitespace in `SHOPIFY_API_KEY`.** JWT `aud` claim fails strict-equality check, library treats as invalid session, loops forever.

Diagnosis — add temporary verbose logger to `app/shopify.server.js`:

```js
const shopify = shopifyApp({
  // ...
  logger: {
    level: 4,
    log: (severity, message) => console.log(`[shopify sev=${severity}] ${message}`),
  },
  // ...
});
```

Redeploy, reload the admin, then `flyctl logs`. Look for:

```
[shopify-app/DEBUG] Failed to validate session token: Session token had invalid API key
```

That exact message = the whitespace bug. Fix:

```bash
flyctl ssh console -a <your-app-name> -C \
  'node -e "console.log(process.env.SHOPIFY_API_KEY.length)"'
```

If length ≠ 32, re-set WITHOUT quotes:

```bash
flyctl secrets set SHOPIFY_API_KEY=<32-char-client-id> -a <your-app-name>
```

Verify length is 32, reload admin. Remove the temporary `logger` block and redeploy.

### 🟥 #2: `flyctl deploy` fails with Prisma / DB errors

Common causes:
- `DATABASE_URL` missing `?sslmode=require` → Neon rejects TLS-less connection
- Migration folder still SQLite-format → Postgres-incompatible DDL
- Neon compute paused → first connection takes ~1s, retry

```bash
flyctl ssh console -a <your-app-name> -C "npx prisma migrate status"
```

Should say `Database schema is up to date`. If not:

```bash
flyctl ssh console -a <your-app-name> -C \
  "npx prisma migrate resolve --rolled-back <migration-name>"
flyctl deploy -a <your-app-name>
```

### 🟥 #3: `Proxy is having trouble reaching app` warning in Fly dashboard

Usually transient — happens during the 5–8 s window between machine boot and Node process listening on `0.0.0.0:3000`. Test HTTP directly:

```bash
curl -I https://<your-app-name>.fly.dev/
```

If `HTTP 200` → the warning is stale UI, ignore it. If connection refused → check that `react-router-serve` is binding to `0.0.0.0`, not only `localhost`. The default binding from react-router-serve logs as `http://localhost:3000 (http://172.19.x.x:3000)` — the second address IS `0.0.0.0`-equivalent in Fly's network, so this is fine.

---

## Quick copy-paste checklist for next app

```
[ ]  Neon project created, region matches Fly
[ ]  DATABASE_URL copied with ?sslmode=require
[ ]  prisma/schema.prisma uses provider = "postgresql"
[ ]  prisma/migrations/migration_lock.toml provider = "postgresql"
[ ]  Initial migration regenerated with Postgres DDL
[ ]  Dockerfile exists with openssl + prisma generate
[ ]  .dockerignore includes .env*, .shopify, node_modules, extensions/*/target
[ ]  fly.toml with globally-unique app name, release_command, auto-stop
[ ]  flyctl launch --no-deploy completed
[ ]  4 Fly secrets set without quotes: API_KEY, API_SECRET, DATABASE_URL, APP_URL
[ ]  SHOPIFY_API_KEY length verified = 32 via flyctl ssh console
[ ]  flyctl deploy succeeded
[ ]  curl https://<app>.fly.dev/ → 200
[ ]  shopify.app.toml: application_url, redirect_urls, automatically_update_urls_on_dev=false
[ ]  shopify app deploy --force
[ ]  Install on dev store via Dev Dashboard
[ ]  Session count in Neon > 0 after install
[ ]  Admin iframe renders (not blank)
```

If all 16 boxes are checked, the app is live and you didn't waste time on debugging. 🚀

---

# 🔁 End-to-End Validation Loop

Stop hoping. Start verifying. Every step below returns **PASS** or **FAIL** with a specific remediation. Run in order; don't proceed past a FAIL.

**Exports to set once per session** (customize and keep in your shell):

```bash
export FLY_APP="<your-globally-unique-name>"
export SHOP_DOMAIN="<shop-handle>.myshopify.com"          # e.g. prkdg7-jt.myshopify.com
export CLIENT_ID="<32-char-client-id>"                    # from Dev Dashboard
export FLY_URL="https://${FLY_APP}.fly.dev"
```

Every check below uses those env vars. Re-run any check at any time — they're idempotent.

---

## ✅ Gate 1 — Local repo state

### 1.1 Prisma configured for Postgres

```bash
grep -q 'provider = "postgresql"' prisma/schema.prisma && \
  grep -q 'provider = "postgresql"' prisma/migrations/migration_lock.toml && \
  echo "PASS" || echo "FAIL — one of the Prisma files still references sqlite"
```

**Fix on FAIL:** edit both files to `provider = "postgresql"`, regenerate the initial migration (see step 2).

### 1.2 Dockerfile has critical lines

```bash
grep -q "apk add --no-cache openssl" Dockerfile && \
  grep -q "prisma generate" Dockerfile && \
  grep -q 'CMD \["npm", "run", "docker-start"\]' Dockerfile && \
  echo "PASS" || echo "FAIL — Dockerfile missing openssl, prisma generate, or docker-start CMD"
```

### 1.3 `.dockerignore` blocks secrets

```bash
grep -qxE "\.env" .dockerignore && \
  grep -qxE "\.env\.\\*" .dockerignore && \
  grep -qxE "\.shopify" .dockerignore && \
  echo "PASS" || echo "FAIL — .env*, or .shopify not ignored (secrets will leak into image)"
```

### 1.4 `fly.toml` has release command + auto-stop

```bash
grep -q 'release_command = "npx prisma migrate deploy"' fly.toml && \
  grep -q 'auto_stop_machines' fly.toml && \
  grep -q 'min_machines_running = 0' fly.toml && \
  echo "PASS" || echo "FAIL — fly.toml missing release_command or auto-stop config"
```

### 1.5 `package.json` has `docker-start` + `setup` scripts

```bash
node -e '
  const p = require("./package.json").scripts;
  const ok = p["docker-start"] && p["setup"] && p["start"];
  console.log(ok ? "PASS" : "FAIL — missing docker-start/setup/start scripts in package.json");
'
```

---

## ✅ Gate 2 — Fly app provisioned

### 2.1 Fly app exists

```bash
flyctl status -a "$FLY_APP" 2>&1 | grep -q "Name" && \
  echo "PASS" || echo "FAIL — run: flyctl launch --no-deploy --copy-config --name $FLY_APP --region sin"
```

### 2.2 All 4 required secrets are set

```bash
flyctl secrets list -a "$FLY_APP" 2>&1 | awk 'NR>1{print $1}' | \
  grep -E "^(SHOPIFY_API_KEY|SHOPIFY_API_SECRET|DATABASE_URL|SHOPIFY_APP_URL)$" | \
  sort -u | wc -l | \
  awk '{ if ($1 == 4) print "PASS"; else printf "FAIL — only %d/4 required secrets set\n", $1 }'
```

**Fix on FAIL:**
```bash
flyctl secrets set \
  SHOPIFY_API_KEY=$CLIENT_ID \
  SHOPIFY_API_SECRET=<shpss_...> \
  DATABASE_URL="postgresql://...?sslmode=require" \
  SHOPIFY_APP_URL="$FLY_URL" \
  -a "$FLY_APP"
```

### 2.3 🔑 `SHOPIFY_API_KEY` length is exactly 32 chars

This is the #1 cause of deployed-but-broken auth. Check **every time** after setting secrets.

```bash
flyctl ssh console -a "$FLY_APP" -C \
  'node -e "const k=process.env.SHOPIFY_API_KEY; console.log(k.length === 32 ? \"PASS\" : \"FAIL length=\" + k.length + \" (expected 32)\")"' \
  2>&1 | tail -1
```

**Fix on FAIL:** re-set WITHOUT quotes, WITHOUT pasting from a source that might append whitespace:
```bash
flyctl secrets set SHOPIFY_API_KEY=$CLIENT_ID -a "$FLY_APP"
```
Then re-run 2.3.

### 2.4 `SHOPIFY_API_KEY` matches Client ID

```bash
flyctl ssh console -a "$FLY_APP" -C \
  "node -e \"console.log(process.env.SHOPIFY_API_KEY === '$CLIENT_ID' ? 'PASS' : 'FAIL — mismatch: ' + JSON.stringify(process.env.SHOPIFY_API_KEY))\"" \
  2>&1 | tail -1
```

### 2.5 `DATABASE_URL` has `sslmode=require`

```bash
flyctl ssh console -a "$FLY_APP" -C \
  'node -e "console.log(/sslmode=require/.test(process.env.DATABASE_URL || \"\") ? \"PASS\" : \"FAIL — DATABASE_URL missing sslmode=require\")"' \
  2>&1 | tail -1
```

### 2.6 `SHOPIFY_APP_URL` equals the Fly hostname

```bash
flyctl ssh console -a "$FLY_APP" -C \
  "node -e \"console.log(process.env.SHOPIFY_APP_URL === '$FLY_URL' ? 'PASS' : 'FAIL — got ' + process.env.SHOPIFY_APP_URL + ' expected $FLY_URL')\"" \
  2>&1 | tail -1
```

---

## ✅ Gate 3 — Deployed + serving HTTP

### 3.1 Deploy succeeded

```bash
flyctl deploy -a "$FLY_APP" 2>&1 | tail -3 | grep -q "deployed\|DNS configuration verified" && \
  echo "PASS" || echo "FAIL — check flyctl logs -a $FLY_APP for build/release errors"
```

### 3.2 Root URL returns 2xx (bypass local DNS cache)

```bash
DNS_IP=$(dig @8.8.8.8 +short "${FLY_APP}.fly.dev" | head -1)
[ -z "$DNS_IP" ] && echo "FAIL — Fly domain not in public DNS yet, retry in 30s" || \
  curl -s -o /dev/null --resolve "${FLY_APP}.fly.dev:443:$DNS_IP" \
    -w "%{http_code}\n" "$FLY_URL/" | \
  awk '{ if ($1 ~ /^2/) print "PASS"; else printf "FAIL — HTTP %s\n", $1 }'
```

### 3.3 `/app` returns embedded-auth response (410 expected without id_token)

```bash
DNS_IP=$(dig @8.8.8.8 +short "${FLY_APP}.fly.dev" | head -1)
curl -s -o /dev/null --resolve "${FLY_APP}.fly.dev:443:$DNS_IP" \
  -w "%{http_code}\n" "$FLY_URL/app" | \
awk '{ if ($1 == "410" || $1 == "302") print "PASS"; else printf "FAIL — got HTTP %s (expected 410/302)\n", $1 }'
```

### 3.4 Prisma migrations applied to Neon

```bash
flyctl ssh console -a "$FLY_APP" -C "npx prisma migrate status" 2>&1 | \
  grep -q "Database schema is up to date" && \
  echo "PASS" || echo "FAIL — migrations not applied; check flyctl logs for release_command errors"
```

### 3.5 Shopify API module loaded on boot (startup healthy)

```bash
flyctl logs -a "$FLY_APP" --no-tail 2>&1 | tail -200 | \
  grep -q "shopify-api/INFO.*React Router" && \
  echo "PASS" || echo "FAIL — Shopify library never initialized; check Node startup errors"
```

---

## ✅ Gate 4 — Shopify app config pushed

### 4.1 `shopify.app.toml` has the Fly URL

```bash
grep -q "application_url = \"$FLY_URL\"" shopify.app.toml && \
  echo "PASS" || echo "FAIL — edit shopify.app.toml, set application_url = \"$FLY_URL\""
```

### 4.2 `automatically_update_urls_on_dev = false`

Prevents `shopify app dev` from clobbering prod URLs the next time you run it locally.

```bash
grep -q "automatically_update_urls_on_dev = false" shopify.app.toml && \
  echo "PASS" || echo "FAIL — add automatically_update_urls_on_dev = false under [build] in shopify.app.toml"
```

### 4.3 Redirect URLs match Fly host

```bash
grep -qE "redirect_urls\s*=\s*\[" shopify.app.toml && \
  grep -q "$FLY_URL/auth/callback" shopify.app.toml && \
  echo "PASS" || echo "FAIL — update [auth] redirect_urls to include $FLY_URL/auth/callback and /api/auth/callback"
```

### 4.4 App config + function deployed to Shopify

```bash
shopify app deploy --force 2>&1 | tail -5 | grep -q "New version released" && \
  echo "PASS" || echo "FAIL — shopify app deploy failed; check CLI output"
```

---

## ✅ Gate 5 — OAuth install succeeded (post-install check)

Run these **after** you've clicked "Install" in Dev Dashboard and approved OAuth in your browser.

### 5.1 Session row created in Neon

```bash
flyctl ssh console -a "$FLY_APP" -C \
  'node -e "const{PrismaClient}=require(\"@prisma/client\"); new PrismaClient().session.count().then(c=>{console.log(c > 0 ? \"PASS count=\" + c : \"FAIL — no sessions; OAuth never completed\"); process.exit(0)})"' \
  2>&1 | tail -1
```

**Fix on FAIL:** open admin → app page → watch `flyctl logs -a "$FLY_APP"` for `Session token had invalid API key` → if you see it, you hit the whitespace bug (re-do 2.3).

### 5.2 Session has access token + matches target shop

```bash
flyctl ssh console -a "$FLY_APP" -C \
  "node -e \"const{PrismaClient}=require('@prisma/client'); new PrismaClient().session.findFirst({where:{shop:'$SHOP_DOMAIN'}}).then(s=>{console.log(s && s.accessToken ? 'PASS' : 'FAIL — session missing access token'); process.exit(0)})\"" \
  2>&1 | tail -1
```

### 5.3 Admin iframe renders 200 (not blank)

Requires a fresh `id_token` from a real admin load, so we verify via logs:

```bash
flyctl logs -a "$FLY_APP" --no-tail 2>&1 | tail -60 | \
  grep -E "GET /app[?\s].*\s200\s" > /dev/null && \
  echo "PASS" || echo "FAIL — no 200 responses on /app; iframe stuck in redirect loop (see Troubleshooting #1)"
```

### 5.4 No `Session token had invalid API key` errors in recent logs

```bash
flyctl logs -a "$FLY_APP" --no-tail 2>&1 | tail -200 | \
  grep -q "Session token had invalid API key" && \
  echo "FAIL — whitespace-in-API-key bug active; re-do 2.3" || echo "PASS"
```

---

## 🔄 One-shot validation script

The full script lives at [`scripts/validate-deploy.sh`](./scripts/validate-deploy.sh) in this repo. It covers all 19 gates (G1.1 → G5.4), auto-warms the Fly machine if it's auto-stopped, and halts on the first failure with a remediation hint.

Usage:

```bash
export FLY_APP="<your-fly-app-name>"
export CLIENT_ID="<32-char-shopify-client-id>"
export SHOP_DOMAIN="<shop-handle>.myshopify.com"
./scripts/validate-deploy.sh
```

Example run against a healthy deploy:

```
▸  Validating deploy of combined-discount-shopify for shop prkdg7-jt.myshopify.com

▸  Gate 1 — Local repo state
✅ G1.1 Prisma configured for Postgres
✅ G1.2 Dockerfile has openssl + prisma generate
✅ G1.3 .env* blocked from image
✅ G1.4 fly.toml release + auto-stop configured
✅ G1.5 package.json scripts present

▸  Gate 2 — Fly app + secrets
✅ G2.1 Fly app exists
✅ G2.2 All 4 required secrets set
✅ G2.3 SHOPIFY_API_KEY length = 32
✅ G2.4 API key matches Client ID
✅ G2.5 DATABASE_URL has sslmode=require
✅ G2.6 SHOPIFY_APP_URL matches Fly host

▸  Gate 3 — Deployed + serving HTTP
✅ G3.2 Root URL HTTP 200
✅ G3.3 /app embedded-auth response (410)
✅ G3.4 Migrations applied to Neon
✅ G3.5 Shopify library initialized

▸  Gate 4 — Shopify app config
✅ G4.1 application_url matches Fly
✅ G4.2 dev URL overwrite disabled
✅ G4.3 redirect_urls point to Fly

▸  Gate 5 — Post-install state (run after OAuth install in Dev Dashboard)
✅ G5.1 Neon sessions: 1
✅ G5.2 Session for <shop>.myshopify.com has access token
✅ G5.3 /app returned 200 recently
✅ G5.4 No invalid-API-key errors in recent logs

🎉 All 19 gates PASS — <fly-app> is live, authenticated, and correctly wired.
```

**On first FAIL the script exits.** Fix the specific gate (every remediation is in the preceding per-gate sections), re-run, repeat until all 19 green.

---

## 🔁 The fix-and-retry loop

For any FAIL, the loop is always the same — no guessing:

```
┌────────────────┐
│  Run gate      │
│  1 → 2 → 3 →   │
│  4 → 5         │
└───────┬────────┘
        │
    ┌───┴───┐
    │ PASS  │────► next gate
    └───────┘
    ┌───────┐
    │ FAIL  │────► read remediation for that exact gate ID
    └───┬───┘         │
        │             ▼
        │      apply fix (one thing only — don't shotgun)
        │             │
        │             ▼
        └────── re-run SAME gate
                      │
               ┌──────┴──────┐
               │ PASS → next │
               │ FAIL → read │
               │  logs or    │
               │  escalate   │
               └─────────────┘
```

Gate IDs are stable (`G2.3`, `G5.1`, etc.) so when you get stuck, you can search this doc or git commit history for that ID and see how you solved it before. This is the muscle memory you build by doing this loop — every future deploy should need fewer cycles.

---

## 🧪 Regression test matrix

Run these on **any** re-deploy or config change, not just the first install:

| Change | Minimum gates to re-run |
|---|---|
| Edit any code in `app/` | G3.1 → G3.5 |
| Edit `shopify.app.toml` | G4.1 → G4.4 → G5.1 → G5.3 |
| Rotate API secret in Dev Dashboard | G2.2 → G2.3 → G2.4 → G5.1 |
| Move to new Neon DB | G2.5 → G3.4 → G5.1 |
| Rename Fly app | G2.1 → G2.6 → G3.2 → G4.1 → G4.3 → G5.1 |
| Upgrade `@shopify/shopify-app-react-router` | full loop (G1 → G5) |
| After running `shopify app dev` locally | G4.1 → G4.2 → G4.3 (dev mode can overwrite prod URLs if `automatically_update_urls_on_dev ≠ false`) |

If any gate flips from PASS to FAIL after a change, the change is the cause. Revert, re-run, re-apply incrementally.

---

## 📊 Time budget

| Task | First time | With this runbook |
|---|---|---|
| Neon + Prisma setup | 30 min | **5 min** |
| Dockerfile + fly.toml | 20 min (guessing) | **3 min** (copy-paste) |
| Fly launch + secrets | 15 min (auth loop debugging) | **5 min** (G2.3 catches whitespace) |
| Shopify deploy + install | 30 min (blank iframe debugging) | **10 min** (gates catch mismatches early) |
| **Total** | **~95 min of debugging** | **~25 min clean** |

Every gate here exists because we hit the failure mode once. Trust the loop — don't skip gates because "this time feels different."
