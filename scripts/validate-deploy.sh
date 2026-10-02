#!/usr/bin/env bash
#
# End-to-end production validation for the VPS deployment (see deploy/README.md).
# Runs every gate and reports all failures instead of stopping at the first.
# Nothing here mutates shop data: signed webhooks are sent for a shop that has
# no session, and the authorised admin-API probe is a malformed body that is
# rejected after the secret check but before any Shopify call.
#
#   ./scripts/validate-deploy.sh             # all gates
#   SKIP_RESTART=1 ./scripts/validate-deploy.sh   # skip the kill -9 resilience gate
#
# Needs: the `treelogy-vps` SSH alias with passwordless sudo, curl, openssl, dig.
# Exit code: number of failed gates (0 = all green).
set -uo pipefail
cd "$(dirname "$0")/.."

readonly DOMAIN=discount.treelogy-services.my.id
readonly URL=https://$DOMAIN
readonly VPS_IP=203.145.35.26
readonly CLIENT_ID=fb959e692364c4077d75bd1908f8c38f
readonly FAKE_SHOP=qa-validate-deploy-nonexistent.myshopify.com

PASS=0 FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗ %s\033[0m %s\n' "$1" "${2:-}"; }
gate() { if eval "$2"; then ok "$1"; else bad "$1" "${3:-}"; fi; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }
vps() { ssh -o BatchMode=yes treelogy-vps "$@" 2>/dev/null | grep -v -E 'AUTHORIZED|Terminated|Activity|idcloudhost|___|^ *\||^\s*$'; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
header() { curl -sI --max-time 20 "$URL${2:-/}" | tr -d '\r' | grep -i "^$1:" | head -1 | cut -d' ' -f2-; }

# Secrets are read from the server and kept in memory only — never printed.
env_get() { vps "sudo grep -E '^$1=' /etc/combined-discount/env | cut -d= -f2-"; }
API_SECRET=$(env_get SHOPIFY_API_SECRET)
ADMIN_SECRET=$(env_get ADMIN_API_SECRET)

# ───────────────────────────── G1 repo ─────────────────────────────
section "G1 · Repo configuration"
gate "G1.1 application_url is $URL" \
  "grep -q '^application_url = \"$URL\"' shopify.app.toml"
gate "G1.2 every auth redirect URL is on $DOMAIN" \
  "[ \$(grep -cE '\"https://[^\"]+/(auth|api/auth)' shopify.app.toml) -eq \$(grep -c '\"$URL/' shopify.app.toml) ]"
gate "G1.3 Prisma on Postgres" "grep -q 'provider = \"postgresql\"' prisma/schema.prisma"
gate "G1.4 no fly.dev URL left in app config" "! grep -q 'fly.dev' shopify.app.toml"

# ───────────────────────────── G2 edge ─────────────────────────────
section "G2 · DNS, TLS, edge"
for r in 8.8.8.8 1.1.1.1 dewi.ns.dnscloud.id; do
  gate "G2.1 $DOMAIN → $VPS_IP via $r" "[ \"\$(dig +short $DOMAIN @$r | tail -1)\" = $VPS_IP ]"
done
CERT=$(echo | openssl s_client -connect $DOMAIN:443 -servername $DOMAIN 2>/dev/null | openssl x509 -noout -subject -issuer -enddate -ext subjectAltName 2>/dev/null)
gate "G2.2 certificate covers $DOMAIN" "grep -q 'DNS:$DOMAIN' <<<\"\$CERT\""
gate "G2.3 issued by Let's Encrypt" "grep -qi \"issuer=.*Let's Encrypt\" <<<\"\$CERT\""
gate "G2.4 certificate valid ≥ 14 more days" \
  "echo | openssl s_client -connect $DOMAIN:443 -servername $DOMAIN 2>/dev/null | openssl x509 -noout -checkend 1209600 >/dev/null"
gate "G2.5 TLS 1.3 accepted" "echo | openssl s_client -connect $DOMAIN:443 -servername $DOMAIN -tls1_3 2>/dev/null | grep -q 'TLSv1.3'"
gate "G2.6 TLS 1.1 refused" "! echo | openssl s_client -connect $DOMAIN:443 -servername $DOMAIN -tls1_1 2>/dev/null | grep -q 'Cipher is [A-Z]'"
gate "G2.7 HTTP → HTTPS 301" "[ \"\$(code http://$DOMAIN/x)\" = 301 ] && curl -sI http://$DOMAIN/x | grep -qi '^location: https://$DOMAIN/x'"
gate "G2.8 HSTS header" "[ -n \"\$(header strict-transport-security)\" ]"
gate "G2.9 X-Content-Type-Options nosniff" "[ \"\$(header x-content-type-options)\" = nosniff ]"
gate "G2.10 no X-Frame-Options (embedded app must be frameable)" "[ -z \"\$(header x-frame-options)\" ]"
gate "G2.11 HTTP/2 negotiated" "[ \"\$(curl -s -o /dev/null -w '%{http_version}' --http2 $URL/)\" = 2 ]"
for p in 3200 3201; do
  gate "G2.12 slot port $p unreachable from the internet" "! nc -z -G 5 $VPS_IP $p 2>/dev/null && ! nc -z -w 5 $VPS_IP $p 2>/dev/null"
done
gate "G2.13 /healthz hidden from the internet (404)" "[ \"\$(code $URL/healthz)\" = 404 ]"

# ───────────────────────────── G3 server ─────────────────────────────
section "G3 · Server"
# Blue/green: the live slot is whichever port nginx's upstream names.
LIVE=$(vps "sed -nE 's/^ *server 127\.0\.0\.1:([0-9]+);.*/\1/p' /etc/nginx/conf.d/combined-discount-upstream.conf")
IDLE=$([ "$LIVE" = 3200 ] && echo 3201 || echo 3200)
S=$(vps 'L='"$LIVE"' I='"$IDLE"'; U=combined-discount@$L
  echo "active=$(systemctl is-active $U)"
  echo "idle=$(systemctl is-active combined-discount@$I)"
  echo "idleenabled=$(systemctl is-enabled combined-discount@$I 2>/dev/null)"
  echo "slotrel=$(readlink -f /opt/combined-discount/slots/$L)"
  echo "currentrel=$(readlink -f /opt/combined-discount/current)"
  echo "enabled=$(systemctl is-enabled $U)"
  echo "user=$(systemctl show $U -p User --value)"
  echo "memmax=$(systemctl show $U -p MemoryMax --value)"
  echo "listen=$(sudo ss -tlnH "( sport = :3200 or sport = :3201 )" | awk "{print \$4}" | tr "\n" " ")"
  echo "envperm=$(sudo stat -c "%U:%G:%a" /etc/combined-discount/env)"
  echo "revision=$(cat /opt/combined-discount/current/REVISION)"
  echo "deployable=$(test -f /opt/combined-discount/current/.deployable && echo yes)"
  echo "exposure=$(sudo systemd-analyze security $U --no-pager 2>/dev/null | tail -1 | grep -oE "[0-9]+\.[0-9]+")"
  echo "swap=$(swapon --show=NAME --noheadings | head -1)"
  echo "neighbours=$(systemctl is-active treelogy treelogy-qa-web nginx redis-server certbot.timer | tr "\n" " ")"
  echo "hook=$(test -x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh && echo yes)"
  echo "nginx=$(sudo nginx -t 2>&1 | grep -c successful)"
  echo "errors=$(sudo journalctl -u "combined-discount@*" --since "-15 min" -p err --no-pager -q | grep -c .)"')
v() { sed -n "s/^$1=//p" <<<"$S" | head -1; }
gate "G3.0 nginx routes to a slot (live :$LIVE)"  "[[ '$LIVE' =~ ^320[01]$ ]]"
gate "G3.1 live slot active"                   "[ \"\$(v active)\" = active ]"
gate "G3.1b idle slot stopped and not enabled"  "[ \"\$(v idle)\" != active ] && [ \"\$(v idleenabled)\" != enabled ]"
gate "G3.1c live slot runs the current release" "[ -n \"\$(v slotrel)\" ] && [ \"\$(v slotrel)\" = \"\$(v currentrel)\" ]"
gate "G3.2 live slot enabled at boot"            "[ \"\$(v enabled)\" = enabled ]"
gate "G3.3 runs as unprivileged combined-discount" "[ \"\$(v user)\" = combined-discount ]"
gate "G3.4 memory ceiling set (768M)"          "[ \"\$(v memmax)\" = 805306368 ]"
gate "G3.5 only the live slot listens, on loopback" "[ \"\$(v listen)\" = '127.0.0.1:$LIVE ' ]"
gate "G3.6 env file root:combined-discount 640" "[ \"\$(v envperm)\" = root:combined-discount:640 ]"
ORIGIN_MAIN=$(git ls-remote origin refs/heads/main | cut -f1)
gate "G3.7 live release = origin/main (${ORIGIN_MAIN:0:7})" "[ \"\$(v revision)\" = '$ORIGIN_MAIN' ]"
gate "G3.8 live release marked proven (rollback-eligible)" "[ \"\$(v deployable)\" = yes ]"
EXPOSURE=$(v exposure)
gate "G3.9 systemd exposure score ≤ 3.0 (${EXPOSURE:-n/a})" "[ -n '$EXPOSURE' ] && awk -v e='$EXPOSURE' 'BEGIN{exit !(e <= 3.0)}'"
gate "G3.10 swap enabled"                      "[ -n \"\$(v swap)\" ]"
gate "G3.11 neighbours + certbot timer active" "[ \"\$(v neighbours)\" = 'active active active active active ' ]"
gate "G3.12 cert renewal reloads nginx"        "[ \"\$(v hook)\" = yes ]"
gate "G3.13 nginx config valid"                "[ \"\$(v nginx)\" = 1 ]"
gate "G3.14 no service errors in last 15 min"  "[ \"\$(v errors)\" = 0 ]" "(journalctl -u combined-discount@* -p err)"
for k in SHOPIFY_APP_URL SHOPIFY_API_KEY SHOPIFY_API_SECRET SCOPES DATABASE_URL ADMIN_API_SECRET; do
  gate "G3.15 env $k set" "[ -n \"\$(env_get $k)\" ]"
done
gate "G3.16 SHOPIFY_APP_URL = $URL"    "[ \"\$(env_get SHOPIFY_APP_URL)\" = $URL ]"
gate "G3.17 SHOPIFY_API_KEY = client_id" "[ \"\$(env_get SHOPIFY_API_KEY)\" = $CLIENT_ID ]"
gate "G3.18 SCOPES match shopify.app.toml" \
  "[ \"\$(env_get SCOPES)\" = \"\$(sed -nE 's/^scopes = \"(.*)\"/\1/p' shopify.app.toml)\" ]"
gate "G3.19 DATABASE_URL requires TLS"  "env_get DATABASE_URL | grep -q 'sslmode=require'"

# ───────────────────────────── G4 app ─────────────────────────────
section "G4 · App over HTTPS"
gate "G4.1 / → 200"             "[ \"\$(code $URL/)\" = 200 ]"
gate "G4.2 /auth/login → 200"   "[ \"\$(code $URL/auth/login)\" = 200 ]"
APP_CODE=$(code "$URL/app")
gate "G4.3 /app without session → embedded-auth bounce ($APP_CODE)" "[[ $APP_CODE =~ ^(302|410)$ ]]"
gate "G4.4 unknown path → 404, not 5xx" "[ \"\$(code $URL/qa-no-such-page)\" = 404 ]"
ASSET=$(curl -s --max-time 20 "$URL/auth/login" | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | head -1)
gate "G4.5 hashed asset: exactly one immutable Cache-Control ($ASSET)" \
  "[ -n '$ASSET' ] && [ \"\$(curl -sI $URL$ASSET | grep -ci '^cache-control: public, max-age=31536000, immutable')\" = 1 ]"
gate "G4.6 internal /healthz → 200 ok:true (DB reachable)" \
  "vps 'curl -fsS http://127.0.0.1:$LIVE/healthz' | grep -q '\"ok\":true'"
MIG=$(vps 'cd /opt/combined-discount/current && sudo env $(sudo grep -E "^DATABASE_URL=" /etc/combined-discount/env) runuser -u combined-discount -- env HOME=/opt/combined-discount npx prisma migrate status 2>&1 | grep -c "Database schema is up to date"')
gate "G4.7 Neon schema up to date with release" "[ '$MIG' = 1 ]"

# ───────────────────────────── G5 webhooks ─────────────────────────────
section "G5 · Webhooks (HMAC)"
send_webhook() { # topic path secret → http code
  local body='{"id":1,"current":["read_orders"],"previous":[]}' sig
  sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$3" -binary | base64)
  curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST "$URL$2" \
    -H 'Content-Type: application/json' -H "X-Shopify-Topic: $1" \
    -H "X-Shopify-Shop-Domain: $FAKE_SHOP" -H "X-Shopify-Hmac-Sha256: $sig" \
    -H 'X-Shopify-API-Version: 2026-07' -H "X-Shopify-Webhook-Id: qa-$RANDOM$RANDOM" \
    -H "X-Shopify-Event-Id: qa-$RANDOM$RANDOM" -H "X-Shopify-Triggered-At: $(date -u +%FT%TZ)" \
    --data "$body"
}
for t in orders/create:/webhooks/orders/create app/scopes_update:/webhooks/app/scopes_update app/uninstalled:/webhooks/app/uninstalled; do
  topic=${t%%:*} path=${t#*:}
  gate "G5.1 $topic forged HMAC → 401" "[ \"\$(send_webhook $topic $path wrong-secret)\" = 401 ]"
  gate "G5.2 $topic valid HMAC → 200"  "[ \"\$(send_webhook $topic $path \"\$API_SECRET\")\" = 200 ]"
done

# ───────────────────────────── G6 admin API ─────────────────────────────
section "G6 · Admin API (/api/admin/customers)"
admin() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@" "$URL/api/admin/customers"; }
gate "G6.1 GET → 405"                    "[ \"\$(admin)\" = 405 ]"
gate "G6.2 POST without secret → 401"    "[ \"\$(admin -X POST -d '{}')\" = 401 ]"
gate "G6.3 POST wrong secret → 401"      "[ \"\$(admin -X POST -H 'X-Admin-Secret: nope' -d '{}')\" = 401 ]"
gate "G6.4 POST right secret, bad JSON → 400 (secret accepted)" \
  "[ \"\$(admin -X POST -H \"X-Admin-Secret: \$ADMIN_SECRET\" -H 'Content-Type: application/json' -d 'not-json')\" = 400 ]"

# ───────────────────────────── G7 resilience ─────────────────────────────
if [ -z "${SKIP_RESTART:-}" ]; then
  section "G7 · Resilience"
  R=$(vps 'sudo systemctl kill -s KILL combined-discount@'"$LIVE"'; for i in $(seq 1 30); do sleep 1; curl -fsS http://127.0.0.1:'"$LIVE"'/healthz >/dev/null 2>&1 && { echo $i; break; }; done')
  gate "G7.1 recovers from kill -9 (healthy after ${R:-?}s)" "[ -n '$R' ] && [ '$R' -le 20 ]"
fi

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
exit "$FAIL"
