import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { nextDelayMs, shouldGiveUp } from "./backoff";

/**
 * Durable queue of pushes to external systems, kept in Postgres next to the
 * ledger so a job is written atomically with the fact that caused it.
 *
 * Two app slots can run at once during a blue/green switch; claiming uses
 * `FOR UPDATE SKIP LOCKED` plus a short lease, so each due job goes to exactly
 * one worker, and a worker that dies mid-job loses its lease, not the job.
 */

export const KIND = {
  profile: "klaviyo.profile",
  event: "klaviyo.event",
  resync: "klaviyo.resync",
};

const LEASE = "2 minutes";

// Raw SQL needs the table's schema spelled out: Prisma qualifies its own
// queries from `?schema=` in DATABASE_URL, but $queryRaw runs as written.
function syncJobTable() {
  let schema = "public";
  try {
    schema =
      new URL(process.env.DATABASE_URL).searchParams.get("schema") || "public";
  } catch {
    // keep the default
  }
  return Prisma.raw(`"${schema.replace(/"/g, '""')}"."SyncJob"`);
}

/**
 * "This customer's Klaviyo profile is out of date." Repeated calls coalesce
 * into one row; each one bumps `version`, so a worker already holding the
 * row re-sends with fresh state instead of marking it done.
 *
 * `campaignKey` names a discount whose properties must be written even if the
 * customer now has zero uses of it (a cancelled order) — otherwise the stale
 * count would stay in Klaviyo forever.
 *
 * Returns a Prisma operation so callers can put it in a $transaction.
 */
export function enqueueProfileSync({ shop, customerId, campaignKey = null }) {
  const now = new Date();
  return db.syncJob.upsert({
    where: { shop_dedupeKey: { shop, dedupeKey: `profile:${customerId}` } },
    create: {
      shop,
      kind: KIND.profile,
      dedupeKey: `profile:${customerId}`,
      customerId,
      campaignKey,
      runAt: now,
    },
    update: {
      status: "pending",
      runAt: now,
      attempts: 0,
      lastError: null,
      version: { increment: 1 },
      ...(campaignKey ? { campaignKey } : {}),
    },
  });
}

/** One redemption event. Written once; replays of the same order are no-ops. */
export function enqueueRedemptionEvent({
  shop,
  customerId,
  campaignKey,
  orderId,
}) {
  const dedupeKey = `event:${campaignKey}:${orderId}`;
  return db.syncJob.upsert({
    where: { shop_dedupeKey: { shop, dedupeKey } },
    create: {
      shop,
      kind: KIND.event,
      dedupeKey,
      customerId,
      campaignKey,
      orderId,
    },
    update: {},
  });
}

/** Claims up to `limit` due jobs for this worker. */
export async function claimDueJobs(limit) {
  const table = syncJobTable();
  return db.$queryRaw`
    UPDATE ${table}
       SET "lockedUntil" = (NOW() AT TIME ZONE 'UTC') + ${Prisma.raw(`interval '${LEASE}'`)},
           "attempts" = "attempts" + 1,
           "updatedAt" = (NOW() AT TIME ZONE 'UTC')
     WHERE "id" IN (
       SELECT "id" FROM ${table}
        WHERE "status" = 'pending'
          AND "runAt" <= (NOW() AT TIME ZONE 'UTC')
          AND ("lockedUntil" IS NULL OR "lockedUntil" < (NOW() AT TIME ZONE 'UTC'))
        ORDER BY "runAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING "id", "shop", "kind", "dedupeKey", "customerId", "campaignKey", "orderId", "version", "attempts"`;
}

/** Releases a job whose version moved on while we held it, so it runs again now. */
async function releaseIfSuperseded(job, applied) {
  if (applied.count > 0) return;
  await db.syncJob.updateMany({
    where: { id: job.id, status: "pending" },
    data: { lockedUntil: null },
  });
}

export async function completeJob(job, note = null) {
  const applied = await db.syncJob.updateMany({
    where: { id: job.id, version: job.version, status: "pending" },
    data: {
      status: "done",
      doneAt: new Date(),
      lockedUntil: null,
      lastError: note,
    },
  });
  await releaseIfSuperseded(job, applied);
}

export async function failJob(job, error) {
  const retryable = error?.retryable !== false;
  const giveUp = shouldGiveUp({ attempts: job.attempts, retryable });
  const message = String(error?.message || error).slice(0, 1000);
  const applied = await db.syncJob.updateMany({
    where: { id: job.id, version: job.version, status: "pending" },
    data: giveUp
      ? { status: "dead", lockedUntil: null, lastError: message }
      : {
          runAt: new Date(
            Date.now() + nextDelayMs(job.attempts, error?.retryAfterMs ?? null),
          ),
          lockedUntil: null,
          lastError: message,
        },
  });
  await releaseIfSuperseded(job, applied);
  return giveUp ? "dead" : "retry";
}

/** Queue health for the admin page. */
export async function syncStats(shop) {
  const [grouped, lastDone, lastDead, lastError] = await Promise.all([
    db.syncJob.groupBy({
      by: ["status"],
      where: { shop },
      _count: { _all: true },
    }),
    db.syncJob.findFirst({
      where: { shop, status: "done" },
      orderBy: { doneAt: "desc" },
      select: { doneAt: true },
    }),
    db.syncJob.findFirst({
      where: { shop, status: "dead" },
      orderBy: { updatedAt: "desc" },
      select: { lastError: true, updatedAt: true },
    }),
    db.syncJob.findFirst({
      where: { shop, status: "pending", lastError: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { lastError: true, runAt: true },
    }),
  ]);
  const counts = Object.fromEntries(
    grouped.map((g) => [g.status, g._count._all]),
  );
  return {
    pending: counts.pending ?? 0,
    done: counts.done ?? 0,
    dead: counts.dead ?? 0,
    lastSuccessAt: lastDone?.doneAt ?? null,
    lastDead,
    retrying: lastError,
  };
}
