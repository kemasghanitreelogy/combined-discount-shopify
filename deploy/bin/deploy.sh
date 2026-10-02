#!/usr/bin/env bash
# Atomic release deploy for combined-discount on the VPS. Runs as root on the server.
#
#   deploy.sh [git-ref]     build <git-ref> (default: main) and switch to it
#   deploy.sh rollback      switch back to the previous release
#   deploy.sh status        show the live and available releases
#
# Each release is built in its own directory and only goes live by an atomic
# symlink swap, after migrations ran and before the health check. A release that
# fails its health check is rolled back automatically, so a bad deploy costs a
# few seconds of restart, never a broken site.
set -Eeuo pipefail

readonly APP=combined-discount
readonly BASE=/opt/$APP
readonly REPO_URL=https://github.com/kemasghanitreelogy/combined-discount-shopify.git
readonly MIRROR=$BASE/repo.git
readonly RELEASES=$BASE/releases
readonly CURRENT=$BASE/current
readonly ENV_FILE=/etc/$APP/env
readonly HEALTH_URL=http://127.0.0.1:3200/healthz
readonly KEEP_RELEASES=5

log() { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo $0 $*)"

# One deploy at a time: two builds racing for the same symlink is how you get a
# release nobody built.
exec 9>/run/lock/$APP-deploy.lock
flock -n 9 || die "another deploy is already running"

# Build steps run as the service user so nothing it produces is root-owned.
as_app() { runuser -u "$APP" -- env HOME="$BASE" npm_config_cache="$BASE/.npm" "$@"; }

# prisma reads DATABASE_URL from the environment; load the env file into a
# subshell only, so secrets never land in this script's own environment.
# Parsed literally, the way systemd's EnvironmentFile reads it — sourcing it
# with bash would treat the `&` in a Neon URL as a background operator.
with_env() {
  as_app bash -c '
    q=$'"'"'\x27'"'"'
    while IFS= read -r line; do
      [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
      k=${BASH_REMATCH[1]} v=${BASH_REMATCH[2]}
      if [[ $v == \"*\" || $v == "$q"*"$q" ]]; then v=${v:1:${#v}-2}; fi
      export "$k=$v"
    done < "$0"
    exec "$@"' "$ENV_FILE" "$@"
}

previous_release() {
  local live
  live=$(readlink -f "$CURRENT" 2>/dev/null || true)
  # Newest release that built cleanly and isn't the live one; a failed build's
  # leftover directory must never become a rollback target.
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r |
    while read -r r; do
      [[ $RELEASES/$r != "$live" && -f $RELEASES/$r/.deployable ]] && { echo "$RELEASES/$r"; break; }
    done
}

switch_to() {
  ln -sfn "$1" "$CURRENT.next"
  mv -T "$CURRENT.next" "$CURRENT"
  systemctl restart "$APP"
}

healthy() {
  # Neon's free tier suspends idle computes, so the first query can take a few
  # seconds to wake it. 60s covers that with room to spare.
  for _ in $(seq 1 30); do
    curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

cmd_status() {
  echo "live:     $(readlink -f "$CURRENT" 2>/dev/null || echo none)"
  echo "releases:"; ls -1r "$RELEASES" 2>/dev/null | sed 's/^/  /'
  systemctl --no-pager --lines=0 status "$APP" || true
}

cmd_rollback() {
  local target
  target=$(previous_release)
  [[ -n $target ]] || die "no previous release to roll back to"
  log "rolling back to $(basename "$target")"
  switch_to "$target"
  healthy || die "rollback target is unhealthy too; check: journalctl -u $APP -n 100"
  log "rolled back; live: $(basename "$target")"
}

cmd_deploy() {
  local ref=$1 sha rel prev
  [[ -r $ENV_FILE ]] || die "$ENV_FILE missing"

  if [[ ! -d $MIRROR ]]; then
    log "cloning $REPO_URL"
    as_app git clone --mirror --quiet "$REPO_URL" "$MIRROR"
  fi
  log "fetching"
  as_app git --git-dir="$MIRROR" fetch --prune --quiet origin
  sha=$(as_app git --git-dir="$MIRROR" rev-parse --verify "$ref^{commit}") || die "unknown ref: $ref"

  rel=$RELEASES/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:7}
  log "building ${sha:0:7} ($ref) in $(basename "$rel")"
  as_app mkdir -p "$rel"
  as_app bash -c 'git --git-dir="$0" archive "$1" | tar -x -C "$2"' "$MIRROR" "$sha" "$rel"
  echo "$sha" | as_app tee "$rel/REVISION" >/dev/null

  # A failed build leaves its directory behind for inspection but never goes live.
  (
    cd "$rel"
    export NODE_OPTIONS=--max-old-space-size=1536
    as_app npm ci --no-audit --no-fund --loglevel=error
    as_app npx prisma generate
    as_app npm run build
    as_app npm prune --omit=dev --no-audit --no-fund --loglevel=error
  ) || die "build failed; live release untouched ($rel left for inspection)"

  # Migrations run before the switch, against the database the old release is
  # still serving from — so they must stay backward compatible (expand, deploy,
  # then contract in a later release).
  log "applying migrations"
  ( cd "$rel" && with_env npx prisma migrate deploy ) || die "migration failed; live release untouched"
  as_app touch "$rel/.deployable"

  prev=$(readlink -f "$CURRENT" 2>/dev/null || true)
  log "switching live release"
  switch_to "$rel"

  if ! healthy; then
    journalctl -u "$APP" -n 40 --no-pager >&2 || true
    if [[ -n $prev && -d $prev ]]; then
      log "health check failed — rolling back to $(basename "$prev")"
      switch_to "$prev"
      healthy || die "rollback target is unhealthy too; check: journalctl -u $APP -n 100"
      die "deploy of ${sha:0:7} failed health check; rolled back to $(basename "$prev")"
    fi
    die "deploy of ${sha:0:7} failed health check and there is no previous release"
  fi

  # Keep the newest few releases for instant rollback; never the live one.
  local live; live=$(readlink -f "$CURRENT")
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r |
    tail -n +$((KEEP_RELEASES + 1)) |
    while read -r r; do [[ $RELEASES/$r != "$live" ]] && rm -rf -- "${RELEASES:?}/$r"; done

  log "live: $(basename "$rel") (${sha:0:7})"
}

case ${1:-main} in
  rollback) cmd_rollback ;;
  status)   cmd_status ;;
  -h|--help) sed -n '2,6p' "$0" ;;
  *)        cmd_deploy "${1:-main}" ;;
esac
