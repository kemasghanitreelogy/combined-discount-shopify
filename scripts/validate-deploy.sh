#!/usr/bin/env bash
#
# End-to-end deploy validation for Shopify app on Fly.io + Neon.
# See DEPLOY_RUNBOOK.md for full context. Every gate ID (G1.1, G2.3, etc.)
# maps to a section in that document.
#
# Usage:
#   export FLY_APP="combined-discount-shopify"
#   export CLIENT_ID="<32-char-client-id>"
#   export SHOP_DOMAIN="<shop>.myshopify.com"
#   ./scripts/validate-deploy.sh
#
# Exit codes:
#   0 — all gates passed
#   1 — a gate failed (stops at first failure)
#   2 — environment setup error (missing required env var)

set -u

: "${FLY_APP:?export FLY_APP first (e.g. combined-discount-shopify)}"
: "${CLIENT_ID:?export CLIENT_ID first (32-char Shopify client ID)}"
: "${SHOP_DOMAIN:?export SHOP_DOMAIN first (e.g. myshop.myshopify.com)}"

FLY_URL="https://${FLY_APP}.fly.dev"

fail() { echo "❌ $1" >&2; exit 1; }
pass() { echo "✅ $1"; }
info() { echo "▸  $1"; }

info "Validating deploy of $FLY_APP for shop $SHOP_DOMAIN"
echo ""

# Auto-warm the machine — auto-stopped VMs reject flyctl ssh.
# Trigger boot via HTTP so subsequent ssh commands succeed.
DNS_IP_WARM=$(dig @8.8.8.8 +short "${FLY_APP}.fly.dev" 2>/dev/null | head -1)
if [ -n "$DNS_IP_WARM" ]; then
  curl -s -o /dev/null --max-time 30 \
    --resolve "${FLY_APP}.fly.dev:443:$DNS_IP_WARM" \
    "${FLY_URL}/" || true
  # Give the VM a beat to bind 0.0.0.0:3000 before ssh-ing in
  sleep 3
fi

# Helper: run node eval via flyctl ssh, strip Connecting… line + whitespace
fly_node() {
  flyctl ssh console -a "$FLY_APP" -C "node -e \"$1\"" 2>/dev/null \
    | grep -v "^Connecting" | tr -d '\r\n ' | tail -c 2048
}

# ---------------------- Gate 1 — Local repo state ----------------------

info "Gate 1 — Local repo state"

grep -q 'provider = "postgresql"' prisma/schema.prisma 2>/dev/null \
  || fail "G1.1 prisma/schema.prisma not provider=postgresql"
grep -q 'provider = "postgresql"' prisma/migrations/migration_lock.toml 2>/dev/null \
  || fail "G1.1 prisma/migrations/migration_lock.toml not postgresql"
pass "G1.1 Prisma configured for Postgres"

grep -q "openssl" Dockerfile 2>/dev/null && grep -q "prisma generate" Dockerfile 2>/dev/null \
  || fail "G1.2 Dockerfile missing openssl or prisma generate"
pass "G1.2 Dockerfile has openssl + prisma generate"

grep -qxE "\.env" .dockerignore 2>/dev/null && grep -qxE "\.env\.\\*" .dockerignore 2>/dev/null \
  || fail "G1.3 .env or .env.* not in .dockerignore (secrets would leak)"
pass "G1.3 .env* blocked from image"

grep -q 'release_command' fly.toml 2>/dev/null && grep -q 'auto_stop_machines' fly.toml 2>/dev/null \
  || fail "G1.4 fly.toml missing release_command or auto_stop_machines"
pass "G1.4 fly.toml release + auto-stop configured"

node -e '
  const p = require("./package.json").scripts || {};
  if (!p["docker-start"] || !p["setup"] || !p["start"]) process.exit(1);
' 2>/dev/null || fail "G1.5 package.json missing docker-start/setup/start scripts"
pass "G1.5 package.json scripts present"

echo ""

