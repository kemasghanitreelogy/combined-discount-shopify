# VPS deployment

Production runs on `vps-utama` (IDCloudHost, 203.145.35.26, SSH alias `treelogy-vps`)
next to the Treelogy services, at **https://discount.treelogy-services.my.id**.

```
                                  ┌─▶ 127.0.0.1:3200  combined-discount@3200  (blue)
Shopify ──HTTPS──▶ nginx :443 ──┤        one slot live, the other idle
                                  └─▶ 127.0.0.1:3201  combined-discount@3201  (green)
                                              │
                                              └──TLS──▶ Neon Postgres (sessions, app data)
```

| What | Where |
|---|---|
| Live slot | `/etc/nginx/conf.d/combined-discount-upstream.conf` (written by the deploy command) |
| Live code | `/opt/combined-discount/current` → `releases/<utc-time>-<sha>`; each slot runs `slots/<port>` |
| Secrets | `/etc/combined-discount/env` (root:combined-discount, 640) — template: `deploy/env.example` |
| Service | `/etc/systemd/system/combined-discount@.service` (template, instance = port) |
| vhost | `/etc/nginx/sites-available/discount.treelogy-services.my.id` |
| Deploy command | `/usr/local/sbin/combined-discount-deploy` (copy of `deploy/bin/deploy.sh`) |
| Logs | `journalctl -u 'combined-discount@*' -f`, `/var/log/nginx/combined-discount.*.log` |

## Deploy

Push to GitHub, then:

```sh
npm run deploy:vps                 # deploys origin/main
npm run deploy:vps -- <sha|branch> # any ref
```

A deploy is zero-downtime blue/green:

1. build a fresh release directory (each step checked; must produce `build/server/index.js`)
2. `prisma migrate deploy`
3. start the release on the **idle** slot and poll its `/healthz` (which queries the DB)
4. point nginx at that slot with a graceful reload — in-flight requests finish on the old slot
5. verify end to end through nginx + TLS; on failure nginx is switched straight back
6. after a 10 s drain, stop the old slot

A release that fails at any step before 4 never receives traffic. A plain restart
would not do: `react-router-serve` waits for nginx's keep-alive connections on
SIGTERM, which measured as ~6 s of 502s per restart.

Migrations run while the old release is still serving, so keep them backward
compatible: add columns/tables first, remove them in a later deploy.

```sh
ssh treelogy-vps sudo combined-discount-deploy status
ssh treelogy-vps sudo combined-discount-deploy rollback   # previous release, same blue/green path, no rebuild
```

Validate production end to end (DNS, TLS, server, app, webhooks HMAC, admin API,
kill -9 recovery) — mutates no shop data:

```sh
./scripts/validate-deploy.sh
```

Shopify-side config (URLs, webhooks, scopes) and the discount Function are not part
of this deploy — they ship with `npm run deploy` (`shopify app deploy`).

## Changing the deploy tooling itself

The server runs installed copies, not the repo's. After editing anything under
`deploy/`:

```sh
rsync -a --delete deploy/ treelogy-vps:/tmp/cd-deploy/
ssh treelogy-vps sudo /tmp/cd-deploy/bin/bootstrap.sh host   # unit + deploy command
ssh treelogy-vps sudo /tmp/cd-deploy/bin/bootstrap.sh tls    # nginx vhost
```

Both stages are idempotent and never overwrite an existing env file.

## Rebuilding the server from scratch

1. `bootstrap.sh host` — swap, `combined-discount` system user, directories, env template, slot unit.
2. Fill `/etc/combined-discount/env`.
3. Point the `discount` A record at the server (DNS-only, not proxied), then `bootstrap.sh tls` — certificate (certbot webroot, auto-renew with nginx reload), vhost, initial upstream.
4. `combined-discount-deploy`.
