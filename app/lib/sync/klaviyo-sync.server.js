import db from "../../db.server";
import { adminGraphql } from "../admin-graphql.server";
import { klaviyoRequest } from "../klaviyo/client.server";
import {
  listMembershipBody,
  profileImportBody,
  redemptionEventBody,
} from "../klaviyo/payloads";
import {
  KIND,
  completeJob,
  enqueueProfileSync,
  failJob,
} from "./outbox.server";

/**
 * Job handlers: turn claimed outbox rows into Klaviyo calls.
 *
 * Each handler reads current state from the ledger at send time and settles
 * every job it was given — done, retry or dead — so one bad customer never
 * holds up the rest of the batch.
 */

const EMAILS_QUERY = `#graphql
  query KlaviyoSyncCustomerEmails($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Customer {
        id
        defaultEmailAddress { emailAddress }
      }
    }
  }`;

const NODES_BATCH = 250;

/** Emails straight from Shopify, so none are stored on our side. */
async function resolveEmails(admin, customerIds) {
  const out = new Map();
  const ids = [...new Set(customerIds)];
  for (let i = 0; i < ids.length; i += NODES_BATCH) {
    const json = await adminGraphql(admin, EMAILS_QUERY, {
      ids: ids.slice(i, i + NODES_BATCH),
    });
    if (json?.errors?.length) {
      const error = new Error(
        `Shopify: ${json.errors.map((e) => e.message).join("; ")}`,
      );
      error.retryable = true;
      throw error;
    }
    for (const n of json?.data?.nodes ?? []) {
      const email = n?.defaultEmailAddress?.emailAddress;
      if (n?.id && email) out.set(n.id, email);
    }
  }
  return out;
}

async function campaignsByKey(shop) {
  const rows = await db.discountCampaign.findMany({ where: { shop } });
  return new Map(rows.map((c) => [c.campaignKey, c]));
}

/** Settles every job in `jobs` with the same failure. */
async function failAll(jobs, error) {
  for (const job of jobs) await failJob(job, error);
}

// --- profiles ------------------------------------------------------------

async function syncProfiles(admin, shop, jobs) {
  const customerIds = jobs.map((j) => j.customerId);
  const [campaigns, grouped, emails] = await Promise.all([
    campaignsByKey(shop),
    db.discountRedemption.groupBy({
      by: ["customerId", "campaignKey"],
      where: { shop, customerId: { in: customerIds } },
      _count: { _all: true },
      _min: { orderedAt: true },
      _max: { orderedAt: true },
    }),
    resolveEmails(admin, customerIds),
  ]);

  const usageByCustomer = new Map();
  for (const g of grouped) {
    const usage = usageByCustomer.get(g.customerId) ?? new Map();
    usage.set(g.campaignKey, {
      uses: g._count._all,
      firstUsedAt: g._min.orderedAt,
      lastUsedAt: g._max.orderedAt,
    });
    usageByCustomer.set(g.customerId, usage);
  }

  const listMembers = new Map(); // listId → [{ job, profileId }]
  const sent = [];

  for (const job of jobs) {
    const email = emails.get(job.customerId);
    if (!email) {
      await completeJob(job, "skipped: customer has no email");
      continue;
    }
    const usage = usageByCustomer.get(job.customerId) ?? new Map();
    const keys = new Set(usage.keys());
    if (job.campaignKey) keys.add(job.campaignKey);

    const entries = [...keys]
      .map((key) => ({
        campaign: campaigns.get(key),
        usage: usage.get(key) ?? { uses: 0 },
      }))
      .filter((e) => e.campaign);

    try {
      const response = await klaviyoRequest(
        "POST",
        "/profile-import",
        profileImportBody({
          email,
          shopifyCustomerId: job.customerId.split("/").pop(),
          campaigns: entries,
        }),
      );
      const profileId = response?.data?.id;
      const lists = entries
        .filter((e) => e.usage.uses > 0 && e.campaign.klaviyoListId)
        .map((e) => e.campaign.klaviyoListId);
      if (profileId && lists.length) {
        for (const listId of new Set(lists)) {
          const members = listMembers.get(listId) ?? [];
          members.push({ job, profileId });
          listMembers.set(listId, members);
        }
      }
      sent.push(job);
    } catch (error) {
      await failJob(job, error);
    }
  }

  // One list call per list per batch: the list endpoint is the tightest
  // rate limit (10/s), and it accepts up to 1000 profiles at once.
  const failed = new Set();
  for (const [listId, members] of listMembers) {
    try {
      await klaviyoRequest(
        "POST",
        `/lists/${encodeURIComponent(listId)}/relationships/profiles`,
        listMembershipBody([...new Set(members.map((m) => m.profileId))]),
      );
    } catch (error) {
      for (const { job } of members) {
        if (failed.has(job.id)) continue;
        failed.add(job.id);
        await failJob(job, error);
      }
    }
  }

  for (const job of sent) {
    if (!failed.has(job.id)) await completeJob(job);
  }
}