# ---------------------- Gate 2 — Fly app + secrets ----------------------

info "Gate 2 — Fly app + secrets"

flyctl status -a "$FLY_APP" &>/dev/null \
  || fail "G2.1 Fly app $FLY_APP does not exist (run: flyctl launch --no-deploy --copy-config --name $FLY_APP --region sin)"
pass "G2.1 Fly app exists"

SECRET_COUNT=$(flyctl secrets list -a "$FLY_APP" 2>/dev/null | awk 'NR>1{print $1}' | \
  grep -cE "^(SHOPIFY_API_KEY|SHOPIFY_API_SECRET|DATABASE_URL|SHOPIFY_APP_URL)$" || true)
[ "$SECRET_COUNT" = "4" ] \
  || fail "G2.2 only $SECRET_COUNT/4 required secrets set (need SHOPIFY_API_KEY, SHOPIFY_API_SECRET, DATABASE_URL, SHOPIFY_APP_URL)"
pass "G2.2 All 4 required secrets set"

API_KEY_LEN=$(fly_node 'process.stdout.write(String((process.env.SHOPIFY_API_KEY||\"\").length))')
[ "$API_KEY_LEN" = "32" ] \
  || fail "G2.3 SHOPIFY_API_KEY length=[$API_KEY_LEN] (expected 32). Whitespace bug — re-set without quotes: flyctl secrets set SHOPIFY_API_KEY=$CLIENT_ID -a $FLY_APP"
pass "G2.3 SHOPIFY_API_KEY length = 32"

API_KEY_MATCH=$(fly_node "process.stdout.write(process.env.SHOPIFY_API_KEY === '$CLIENT_ID' ? 'YES' : 'NO')")
[ "$API_KEY_MATCH" = "YES" ] \
  || fail "G2.4 SHOPIFY_API_KEY on Fly does not equal CLIENT_ID ($CLIENT_ID)"
pass "G2.4 API key matches Client ID"

SSL_OK=$(fly_node 'process.stdout.write(/sslmode=require/.test(process.env.DATABASE_URL||\"\") ? \"YES\" : \"NO\")')
[ "$SSL_OK" = "YES" ] \
  || fail "G2.5 DATABASE_URL missing ?sslmode=require (Neon requires TLS)"
pass "G2.5 DATABASE_URL has sslmode=require"

APP_URL_OK=$(fly_node "process.stdout.write(process.env.SHOPIFY_APP_URL === '$FLY_URL' ? 'YES' : 'NO')")
[ "$APP_URL_OK" = "YES" ] \
  || fail "G2.6 SHOPIFY_APP_URL on Fly != $FLY_URL"
pass "G2.6 SHOPIFY_APP_URL matches Fly host"

echo ""

# ---------------------- Gate 3 — Deployed + serving ----------------------

info "Gate 3 — Deployed + serving HTTP"

DNS_IP=$(dig @8.8.8.8 +short "${FLY_APP}.fly.dev" 2>/dev/null | head -1)
[ -n "$DNS_IP" ] || fail "G3.2 ${FLY_APP}.fly.dev not in public DNS yet (wait 30s and retry)"

# HTTP check with retry — auto-stopped Fly VMs take up to 10s to cold-start.
http_with_retry() {
  local path="$1" attempts=0 code=""
  while [ "$attempts" -lt 5 ]; do
    code=$(curl -s -o /dev/null --max-time 30 \
      --resolve "${FLY_APP}.fly.dev:443:$DNS_IP" \
      -w "%{http_code}" "${FLY_URL}${path}")
    # Anything other than curl's "could not connect" (000) is a real response.
    if [ "$code" != "000" ]; then echo "$code"; return 0; fi
    attempts=$((attempts + 1))
    sleep 5
  done
  echo "$code"
  return 1
}

HTTP_CODE=$(http_with_retry "/")
[[ "$HTTP_CODE" =~ ^2 ]] \
  || fail "G3.2 root URL returned HTTP $HTTP_CODE (expected 2xx; tried 5× with 5s backoff)"
