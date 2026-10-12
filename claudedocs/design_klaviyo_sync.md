# Design: Real-time Klaviyo sync of discount usage

`/sc:design --type architecture --format spec` · 2026-10-12 · status: approved by user ("langsung live setelah QA 100%")

## 1. Goal

Every redemption recorded in the ledger reaches Klaviyo within seconds, as:

1. **Profile properties** per discount — `<CODE> Uses`, `<CODE> Limit`, `<CODE> Uses Left`,
   `<CODE> First Used`, `<CODE> Last Used`, plus `Shopify Customer ID` (same names as the
   2026-10-12 import, so existing segments keep working).
2. **List membership** — the discount's configured Klaviyo list (HARGATETAP → `XZdjZY`).
3. **Event** `Redeemed Combined Discount` — one metric for all discounts, `Code` as a property,
   so a Flow can filter by code/uses-left instead of needing a metric per discount.

Non-goals: consent changes (never subscribe/unsubscribe), names/phones (owned by the native
Shopify↔Klaviyo integration), a settings UI for list mapping (v1 sets it in the DB).

## 2. Constraints that shape the design

| Constraint | Consequence |
|---|---|
| VPS egress is lossy (measured 20–35 % TCP failures on 2026-10-12) | Never call Klaviyo inline from the webhook; durable outbox + retries |
| `orders/create` must stay fast and must not fail because of Klaviyo | Webhook only writes rows in its own DB transaction |
| Blue/green: two slots can run at once for ~10 s | Workers must be safe to run concurrently → row leases with `FOR UPDATE SKIP LOCKED` |
| Webhooks are replayed, reconcile re-runs | Every write idempotent: unique dedupe keys in the outbox, `unique_id` on Klaviyo events |
| Ledger is the source of truth | Profile jobs carry *no data*, only "sync customer X"; the worker reads current state at send time → ordering-insensitive, bursts coalesce |
| Klaviyo limits: profile-import 75/s·750/m, list add 10/s·150/m, events 350/s·3500/m | Batch of ≤ 20 jobs per tick; honour `Retry-After` on 429 |
| No PII in our DB beyond IDs | Email resolved from Shopify at send time, never stored |

## 3. Architecture

```
orders/create ─▶ projectOrder ─┬─ $transaction: ledger upsert
                               │                 + SyncJob(event:<campaign>:<order>)
                               │                 + SyncJob(profile:<customer>)  ← coalesced
                               └─ kick() ─────────┐
reconcile ───────▶ SyncJob(profile:<customer>) ───┤
nightly 02:00 WIB ▶ SyncJob(resync:<date>) ───────┤
                                                  ▼
                       worker (in every app process, 15 s tick + kick)
                       claim ≤20 due rows  (UPDATE … FOR UPDATE SKIP LOCKED, 2-min lease)
                         ├ resolve emails  (Shopify nodes(ids:), one call per batch)
                         ├ profile → POST /api/profile-import  → POST /api/lists/{id}/relationships/profiles
                         ├ event   → POST /api/events  (unique_id = <order>:<campaign>)
                         └ resync  → enqueue profile+event jobs for every ledger row
                       success → done   ·  retryable → backoff  ·  permanent → dead
```

## 4. Data model (migration `20261012000000_klaviyo_sync`, additive only)

```prisma
model DiscountCampaign { … klaviyoListId String? }

model SyncJob {
  id          String    @id @default(cuid())
  shop        String
  kind        String    // klaviyo.profile | klaviyo.event | klaviyo.resync
  dedupeKey   String    // profile:<customerGid> | event:<campaignKey>:<orderGid> | resync:<YYYY-MM-DD>
  customerId  String?
  campaignKey String?
  orderId     String?
  status      String    @default("pending") // pending | done | dead
  version     Int       @default(1)        // bumped on re-enqueue; done only if unchanged
  attempts    Int       @default(0)
  runAt       DateTime  @default(now())
  lockedUntil DateTime?
  lastError   String?
  doneAt      DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  @@unique([shop, dedupeKey])
  @@index([status, runAt])
}
```

**Lost-update guard.** A profile job re-enqueued while a worker holds it bumps `version` and sets
`status=pending, runAt=now`. The worker completes with `WHERE id = ? AND version = <claimed>`; if
that matches nothing, the row stays pending and is sent again with fresh state.

## 5. Behaviour

- **Retry**: delay = `min(30 s · 2^(attempts-1), 1 h)` ± 20 % jitter, or `Retry-After` when given.
  Dead after 15 attempts (~10 h). Retryable = network/timeout, 408, 429, 5xx. Permanent = other
  4xx → dead immediately with the API's error detail.
- **Profile without email** → done, `lastError="no email"` (nothing Klaviyo can key on).
- **Uses for an event** = ledger count with `orderedAt ≤` this order → stable across replays.
- **Uses drop** (cancel via reconcile) → properties rewritten; list membership kept.
- **Nightly resync** also deletes `done` jobs older than 14 days. It is the safety net for
  anything dead or skipped.
- **Kill switch**: no `KLAVIYO_PRIVATE_API_KEY` → nothing enqueued, worker idle.
- **Observability**: one log line per batch; Customer usage page shows pending / dead / last
  success and the latest error.

## 6. Modules

| File | Responsibility |
|---|---|
| `app/lib/klaviyo/client.server.js` | REST transport: pinned revision `2026-07-15`, 10 s timeout, `KlaviyoError{retryable, retryAfterMs}` |
| `app/lib/klaviyo/payloads.js` | Pure builders: property names, profile body, event body (unit-tested) |
| `app/lib/sync/outbox.server.js` | `enqueue*` (transaction-friendly), `claim`, `complete`, `fail`, `stats` |
| `app/lib/sync/backoff.js` | Pure retry policy (unit-tested) |
| `app/lib/sync/klaviyo-sync.server.js` | Job handlers: profile, event, resync |
| `app/lib/sync/worker.server.js` | Process-singleton loop, `kick()`, nightly scheduler |

## 7. QA gate (all must pass before go-live)

1. Unit tests (`node --test`) for payloads + backoff.
2. GraphQL validated against live schema; Polaris validator for the status card; eslint + build.
3. Migration applies cleanly; old release keeps serving during deploy.
4. Production backfill through the real worker: 75 profiles + 75 historical events
   (`time` = original order time; the metric is new, so no Flow can fire). Verify in Klaviyo:
   75 list members, properties equal ledger, 75 events, 0 duplicates after a second resync run.
5. Real-time path: replay one real order through `projectOrder` (idempotent) → job created,
   delivered, event deduplicated by `unique_id`.
6. Fault injection: unreachable Klaviyo → retry with backoff, webhook still 200.
7. `validate-deploy.sh` green.
