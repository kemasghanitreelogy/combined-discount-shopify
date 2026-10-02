# VPS deployment

Production runs on `vps-utama` (IDCloudHost, 203.145.35.26, SSH alias `treelogy-vps`)
next to the Treelogy services, at **https://discount.treelogy-services.my.id**.

```
Shopify ──HTTPS──▶ nginx :443 ──▶ 127.0.0.1:3200  combined-discount.service (systemd)
                                         │
                                         └──TLS──▶ Neon Postgres (sessions, app data)
```

| What | Where |
|---|---|
| Live code | `/opt/combined-discount/current` → `releases/<utc-time>-<sha>` |
| Secrets | `/etc/combined-discount/env` (root:combined-discount, 640) — template: `deploy/env.example` |
| Service | `/etc/systemd/system/combined-discount.service` |
| vhost | `/etc/nginx/sites-available/discount.treelogy-services.my.id` |
| Deploy command | `/usr/local/sbin/combined-discount-deploy` (copy of `deploy/bin/deploy.sh`) |
| Logs | `journalctl -u combined-discount -f`, `/var/log/nginx/combined-discount.*.log` |

## Deploy

Push to GitHub, then:

```sh
npm run deploy:vps                 # deploys origin/main
npm run deploy:vps -- <sha|branch> # any ref
```

A deploy builds a fresh release directory, runs `prisma migrate deploy`, swaps the
`current` symlink atomically, restarts, and polls `/healthz` (which queries the DB).
If the health check fails it rolls back to the previous release by itself. Expect
~2 s of restart; Shopify retries webhooks that land in that window.

Migrations run while the old release is still serving, so keep them backward
compatible: add columns/tables first, remove them in a later deploy.

```sh
ssh treelogy-vps sudo combined-discount-deploy status
ssh treelogy-vps sudo combined-discount-deploy rollback
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

1. `bootstrap.sh host` — swap, `combined-discount` system user, directories, env template, unit.
2. Fill `/etc/combined-discount/env`.
3. Point the `discount` A record at the server, then `bootstrap.sh tls` — certificate (certbot webroot, auto-renew with nginx reload) and vhost.
4. `combined-discount-deploy`.