// --- events --------------------------------------------------------------

async function sendEvents(admin, shop, jobs) {
  const [campaigns, emails] = await Promise.all([
    campaignsByKey(shop),
    resolveEmails(
      admin,
      jobs.map((j) => j.customerId),
    ),
  ]);

  for (const job of jobs) {
    try {
      const row = await db.discountRedemption.findUnique({
        where: {
          shop_campaignKey_orderId: {
            shop,
            campaignKey: job.campaignKey,
            orderId: job.orderId,
          },
        },
      });
      if (!row) {
        // Reconciled away (cancelled) before we got to it: nothing happened.
        await completeJob(job, "skipped: redemption no longer in ledger");
        continue;
      }
      const campaign = campaigns.get(job.campaignKey);
      const email = emails.get(job.customerId);
      if (!campaign || !email) {
        await completeJob(
          job,
          `skipped: ${campaign ? "customer has no email" : "unknown campaign"}`,
        );
        continue;
      }
      // Counted up to this order, so a replay reports the same number.
      const usesAtOrder = await db.discountRedemption.count({
        where: {
          shop,
          campaignKey: job.campaignKey,
          customerId: job.customerId,
          orderedAt: { lte: row.orderedAt },
        },
      });
      await klaviyoRequest(
        "POST",
        "/events",
        redemptionEventBody({ email, campaign, order: row, usesAtOrder }),
      );
      await completeJob(job);
    } catch (error) {
      await failJob(job, error);
    }
  }
}

// --- full resync -----------------------------------------------------------

const KEEP_DONE_DAYS = 14;

/**
 * Re-queues every customer and every redemption in the ledger. The safety net
 * for anything that died or was skipped; cheap because profile pushes are
 * idempotent and Klaviyo drops events whose unique_id it has already seen.
 */
export async function enqueueFullResync(shop) {
  const ledger = await db.discountRedemption.findMany({
    where: { shop },
    select: { customerId: true, campaignKey: true, orderId: true },
  });

  const customers = [...new Set(ledger.map((r) => r.customerId))];
  for (let i = 0; i < customers.length; i += 100) {
    await db.$transaction(
      customers
        .slice(i, i + 100)
        .map((customerId) => enqueueProfileSync({ shop, customerId })),
    );
  }

  await db.syncJob.createMany({
    data: ledger.map((r) => ({
      shop,
      kind: KIND.event,
      dedupeKey: `event:${r.campaignKey}:${r.orderId}`,
      customerId: r.customerId,
      campaignKey: r.campaignKey,
      orderId: r.orderId,
    })),
    skipDuplicates: true,
  });
  // Give dead events another go; delivered ones stay delivered.
  await db.syncJob.updateMany({
    where: { shop, kind: KIND.event, status: "dead" },
    data: {
      status: "pending",
      attempts: 0,
      runAt: new Date(),
      lockedUntil: null,
    },
  });

  const cutoff = new Date(Date.now() - KEEP_DONE_DAYS * 24 * 60 * 60 * 1000);
  // Event rows are kept: they are the record of what was delivered.
  const pruned = await db.syncJob.deleteMany({
    where: {
      shop,
      kind: { in: [KIND.profile, KIND.resync] },
      status: "done",
      doneAt: { lt: cutoff },
    },
  });

  return {
    customers: customers.length,
    redemptions: ledger.length,
    pruned: pruned.count,
  };
}

// --- dispatch ----------------------------------------------------------------

/** Runs one shop's share of a claimed batch. */
export async function processJobs(admin, shop, jobs) {
  const byKind = Object.groupBy(jobs, (j) => j.kind);
  const settle = async (subset, fn) => {
    if (!subset?.length) return;
    try {
      await fn(subset);
    } catch (error) {
      // Shared lookups (emails, campaigns) failed: the whole subset retries.
      await failAll(subset, error);
    }
  };

  await settle(byKind[KIND.resync], async (list) => {
    for (const job of list) {
      try {
        const result = await enqueueFullResync(shop);
        await completeJob(
          job,
          `queued ${result.customers} profiles, ${result.redemptions} events, pruned ${result.pruned}`,
        );
      } catch (error) {
        await failJob(job, error);
      }
    }
  });
  await settle(byKind[KIND.profile], (list) => syncProfiles(admin, shop, list));
  await settle(byKind[KIND.event], (list) => sendEvents(admin, shop, list));

  const unknown = jobs.filter((j) => !Object.values(KIND).includes(j.kind));
  for (const job of unknown)
    await failJob(job, {
      message: `unknown job kind ${job.kind}`,
      retryable: false,
    });
}