pass "G3.2 Root URL HTTP $HTTP_CODE"

APP_CODE=$(http_with_retry "/app")
[ "$APP_CODE" = "410" ] || [ "$APP_CODE" = "302" ] \
  || fail "G3.3 /app returned $APP_CODE (expected 410 or 302 — embedded-auth signal)"
pass "G3.3 /app embedded-auth response ($APP_CODE)"

flyctl ssh console -a "$FLY_APP" -C "npx prisma migrate status" 2>/dev/null \
  | grep -q "up to date" \
  || fail "G3.4 Prisma migrations not up to date on Neon (check flyctl logs for release_command errors)"
pass "G3.4 Migrations applied to Neon"

flyctl logs -a "$FLY_APP" --no-tail 2>/dev/null | tail -300 \
  | grep -q "shopify-api/INFO" \
  || fail "G3.5 Shopify library never initialized in recent logs (Node startup error?)"
pass "G3.5 Shopify library initialized"

echo ""

# ---------------------- Gate 4 — Shopify app config ----------------------

info "Gate 4 — Shopify app config"

grep -q "application_url = \"$FLY_URL\"" shopify.app.toml \
  || fail "G4.1 shopify.app.toml application_url != $FLY_URL"
pass "G4.1 application_url matches Fly"

grep -q "automatically_update_urls_on_dev = false" shopify.app.toml \
  || fail "G4.2 automatically_update_urls_on_dev must be false (else shopify app dev will overwrite prod URL)"
pass "G4.2 dev URL overwrite disabled"

grep -q "$FLY_URL/auth/callback" shopify.app.toml \
  || fail "G4.3 [auth] redirect_urls must include $FLY_URL/auth/callback"
pass "G4.3 redirect_urls point to Fly"

echo ""

# ---------------------- Gate 5 — Post-install state ----------------------

info "Gate 5 — Post-install state (run after OAuth install in Dev Dashboard)"

SESS_COUNT=$(fly_node 'const{PrismaClient}=require(\"@prisma/client\"); new PrismaClient().session.count().then(c=>{process.stdout.write(String(c)); process.exit(0)})')
if [ -z "$SESS_COUNT" ] || ! [[ "$SESS_COUNT" =~ ^[0-9]+$ ]] || [ "$SESS_COUNT" -lt 1 ]; then
  fail "G5.1 Neon has [$SESS_COUNT] sessions — OAuth never completed. Open admin → Apps → your app → watch flyctl logs for 'Session token had invalid API key'"
fi
pass "G5.1 Neon sessions: $SESS_COUNT"

SESS_HAS_TOKEN=$(fly_node "const{PrismaClient}=require('@prisma/client'); new PrismaClient().session.findFirst({where:{shop:'$SHOP_DOMAIN'}}).then(s=>{process.stdout.write(s && s.accessToken ? 'YES' : 'NO'); process.exit(0)})")
[ "$SESS_HAS_TOKEN" = "YES" ] \
  || fail "G5.2 no session with accessToken for shop=$SHOP_DOMAIN (re-install from Dev Dashboard)"
pass "G5.2 Session for $SHOP_DOMAIN has access token"

flyctl logs -a "$FLY_APP" --no-tail 2>/dev/null | tail -60 \
  | grep -E "GET /app.*200" >/dev/null \
  || fail "G5.3 no 200 response on /app in recent logs — iframe stuck in redirect loop"
pass "G5.3 /app returned 200 recently"

if flyctl logs -a "$FLY_APP" --no-tail 2>/dev/null | tail -500 \
    | grep -q "Session token had invalid API key"; then
  fail "G5.4 'Session token had invalid API key' in logs — whitespace-in-API-key bug active (re-do G2.3)"
fi
pass "G5.4 No invalid-API-key errors in recent logs"

echo ""
echo "🎉 All 19 gates PASS — $FLY_APP is live, authenticated, and correctly wired."
