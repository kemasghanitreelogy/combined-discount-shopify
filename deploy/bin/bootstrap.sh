#!/usr/bin/env bash
# One-time (idempotent) server setup for combined-discount. Runs as root on the
# VPS from a checkout of this repo's deploy/ directory.
#
#   bootstrap.sh host    swap, service user, directories, env file, slot units, deploy command
#   bootstrap.sh tls     certificate + nginx vhost (needs DNS pointing at this box)
set -Eeuo pipefail

readonly APP=combined-discount
readonly DOMAIN=discount.treelogy-services.my.id
readonly BASE=/opt/$APP
readonly ENV_DIR=/etc/$APP
readonly HERE=$(cd "$(dirname "$0")/.." && pwd)   # the deploy/ directory

log() { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root"

host() {
  # 4 GB and no swap: a vite build next to the Treelogy services can OOM-kill
  # one of them. A small swapfile turns that into a slow build instead.
  if ! swapon --show=NAME --noheadings | grep -q .; then
    log "creating 2G swapfile"
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo 'vm.swappiness=10' > /etc/sysctl.d/90-swappiness.conf && sysctl -q -p /etc/sysctl.d/90-swappiness.conf
  fi

  id -u "$APP" >/dev/null 2>&1 ||
    { log "creating user $APP"; useradd --system --home-dir "$BASE" --shell /usr/sbin/nologin "$APP"; }

  install -d -o "$APP" -g "$APP" -m 755 "$BASE" "$BASE/releases"
  install -d -o root -g root -m 755 "$BASE/slots"
  install -d -o root -g "$APP" -m 750 "$ENV_DIR"
  if [[ ! -f $ENV_DIR/env ]]; then
    log "writing $ENV_DIR/env from template — fill in the secrets before the first deploy"
    install -o root -g "$APP" -m 640 "$HERE/env.example" "$ENV_DIR/env"
  fi

  # Root-owned and outside the app's directory: this script runs as root, so
  # the service user must not be able to rewrite it.
  install -o root -g root -m 755 "$HERE/bin/deploy.sh" /usr/local/sbin/$APP-deploy
  install -o root -g root -m 644 "$HERE/systemd/$APP@.service" "/etc/systemd/system/$APP@.service"
  # The single-instance unit predates blue/green slots. Only removed once it no
  # longer serves anything — bootstrap must never take the live app down.
  if [[ -f /etc/systemd/system/$APP.service ]] && ! systemctl is-active --quiet "$APP"; then
    log "removing the pre-blue/green $APP.service"
    systemctl disable --quiet "$APP" 2>/dev/null || true
    rm -f "/etc/systemd/system/$APP.service"
  fi
  systemctl daemon-reload
  log "host ready. next: fill $ENV_DIR/env, then: sudo $APP-deploy"
}

tls() {
  local ip; ip=$(curl -fsS4 --max-time 5 https://api.ipify.org || true)
  [[ $(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}') == "$ip" ]] ||
    die "$DOMAIN does not resolve to this server ($ip) yet; add the A record and retry"

  local site=/etc/nginx/sites-available/$DOMAIN
  if [[ ! -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]]; then
    # The full vhost references the certificate, so it can't load before the
    # certificate exists. Serve the ACME challenge from an HTTP-only stub first.
    log "issuing certificate"
    cat > "$site" <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
EOF
    ln -sfn "$site" /etc/nginx/sites-enabled/$DOMAIN
    nginx -t -q && systemctl reload nginx
    certbot certonly --webroot -w /var/www/html -d "$DOMAIN" \
      --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring
  fi

  # The vhost proxies to `upstream combined_discount`, which the deploy script
  # owns. Seed it on a fresh server so the vhost loads before the first deploy.
  local upstream=/etc/nginx/conf.d/$APP-upstream.conf
  [[ -f $upstream ]] || printf '%s\n' "# Managed by $APP-deploy — the live blue/green slot. Do not edit by hand." \
    'upstream combined_discount {' '    server 127.0.0.1:3200;' '    keepalive 16;' '}' \
    'map $remote_addr $combined_discount_slot {' '    127.0.0.1 $upstream_addr;' '    default   "";' '}' > "$upstream"

  install -o root -g root -m 644 "$HERE/nginx/$DOMAIN.conf" "$site"
  ln -sfn "$site" /etc/nginx/sites-enabled/$DOMAIN
  nginx -t -q || die "nginx -t failed; previous config is still serving"
  systemctl reload nginx

  # certonly does not touch nginx, so renewed certificates only take effect on reload.
  install -d /etc/letsencrypt/renewal-hooks/deploy
  printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  log "https://$DOMAIN is served by nginx"
}

case ${1:-} in
  host) host ;;
  tls)  tls ;;
  *)    sed -n '2,7p' "$0"; exit 1 ;;
esac
